# QueenOS Rework Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an attempt's head is rejected while its item is open (gate findings, a merge conflict or integration failure in the train, a human reject), the same attempt gets a bounded rework slot to fix and push again as the same candidate. It can bring hive `main` into its clone with a new `sync_base` tool, and judges can send candidates back with a reason (`reject`, dashboard buttons). When a slot runs out, the race falls back and the item reopens to any agent from a fresh base.

**Architecture:** Contracts and migration v19 first (`packages/queen-types`, `apps/queen/src/db.ts`). The slot rules are a pure module (`apps/queen/src/train/rework.ts`, like `pick.ts`). The train planner owns every slot decision: it reads the open attempts' slots (`HiveState.slots`), opens, closes and expires them as trains are rejected, pushed, decided or abandoned, and returns the changed slots (`PlanResult.slots`). The Queen writes them onto `attempts` rows in the same transaction (`syncAttempts`). New race state `REWORKING` (a winner rejected in the train) and candidate outcome `REWORK`. The Queen routes a slot push back into its own race (the existing `rejoin` path of `attemptRegate`), records a synced base (`attemptSyncBase`), and takes human rejects (`rejectRace`, `POST /races/:raceId/reject`). `queenos-mcp` does the Artifacts read of `main` and builds `syncCommand`, because the Queen has no Artifacts binding. The dashboard gets Reject buttons, and the sim gets a scripted conflict-and-rework demo.

**Tech Stack:** pnpm 9 + Turborepo, TypeScript 5.9, zod 4, Hono 4, Cloudflare Workers / Durable Objects (SQLite) / Artifacts, `agents` 0.26.0 (`McpAgent`), React 19 + Vite 8 (dashboard), vitest 4 with `@cloudflare/vitest-pool-workers` 0.22.0.

**Spec:** `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md` (commit 8796be0; the binding authority, read it in full first; § numbers below refer to it). Background: `docs/superpowers/specs/2026-10-12-queenos-mcp-design.md` (attempts, race base, verdict kinds, error contract §11), `.superpowers/sdd/2026-10-12-queenos-mcp/rework-spec-report.md` (the spec author's decisions 1-15), `docs/HANDOFF.md` §1 (work rules).

## Global Constraints

- **Node:** every shell first runs `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`.
- **No Node built-ins in our code** (Cloudflare Workers V8 isolates: never `import ... from "node:*"`, `Buffer`, `process`). The `agents` / `@cloudflare/think` dependency exception stays a dependency exception; do not add a `nodejs_compat` flag.
- **Shared types only from `@queenos/queen-types`.** Contracts first (Task 1). Queen-internal planner shapes (`AttemptSlot`, `ReworkSettings`) live in `apps/queen/src/train/rework.ts`. Anything a second package reads (`AttemptRework`, `reworkReasonText` / `parseReworkReason`, `RejectRaceResult`, `SyncBaseResult`) is in queen-types. After changing queen-types, run `pnpm --filter @queenos/queen-types build`, because consumers import its `dist/`.
- **The Queen is an orchestrator only and has no Artifacts binding** (`apps/queen/wrangler.jsonc`). It decides and records. `queenos-mcp` reads hive `main` and mints tokens (spec §6.1, open check C4 resolved: queenos-mcp reads, the Queen records).
- **Per-package verification** = the package's `test` script AND its `typecheck` script (`tsc --noEmit && tsc --noEmit -p test/tsconfig.json` in `apps/queen`, `apps/mcp`, `apps/edge`; `tsc --noEmit` in `packages/queen-types` and `apps/dashboard`). Example: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`.
- **Full gate** after every task: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`. Every task in the summary must succeed. No package is added, so the task count does not change. **Never raise the concurrency** (workerd suites flake under CPU oversubscription; Queen tests have a 20 s timeout).
- **One task at a time.** Finish a task (its tests, typecheck, full gate, commit), then STOP and report before the next.
- **Commits:** Conventional style (`feat(queen): ...`, `test(queen): ...`, `docs: ...`). The message ends with exactly these trailer lines:
  ```
  Queen-Origin: agent:claude-code
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Token scan before every commit:** `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` must exit **1** (clean). Use `/usr/bin/grep`, because plain `grep` is aliased to ugrep here.
- **Push:** HANDOFF §1 says commit and push `main` after every task; push only when the user confirms it for this run.
- **Never stage** `.claude/ .gemini/ .github/ .mcp.json .opencode/ .vscode/` (untracked local tooling). Stage files by path, never `git add -A` / `git add .`.
- **Credentials:** never print, log, echo or commit an Artifacts token (`art_v1_...`) or a `qgt_` token. Agents never mint tokens and never run a command that would bring one into their context. The probe in Task 0 is written by an agent and **run by the user**, and it prints pass/fail facts only.
- **Production deploys are the user's.** Task 12 lists the commands; agents do not run `wrangler deploy`.
- **No new dependencies.** No task touches `package.json` dependencies or `pnpm-lock.yaml`.
- **Spec values (copy exactly):** `reworkWindowMs` default 1 800 000, bounds 60 000 .. 7 200 000; `reworkHoldMs` default 600 000, bounds 60 000 .. 3 600 000; `maxReworksPerAttempt` default 3, bounds 0 .. 5; `maxRaceReopens` default 3, bounds 0 .. 5; slot extends `expires_at` to at least `dueAt + 10 min`; `sync_base` read token TTL 1800 s; reject reason 1..300 chars; at most 16 `races.rejections`; MCP tool count 19.

## Review Focus

1. **A slot fix's push event arrives around `dueAt`** (events are at-least-once and unordered, and the alarm may run late). A push the Queen sees before `dueAt` rejoins as the same candidate, and the slot expiry that fires during its gate leaves it alone. A push the Queen sees after `dueAt` is a late push through normal intake, never the old slot's candidate, even when the alarm has not closed the slot yet. Owner: Task 6, tests "a push after dueAt is a late push even before the alarm ran" and "a slot fix pushed before dueAt survives the expiry alarm".
2. **The same slot push delivered twice.** Expected: one train, one closed slot, a `duplicate` answer, no second slot used. Owner: Task 6, test "a replayed slot push is a duplicate".
3. **The agent ends its attempt while its rebased head is mid-gate in a REWORKING race.** Expected: the fallback runs exactly once (race ABANDONED, item FAILED awaiting contributor), the base is deleted exactly once, and a second `end_attempt` is a no-op. Owner: Task 6, test "end_attempt while the fix is gated in a REWORKING race falls back once".
4. **A judge acts on a stale view** (the race already went back to RACING after a reject, or another judge picked). Expected: 409 with the race's current state, nothing changes; the dashboard refreshes. Owner: Task 4, test "a second reject or a pick of the rejected candidate after a reject is refused"; Task 9, test "a 409 on reject asks for a refresh".
5. **`sync_base` called again** (a rerun after "main moved", or a second rebase). Expected: the command is safe to re-run (`remote remove || true`, `--replace-all`), each call mints one fresh read token, and it never revokes a token it did not mint (the hive repo has other tokens). Owner: Task 8, test "a second sync_base rotates the header and revokes nothing it did not mint".

## Plan rulings (spec ambiguities resolved)

- **R1 Slot bookkeeping in the planner.** The train planner reads `AttemptSlot {attemptId, reworks, rework}` for open attempts (`HiveState.slots`), changes them, and returns changed slots (`PlanResult.slots`). The Queen applies them to `attempts` rows in `syncAttempts`, in the same transaction. The planner stays pure.
- **R2 `graceStart`** = `race.deadlineAt - raceGraceMs`. `trainResult` sets `deadlineAt = max(now, entryClosesAt) + grace` at the first pass, and `closeEntries` sets `min(deadlineAt, now + grace)`, so this is exactly "the first pass, or entry close if later".
- **R3 The slot-closing push is not cut off by an old grace clock.** When a slot's fix rejoins a RACING race that has a grace deadline, `deadlineAt := max(deadlineAt, the slot's hold end)`. Without this, the fix (a RACING candidate) would lose at once to a grace deadline that started before it existed. The spec's review focus §12 implies this.
- **R4 "Second push in the slot"** = the attempt has `reworks > 0` and its current train is an active, unboarded `RACING` candidate of its RACING / REWORKING race. Such a push rejoins that race and supersedes the pending fix in place (no follow-up, no second slot). Any other push follows today's intake.
- **R5 Reject one** (PICKING → RACING) sets `deadlineAt = now + raceGraceMs` and clears `pickDeadlineAt`, `recommendedTrainId` and `recommendReason` (`enterPicking` sets fresh ones). **Reject all** also clears `deadlineAt` and reopens entries (`entryClosesAt = now + reworkWindowMs`). Report decision 10.
- **R6 Fresh base "for fallback only".** While the item's newest race is ABANDONED and no race of the item is RACING / PICKING / REWORKING, a REJECTED attempt with no open slot does not hold the base. Every other non-terminal attempt still holds it, and outside that case today's rule is unchanged.
- **R7 Infra on a REWORKING fix.** An infra-stopped rebased head takes no slot (§4). The fix train ends FAILED (kind `infra`) and the race stays REWORKING. `retry_gates` rejoins a REWORKING race. The attempt's expiry or `end_attempt` runs the fallback (`attemptEnded`), so the race cannot stick.
- **R8 Winner rejected in the train with no slot left** → fallback at once: the race goes DECIDED → ABANDONED, the train FAILED, the item FAILED "awaiting contributor". This is a transition the §5.7 table does not list, added because §5.5 says "where it was the race's last hope ... the fallback runs".
- **R9 The due time travels in the REWORK train's `reason`**: `in rework (<reason>) until <ISO>: <why>` (`reworkReasonText` / `parseReworkReason` in queen-types). The dashboard and the notes read it without a new column. The `attempts` row stays the authority for the slot.
- **R10 Verdict kind `human`** is read from the open slot's reason, else from the train's reason format, so it survives the slot closing.
- **R11 T9b "reason recorded as a REVIEWER finding"** (swarm hives) is recorded in `races.rejections` and the `race.rejected` event. The planner has no audit path, so no `drone.audit` row is written.
- **R12 `get_verdict.next` back-compat.** An older Queen (the view has no `rework` key) keeps today's strings. A newer Queen with `rework: null` and a non-infra rejection answers `next: null` (cap reached or slot expired).
- **R13 DECIDED races of active WON attempt trains are loaded into every decision** (`withExtras`). This lets a car conflict move them to REWORKING. Today only RACING / PICKING races are warm.
- **R14 Sim scenario.** The sim has no MCP server or Artifacts. The demo is a sim-only driver (`POST /sim/rework-demo?hive=<h>` on the localhost-only sim worker) that plays two agents through the Queen's attempt RPCs, plus a `[conflict-once]` MERGE marker that makes the second winner conflict once.
- **R15 Probe C2** checks that a force push is accepted and that the fork's head moves. It reads before/after from the gatekeeper's Workflow instance, which the user inspects. The probe uses a repo name outside the attempt pattern, so the live Queen is never called.
- **R16 `sync_base` revokes only its own token**, and only on a refusal or a failure after minting. Earlier read tokens of the same attempt expire on their own (30 min).
- **R17 MCP `reject` resolves** the item's newest PICKING race. A `target` attempt that is not one of its candidates is `CONFLICT`.
- **R18 Reject one past `maxRaceReopens`**, or a candidate past `maxReworksPerAttempt`: the candidate is LOST and the race stays PICKING (`maybeDecidePicking`: one pass left → `queen:single`). No reopen is used.
- **R19 Attempt-train note bodies** change for findings and human rejects too ("Fix it and push again before <ISO>."), not only for conflicts (§6.2 bullet 5). Human git-proxy and swarm trains keep today's text.
- **R20** A REWORK candidate that runs out of hold at a decision is LOST but keeps its rework `reason` text, so `attemptVerdict` still reads its head as `rejected`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `~/queenos-probes/rework/*` (outside the repo) | 0 | Probe Worker and `check.sh` the user runs (C1-C3) |
| `packages/queen-types/src/{attempt,work,state}.ts` (+ tests) | 1 | Slot, race and verdict contracts; guardrails; reason text helpers |
| `apps/queen/src/db.ts` | 1 | Migration v19; attempt `rework` / `reworks`; race `reopens` |
| `apps/queen/src/work/guardrails.ts` | 1 | Clamp the four new guardrails |
| `apps/queen/src/scale/state-cache.ts`, `queen-node.ts` (snapshot query) | 1 | REWORKING races are warm |
| `apps/queen/src/train/rework.ts` (new) | 2, 4 | Pure slot / hold / reject rules |
| `apps/queen/src/train/planner.ts` | 2, 3, 4 | REWORK candidates, holds, expiry, REWORKING, fallback, reject |
| `apps/queen/test/rework-harness.ts` (new), `rework-planner.test.ts` (new) | 2, 3, 4 | Pure planner tests |
| `apps/queen/src/queen-node.ts` | 5, 6, 7 | Slot wiring, alarms, watchdog, refresh, bases, push routing, `attemptSyncBase`, `rejectRace` |
| `apps/queen/src/work/{attempts,ledger,notes}.ts` | 5, 7 | Verdict fix, `awaiting rework` wait reason, note bodies |
| `apps/queen/src/index.ts` | 7 | `POST /hives/:hive/races/:raceId/reject` |
| `apps/queen/test/attempts-rework*.test.ts` (new) | 5, 6, 7 | DO integration tests |
| `apps/mcp/src/{ports,commands,tools}.ts`, `apps/mcp/test/*` | 8 | `sync_base`, `reject`, verdict fields, descriptions |
| `apps/dashboard/src/{api,raceLogic,RacePick,RaceEntries,swarm}.ts(x)` | 9 | Reject / Reject all, REWORK / REWORKING rendering |
| `apps/queen/src/sim/{sim-v2,sim-ports,worker,rework-demo}.ts` | 10 | `[conflict-once]`, the demo driver |
| docs, `templates/worker-starter/AGENTS.md`, `plugins/queenos/skills/queenos-mcp/SKILL.md` | 11 | §8 guidance |
| `docs/HANDOFF.md` | 11, 12 | Milestone entry, deploy and live checklist |

## Task order and gates

| Task | Title | Model tier | Gated on |
|---|---|---|---|
| 0 | Probe script C1-C3 (the user runs it) | Sonnet | none |
| 1 | Contracts, migration v19, guardrails, warm REWORKING races | Sonnet | none |
| 2 | Planner A: REWORK candidate, holds, slot expiry, caps | **Opus** | none |
| 3 | Planner B: slot push, REWORKING, fallback, `attemptEnded` | **Opus** | none |
| 4 | Planner C: human reject (external and swarm) | **Opus** | none |
| 5 | Queen A: slot wiring, alarm deadlines, watchdog, refresh, bases, verdict fix | **Opus** | none |
| 6 | Queen B: push routing, REWORKING end to end, `retry_gates`, `end_attempt` | **Opus** | none |
| 7 | Queen C: `attemptSyncBase`, `rejectRace` RPC and route, notes | Sonnet | C1 for `attemptSyncBase` (rest not gated) |
| 8 | MCP: `sync_base`, `reject`, verdict fields, descriptions | Sonnet | C1 for `sync_base`; C2 for its `next` text |
| 9 | Dashboard: Reject, Reject all, rework rendering | Sonnet | none |
| 10 | Sim: `[conflict-once]` and the rework demo | Sonnet | none |
| 11 | Docs (§8 guidance) | Haiku (Sonnet for the SKILL.md orchestrator section) | C2 for the rebase wording |
| 12 | Deploy commands and live test checklist (the user runs them) | Haiku | Tasks 1-11 |

Every Opus task gets an Opus review before the next task starts. A Sonnet task gets a Sonnet review, plus Opus when it touches race or attempt state.

**Gate outcomes (spec §13):**
- **C1 fails** (the read token can push the hive or read another repo): stop before the `attemptSyncBase` half of Task 7 and the `sync_base` half of Task 8, and re-plan `sync_base` with the user (spec fallback: fetch through a short-lived read-only fork). Everything else proceeds. Without `sync_base`, a conflict slot still works; the agent rebases however it can.
- **C2 fails** (a non-fast-forward push to an attempt fork is refused, or before/after are not old/new): Task 8's `next` text and Task 11's docs say "merge queen/main into your branch, then `git push origin HEAD:main`" instead of rebase plus `--force-with-lease`, and the user re-plans with us. The Queen side is unchanged.
- **C3:** use `repo.log({ref: "main", limit: 1})` (the spec default). Record the latency.

---

### Task 0: Probe script for open checks C1-C3 (the USER runs it)

The agent writes a scratch probe Worker and a shell script outside the repo, then stops and hands them to the user. The agent never runs them, because they mint Artifacts tokens. The script keeps tokens in shell variables and prints only `PASS` / `FAIL` / timing lines and commit shas. **Model: Sonnet.**

**Files:**
- Create (outside the repo): `~/queenos-probes/rework/wrangler.jsonc`, `~/queenos-probes/rework/index.ts`, `~/queenos-probes/rework/check.sh`
- Modify (after the user reports): `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md` (append `### 13.1 Check results` at the end of §13, before `## 14.`)

**Interfaces:**
- Consumes: the Artifacts binding (`create`, `get`, `delete`, repo `fork`, `log`, `info`, `createToken`, `revokeToken`), the live `gatekeeper-workflow` (read-only `wrangler workflows instances list/describe`, run by the user).
- Produces: §13.1 rows C1-C3 with PASS / FAIL and evidence; the gate decisions in "Gate outcomes" above.

- [ ] **Step 1: Write the probe Worker config**

`~/queenos-probes/rework/wrangler.jsonc`:

```jsonc
{
  "name": "qos-rework-probe",
  "main": "index.ts",
  "compatibility_date": "2026-10-02",
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "queenos", "remote": true }]
}
```

- [ ] **Step 2: Write the probe Worker**

`~/queenos-probes/rework/index.ts` (tokens leave the Worker only in `/setup`, `/c1` and `/c2` answers, which `check.sh` reads into variables):

```ts
interface Env { ARTIFACTS: Artifacts }

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const codeOf = (e: unknown) => (e as { code?: string })?.code ?? String((e as Error)?.message ?? e).slice(0, 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fork's `main` head once it is readable (FORK_IN_PROGRESS / NOT_FOUND while it is being created). */
async function ready(env: Env, name: string): Promise<string> {
  const t0 = Date.now();
  for (let d = 250; ; d = Math.min(d * 2, 2000)) {
    try {
      using r = await env.ARTIFACTS.get(name);
      const [h] = await r.log({ ref: "main", limit: 1 });
      if (h) return h.hash;
    } catch (e) {
      const c = codeOf(e);
      if (c !== "FORK_IN_PROGRESS" && c !== "NOT_FOUND" && c !== "INTERNAL_ERROR") throw e;
    }
    if (Date.now() - t0 > 60_000) throw new Error(`not ready: ${name}`);
    await sleep(d);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.searchParams.get("p") ?? "";
    if (!/^rwprobe\d{10}$/.test(p)) return json({ error: "p=rwprobe<unix seconds> required" }, 400);
    // Names outside `<hive>-att-<12hex>` / `<hive>-base-<12hex>`: the live gatekeepers ignore them, the live Queen is never called.
    const hive = `${p}-hive`, other = `${p}-other`, fork = `${p}-fork`;
    try {
      switch (url.pathname) {
        case "/setup": {
          const h = await env.ARTIFACTS.create(hive, { description: "rework probe hive" });
          const o = await env.ARTIFACTS.create(other, { description: "rework probe other repo" });
          return json({ hiveRemote: h.remote, hiveToken: h.token, otherRemote: o.remote, otherToken: o.token });
        }
        case "/c1": {
          using r = await env.ARTIFACTS.get(hive);
          const t = await r.createToken("read", 1800);
          return json({ readToken: t.plaintext, readTokenId: t.id });
        }
        case "/c2": {
          using r = await env.ARTIFACTS.get(hive);
          await r.fork(fork, { defaultBranchOnly: true, description: "rework probe fork" });
          const head = await ready(env, fork);
          using f = await env.ARTIFACTS.get(fork);
          const [info, t] = await Promise.all([f.info(), f.createToken("write", 1800)]);
          return json({ forkRemote: info.remote, forkToken: t.plaintext, head });
        }
        case "/c3": {
          const logMs: number[] = [];
          let sha = "";
          for (let i = 0; i < 5; i++) {
            const t0 = Date.now();
            using r = await env.ARTIFACTS.get(hive);
            const [h] = await r.log({ ref: "main", limit: 1 });
            logMs.push(Date.now() - t0);
            sha = h?.hash ?? "";
          }
          return json({ sha, logMs });
        }
        case "/head": {
          using r = await env.ARTIFACTS.get(url.searchParams.get("repo") === "fork" ? fork : hive);
          const [h] = await r.log({ ref: "main", limit: 1 });
          return json({ head: h?.hash ?? null });
        }
        case "/revoke": {
          using r = await env.ARTIFACTS.get(hive);
          return json({ revoked: await r.revokeToken(url.searchParams.get("id") ?? "") });
        }
        case "/cleanup": {
          const out: Record<string, string> = {};
          for (const n of [hive, other, fork]) {
            try {
              out[n] = String(await env.ARTIFACTS.delete(n));
            } catch (e) {
              out[n] = codeOf(e);
            }
          }
          return json(out);
        }
      }
      return json({ error: "unknown probe" }, 404);
    } catch (e) {
      return json({ error: codeOf(e) }, 500);
    }
  },
};
```

- [ ] **Step 3: Write the check script**

`~/queenos-probes/rework/check.sh` (every token stays in a variable, git output goes to `/dev/null`, and only facts are printed):

```bash
#!/usr/bin/env bash
# Rework-loop open checks C1-C3 (spec §13). Prints PASS/FAIL facts only; never a token.
set -uo pipefail
set +x
export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH
U=http://localhost:8793
P="rwprobe$(date +%s)"
W=$(mktemp -d ~/queenos-probes/rework/work.XXXX)
ok() { echo "PASS $*"; }
no() { echo "FAIL $*"; }
gitq() { git -c user.name=probe -c user.email=probe@kaikeru.com "$@" >/dev/null 2>&1; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$2/info/refs?service=$3"; }
echo "prefix $P"

SETUP=$(curl -sf "$U/setup?p=$P") || { echo "FAIL setup (is wrangler dev running on 8793?)"; exit 1; }
HREMOTE=$(jq -r .hiveRemote <<<"$SETUP"); HTOK=$(jq -r .hiveToken <<<"$SETUP")
OREMOTE=$(jq -r .otherRemote <<<"$SETUP"); OTOK=$(jq -r .otherToken <<<"$SETUP")
unset SETUP
seed() { # seed <name> <remote> <token>: one commit on main
  gitq init -b main "$W/$1" && echo "# $1" > "$W/$1/README.md"
  gitq -C "$W/$1" add README.md && gitq -C "$W/$1" commit -m seed
  if gitq -C "$W/$1" -c http.extraHeader="Authorization: Bearer $3" push "$2" main; then ok "seed $1 main $(git -C "$W/$1" rev-parse HEAD)"; else no "seed $1"; fi
}
seed hive "$HREMOTE" "$HTOK"
seed other "$OREMOTE" "$OTOK"
unset HTOK OTOK

# ── C1: a read token on the hive repo is scoped to that repo, read-only ─────
C1=$(curl -sf "$U/c1?p=$P"); RTOK=$(jq -r .readToken <<<"$C1"); RID=$(jq -r .readTokenId <<<"$C1"); unset C1
if gitq -c http.extraHeader="Authorization: Bearer $RTOK" ls-remote "$HREMOTE" main; then ok "C1a read token reads the hive"; else no "C1a read token cannot read the hive"; fi
if gitq -C "$W/hive" -c http.extraHeader="Authorization: Bearer $RTOK" push "$HREMOTE" HEAD:refs/heads/rwprobe; then no "C1b read token PUSHED to the hive"; else ok "C1b read token cannot push the hive"; fi
if gitq -c http.extraHeader="Authorization: Bearer $RTOK" ls-remote "$OREMOTE" main; then no "C1c read token READ another repo"; else ok "C1c read token cannot read another repo"; fi
echo "C1d receive-pack advert on the hive with the read token: HTTP $(code "$RTOK" "$HREMOTE" git-receive-pack) (expect 401/403)"
echo "C1e upload-pack advert on the other repo with the read token: HTTP $(code "$RTOK" "$OREMOTE" git-upload-pack) (expect 401/403)"
curl -sf "$U/revoke?p=$P&id=$RID" >/dev/null && echo "C1 read token revoked"
unset RTOK RID

# ── C2: a non-fast-forward push to a fork is accepted ───────────────────
C2=$(curl -sf "$U/c2?p=$P"); FREMOTE=$(jq -r .forkRemote <<<"$C2"); FTOK=$(jq -r .forkToken <<<"$C2"); unset C2
gitq init -b main "$W/fork"
gitq -C "$W/fork" config --local --replace-all "http.$FREMOTE.extraHeader" "Authorization: Bearer $FTOK"
unset FTOK
gitq -C "$W/fork" remote add origin "$FREMOTE" && gitq -C "$W/fork" fetch origin main && gitq -C "$W/fork" checkout -b work FETCH_HEAD
echo "one" > "$W/fork/probe.txt" && gitq -C "$W/fork" add probe.txt && gitq -C "$W/fork" commit -m "probe one"
if gitq -C "$W/fork" push origin HEAD:main; then OLD=$(git -C "$W/fork" rev-parse HEAD); ok "C2a first push $OLD"; else no "C2a first push"; OLD=""; fi
echo "two" > "$W/fork/probe.txt" && gitq -C "$W/fork" commit -a --amend -m "probe two (rewritten)"
NEW=$(git -C "$W/fork" rev-parse HEAD)
gitq -C "$W/fork" fetch origin main
if gitq -C "$W/fork" push --force-with-lease=main:"$OLD" origin HEAD:main; then ok "C2b non-fast-forward push accepted ($OLD -> $NEW)"; else no "C2b non-fast-forward push refused"; fi
HEAD_NOW=$(curl -sf "$U/head?p=$P&repo=fork" | jq -r .head)
if [ "$HEAD_NOW" = "$NEW" ]; then ok "C2c fork main is the rewritten head"; else no "C2c fork main is $HEAD_NOW, expected $NEW"; fi
echo "C2d before=$OLD after=$NEW: compare with the gatekeeper instance (step 5)"

# ── C3: reading main's sha with log ────────────────────────────────────
C3=$(curl -sf "$U/c3?p=$P")
echo "C3 log({ref:main,limit:1}) ms: $(jq -c .logMs <<<"$C3") sha $(jq -r .sha <<<"$C3")"
unset C3

curl -sf "$U/cleanup?p=$P" | jq -c . | sed 's/^/cleanup /'
rm -rf "$W"
```

Make it executable: `chmod +x ~/queenos-probes/rework/check.sh`. Check syntax only (this runs nothing): `bash -n ~/queenos-probes/rework/check.sh` must print nothing.

- [ ] **Step 4: Hand off to the user (STOP here)**

Tell the user, verbatim:

> Please run the rework-loop checks (they mint Artifacts tokens, so I must not):
> 1. `cd ~/queenos-probes/rework && ~/repositories/queenos/apps/git/node_modules/.bin/wrangler dev --port 8793` (leave it running).
> 2. In a second shell: `bash ~/queenos-probes/rework/check.sh`
> 3. `cd ~/repositories/queenos/apps/gatekeepers && pnpm exec wrangler workflows instances list gatekeeper-workflow | head -8`, then `pnpm exec wrangler workflows instances describe gatekeeper-workflow <the newest instance id> | head -60`. Look for the `before` / `after` of the `rwprobe...-fork` push.
> 4. Stop `wrangler dev` (Ctrl-C) and paste me the output of steps 2 and 3. It contains no tokens.

- [ ] **Step 5: Record the results (after the user replies)**

Append to the spec, right before `## 14. Future (no code)`:

```markdown
### 13.1 Check results (2026-10-13, run by the user)

| # | Result | Evidence |
|---|---|---|
| C1 | PASS / FAIL | C1a-C1c lines; C1d / C1e HTTP codes |
| C2 | PASS / FAIL | C2a-C2c lines; gatekeeper instance before/after (or "payload not shown: acceptance proven, before/after unverified") |
| C3 | log: min / median / max ms | the C3 line |
```

Fill in the real values. Apply "Gate outcomes" above and say which tasks are gated.

- [ ] **Step 6: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md
git commit -m "$(cat <<'MSG'
docs(spec): rework loop open checks C1-C3 results

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 1: Contracts, migration v19, guardrails, warm REWORKING races

**Model: Sonnet.** Shape and storage only: no behaviour changes yet.

**Files:**
- Modify: `packages/queen-types/src/state.ts:45` (`RaceOutcomeSchema`)
- Modify: `packages/queen-types/src/work.ts` (`GUARDRAIL_FIELDS` ~:192, `GuardrailsSchema`, `GUARDRAIL_DEFAULTS`, `GUARDRAIL_MAX`, `RaceStateSchema` :272, `RaceSchema` :301, after `RejectRaceSchema` :349)
- Modify: `packages/queen-types/src/attempt.ts` (new rework block after `REGATE_MIN_INTERVAL_MS`; `AttemptSchema`; `AttemptVerdictKindSchema`; `AttemptViewSchema`)
- Test: `packages/queen-types/src/attempt.test.ts`, `packages/queen-types/src/index.test.ts:832`
- Modify: `apps/queen/src/db.ts` (append v19 to `MIGRATIONS` after the v18 entry ~:557; `rowToAttempt` / `upsertAttempt` ~:1757-1800; `rowToRace` / `upsertRace` ~:1335-1384)
- Modify: `apps/queen/src/work/guardrails.ts:36-44` (`effectiveGuardrails`)
- Modify: `apps/queen/src/scale/state-cache.ts:36,138,202` (load and apply), `apps/queen/src/queen-node.ts:2400` (`getSnapshot` race query)
- Test: `apps/queen/test/migrations.test.ts`, `apps/queen/test/state-cache.test.ts`

**Interfaces:**
- Produces (queen-types):
  - `RaceOutcomeSchema` = `RACING | PASSED | FAILED | WON | LOST | REWORK`; `RaceStateSchema` = `RACING | PICKING | DECIDED | ABANDONED | REWORKING`; `RaceSchema.reopens?: number`.
  - Guardrails `reworkWindowMs`, `reworkHoldMs`, `maxReworksPerAttempt`, `maxRaceReopens` (defaults and bounds in Global Constraints).
  - `ReworkReasonSchema` (`findings | conflict | human`), `type ReworkReason`; `AttemptReworkSchema {reason, dueAt, round}`, `type AttemptRework`; `REWORK_EXPIRY_GRACE_MS = 600_000`; `SYNC_TOKEN_TTL_S = 1800`.
  - `reworkReasonText(reason: ReworkReason, dueAt: number, why: string): string`; `parseReworkReason(text: string | null | undefined): { reason: ReworkReason; dueAt: number } | null`.
  - `AttemptSchema.rework?: AttemptRework | null`, `AttemptSchema.reworks?: number`.
  - `AttemptVerdictKindSchema` = `findings | infra | conflict | human`.
  - `AttemptViewSchema.train.conflict?: {paths, summary} | null`, `AttemptViewSchema.race.reopens?: number`.
  - `AttemptSyncBaseSchema` (= `AttemptOwnerActionSchema` + `baseSha`), `type AttemptSyncBase`; `SyncBaseResultSchema {baseSha, syncCommand, next}`, `type SyncBaseResult`.
  - `RejectRaceResultSchema {outcome, race, fallback}`, `type RejectRaceResult`.
- Produces (Queen): migration v19; `rowToAttempt` / `upsertAttempt` carry `rework` / `reworks`; `rowToRace` / `upsertRace` carry `reopens`; `effectiveGuardrails` clamps the new keys; the state cache and the snapshot load REWORKING races.

- [ ] **Step 1: Write the failing queen-types tests**

In `packages/queen-types/src/attempt.test.ts`, change the existing kind assertion (line 176) and add a describe block at the end of the file (add `AttemptReworkSchema, AttemptSyncBaseSchema, GuardrailsSchema, GUARDRAIL_DEFAULTS, GUARDRAIL_MAX, RaceOutcomeSchema, RaceSchema, RaceStateSchema, REWORK_EXPIRY_GRACE_MS, RejectRaceResultSchema, SYNC_TOKEN_TTL_S, SyncBaseResultSchema, parseReworkReason, reworkReasonText` to the import list):

```ts
// line 176 becomes:
    expect(AttemptVerdictKindSchema.options).toEqual(["findings", "infra", "conflict", "human"]);
```

```ts
describe("rework loop contracts (rework-loop spec §5, §6, §10)", () => {
  it("race state REWORKING, candidate outcome REWORK, optional reopens", () => {
    expect(RaceStateSchema.options).toContain("REWORKING");
    expect(RaceOutcomeSchema.options).toContain("REWORK");
    const race = { raceId: "r", itemId: "i", width: 1, state: "REWORKING", trainIds: ["t"], winnerTrainId: "t", reason: null, deadlineAt: null, createdAt: 1, decidedAt: 2 };
    expect(RaceSchema.parse(race)).not.toHaveProperty("reopens");
    expect(RaceSchema.parse({ ...race, reopens: 2 }).reopens).toBe(2);
    expect(RaceSchema.safeParse({ ...race, reopens: -1 }).success).toBe(false);
  });

  it("guardrails: defaults on parse, bounds", () => {
    expect(GUARDRAIL_DEFAULTS).toMatchObject({ reworkWindowMs: 1_800_000, reworkHoldMs: 600_000, maxReworksPerAttempt: 3, maxRaceReopens: 3 });
    expect(GUARDRAIL_MAX).toMatchObject({ reworkWindowMs: 7_200_000, reworkHoldMs: 3_600_000, maxReworksPerAttempt: 5, maxRaceReopens: 5 });
    // A payload from an older Queen has none of the four keys: they default on parse.
    const older: Record<string, number> = { ...GUARDRAIL_DEFAULTS };
    for (const k of ["reworkWindowMs", "reworkHoldMs", "maxReworksPerAttempt", "maxRaceReopens"]) delete older[k];
    expect(GuardrailsSchema.parse(older)).toMatchObject({ reworkWindowMs: 1_800_000, reworkHoldMs: 600_000, maxReworksPerAttempt: 3, maxRaceReopens: 3 });
    expect(GuardrailsSchema.safeParse({ ...GUARDRAIL_DEFAULTS, reworkWindowMs: 59_999 }).success).toBe(false);
    expect(GuardrailsSchema.safeParse({ ...GUARDRAIL_DEFAULTS, maxReworksPerAttempt: 0, maxRaceReopens: 0 }).success).toBe(true);
    expect(GuardrailsSchema.safeParse({ ...GUARDRAIL_DEFAULTS, maxRaceReopens: 6 }).success).toBe(false);
  });

  it("an attempt's rework slot, and the reason text that carries its due time", () => {
    expect(REWORK_EXPIRY_GRACE_MS).toBe(600_000);
    expect(SYNC_TOKEN_TTL_S).toBe(1800);
    expect(AttemptReworkSchema.parse({ reason: "conflict", dueAt: 5, round: 1 })).toEqual({ reason: "conflict", dueAt: 5, round: 1 });
    expect(AttemptReworkSchema.safeParse({ reason: "infra", dueAt: 5, round: 1 }).success).toBe(false);
    const due = Date.UTC(2026, 9, 13, 12, 30);
    const text = reworkReasonText("human", due, "rejected by k@kaikeru.com: the button is unreadable");
    expect(text).toBe("in rework (human) until 2026-10-13T12:30:00.000Z: rejected by k@kaikeru.com: the button is unreadable");
    expect(parseReworkReason(text)).toEqual({ reason: "human", dueAt: due });
    expect(parseReworkReason("failed in race: lint")).toBeNull();
    expect(parseReworkReason(null)).toBeNull();
    expect(reworkReasonText("findings", due, "x".repeat(600))).toHaveLength(500);
  });

  it("sync_base and reject payloads", () => {
    const own = { hive: "demo", attemptId: "att_0123456789ab", owner: "ada@example.com", agentId: `ag_${"a".repeat(32)}` };
    expect(AttemptSyncBaseSchema.parse({ ...own, baseSha: "c".repeat(40) }).baseSha).toBe("c".repeat(40));
    expect(AttemptSyncBaseSchema.safeParse({ ...own, baseSha: "main" }).success).toBe(false);
    expect(SyncBaseResultSchema.parse({ baseSha: "c".repeat(40), syncCommand: "git ...", next: "rebase" }).next).toBe("rebase");
    const race = { raceId: "r", itemId: "i", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: 1, decidedAt: null };
    expect(RejectRaceResultSchema.parse({ outcome: "applied", race, fallback: false }).fallback).toBe(false);
  });
});
```

In `packages/queen-types/src/index.test.ts:832`:

```ts
    expect(RaceStateSchema.options).toEqual(["RACING", "PICKING", "DECIDED", "ABANDONED", "REWORKING"]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen-types test`
Expected: FAIL (`AttemptReworkSchema` is not exported; the REWORKING / kind assertions fail).

- [ ] **Step 3: Implement the queen-types changes**

`packages/queen-types/src/state.ts:44-46`:

```ts
/** A race candidate's standing (§2.3.6). REWORK (rework-loop spec §5.2, §5.3): rejected, its attempt holds a rework slot. */
export const RaceOutcomeSchema = z.enum(["RACING", "PASSED", "FAILED", "WON", "LOST", "REWORK"]);
```

`packages/queen-types/src/work.ts`: add to `GUARDRAIL_FIELDS` (after `maxPickingRaces`):

```ts
  /** Rework loop (rework-loop spec §5.5): length of an attempt's rework slot; also the reopened entry window after a reject-all. */
  reworkWindowMs: z.number().int().min(60_000).max(7_200_000),
  /** How long a findings-REWORK candidate holds its race after another candidate passed (from the grace clock's start). */
  reworkHoldMs: z.number().int().min(60_000).max(3_600_000),
  /** Rework slots one attempt may get (findings, conflicts and human rejects share it). 0 = none: the fallback runs at once. */
  maxReworksPerAttempt: z.number().int().min(0).max(5),
  /** PICKING → RACING drops (reject one or all) per race. */
  maxRaceReopens: z.number().int().min(0).max(5),
```

In `GuardrailsSchema`, after `maxPickingRaces: ...default(2),` add:

```ts
  reworkWindowMs: GUARDRAIL_FIELDS.reworkWindowMs.default(1_800_000),
  reworkHoldMs: GUARDRAIL_FIELDS.reworkHoldMs.default(600_000),
  maxReworksPerAttempt: GUARDRAIL_FIELDS.maxReworksPerAttempt.default(3),
  maxRaceReopens: GUARDRAIL_FIELDS.maxRaceReopens.default(3),
```

In `GUARDRAIL_DEFAULTS` add `reworkWindowMs: 1_800_000, reworkHoldMs: 600_000, maxReworksPerAttempt: 3, maxRaceReopens: 3,`; in `GUARDRAIL_MAX` add `reworkWindowMs: 7_200_000, reworkHoldMs: 3_600_000, maxReworksPerAttempt: 5, maxRaceReopens: 5,`.

`RaceStateSchema` (work.ts:272) and its doc comment:

```ts
/**
 * PICKING (§10.2): `judge = human` and ≥ 2 candidates passed; held for a human pick until `pickDeadlineAt`.
 * REWORKING (rework-loop spec §5.3): the winner (an attempt's train) was rejected in the merge train; its attempt has a
 * rework slot and the race waits for its fix. `winnerTrainId` keeps the old train until a new winner exists.
 */
export const RaceStateSchema = z.enum(["RACING", "PICKING", "DECIDED", "ABANDONED", "REWORKING"]);
```

In `RaceSchema`, after `rejections`:

```ts
  /** Rework loop: PICKING → RACING drops so far (reject one or all), capped by `maxRaceReopens`. Absent = 0. */
  reopens: z.number().int().min(0).optional(),
```

After `RejectRaceSchema` (work.ts:349):

```ts
/** The reject route's answer: `fallback` = the reject ended the race (reopens spent) and the item reopened to any agent. */
export const RejectRaceResultSchema = z.object({ outcome: z.string(), race: RaceSchema, fallback: z.boolean() });
export type RejectRaceResult = z.infer<typeof RejectRaceResultSchema>;
```

`packages/queen-types/src/attempt.ts`: after `REGATE_MIN_INTERVAL_MS` add:

```ts
// ── rework loop (docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md) ──

/** Why an attempt got a rework slot: gate findings (or an integration failure in the train), a merge conflict, a human reject. */
export const ReworkReasonSchema = z.enum(["findings", "conflict", "human"]);
export type ReworkReason = z.infer<typeof ReworkReasonSchema>;

/** An open rework slot: fix and push again before `dueAt` (epoch ms), as the same candidate. `round` is 1-based. */
export const AttemptReworkSchema = z.object({ reason: ReworkReasonSchema, dueAt: z.number().int(), round: z.number().int().min(1) });
export type AttemptRework = z.infer<typeof AttemptReworkSchema>;

/** Opening a slot extends `expires_at` to at least `dueAt +` this, so the watchdog never expires an attempt mid-slot (§5.1). */
export const REWORK_EXPIRY_GRACE_MS = 10 * 60_000;
/** `sync_base`: the read token on the hive repo lives this long. */
export const SYNC_TOKEN_TTL_S = 1800;

const REWORK_REASON_RE = /^in rework \((findings|conflict|human)\) until (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z): /;

/**
 * A REWORK train's `reason`: `in rework (<reason>) until <ISO>: <why>` (≤ 500). It carries the slot's due time to the
 * dashboard and the notes; the attempt row stays the authority for the slot itself.
 */
export function reworkReasonText(reason: ReworkReason, dueAt: number, why: string): string {
  const s = `in rework (${reason}) until ${new Date(dueAt).toISOString()}: ${why}`;
  return s.length <= 500 ? s : `${s.slice(0, 499)}…`;
}

/** The slot reason and due time of a REWORK train's `reason`, or null for any other text. */
export function parseReworkReason(text: string | null | undefined): { reason: ReworkReason; dueAt: number } | null {
  const m = text ? REWORK_REASON_RE.exec(text) : null;
  return m ? { reason: m[1] as ReworkReason, dueAt: Date.parse(m[2]!) } : null;
}

/** `attemptSyncBase` (MCP `sync_base`): record hive `main`'s sha (read from Artifacts by queenos-mcp) as the attempt's base. */
export const AttemptSyncBaseSchema = AttemptOwnerActionSchema.extend({ baseSha: Sha40 });
export type AttemptSyncBase = z.infer<typeof AttemptSyncBaseSchema>;

/** `sync_base`'s answer. The read token appears only inside `syncCommand`. */
export const SyncBaseResultSchema = z.object({ baseSha: Sha40, syncCommand: z.string().min(1), next: z.string().min(1) });
export type SyncBaseResult = z.infer<typeof SyncBaseResultSchema>;
```

In `AttemptSchema`, after `lastRegateAt` (and change the `baseSha` doc comment):

```ts
  /** The base the attempt's next push is gated against: the item's base_sha, or hive main recorded by `sync_base` (v19). */
  baseSha: Sha40.nullable(),
```

```ts
  /** v19: slots given so far (findings, conflicts and human rejects share it); absent = 0. */
  reworks: z.number().int().min(0).optional(),
  /** v19: the open rework slot; null / absent = none. */
  rework: AttemptReworkSchema.nullable().optional(),
```

`AttemptVerdictKindSchema` and its comment:

```ts
/**
 * Why a `rejected` verdict: `findings` (the gate judged the change, or it failed integrated in the train: fix and push),
 * `infra` (the gate could not run: `retry_gates`), `conflict` (it conflicted with work that landed: `sync_base`, rebase,
 * push), `human` (a judge rejected it with a reason: address it and push).
 */
export const AttemptVerdictKindSchema = z.enum(["findings", "infra", "conflict", "human"]);
```

In `AttemptViewSchema`, add to the `train` object after `gateInfraRounds`:

```ts
      /** The merge conflict that ejected it from its car (v19 views; absent from an older Queen). */
      conflict: z.object({ paths: z.array(z.string()), summary: z.string() }).nullable().optional(),
```

and change the `race` object to:

```ts
  race: z
    .object({ raceId: z.string(), state: RaceStateSchema, entryClosesAt: z.number().int().nullable(), winnerTrainId: z.string().nullable(), reopens: z.number().int().min(0).optional() })
    .nullable(),
```

- [ ] **Step 4: Build queen-types and run its tests**

Run: `pnpm --filter @queenos/queen-types build && pnpm --filter @queenos/queen-types test && pnpm --filter @queenos/queen-types typecheck`
Expected: PASS.

- [ ] **Step 5: Write the failing Queen storage tests**

In `apps/queen/test/migrations.test.ts`: add a `dropV19` helper and make `dropV18` call it first. Bump the fresh-DO assertions to 19, change the v18 test's `expect(migrate(state.storage)).toBe(18)` to `toBe(SCHEMA_VERSION)`, and add a v19 describe block:

```ts
/** Undo v19 (a test that rebuilds an older version first). */
function dropV19(sql: SqlStorage): void {
  sql.exec(`ALTER TABLE attempts DROP COLUMN rework_reason; ALTER TABLE attempts DROP COLUMN rework_due_at;
    ALTER TABLE attempts DROP COLUMN reworks; ALTER TABLE races DROP COLUMN reopens;
    DELETE FROM _migrations WHERE version = 19;`);
}

/** Undo v18 (a test that rebuilds an older version first). */
function dropV18(sql: SqlStorage): void {
  dropV19(sql);
  sql.exec(`ALTER TABLE merge_trains DROP COLUMN gate_infra_rounds; ALTER TABLE merge_trains DROP COLUMN gate_not_before;
    ALTER TABLE attempts DROP COLUMN regates; ALTER TABLE attempts DROP COLUMN last_regate_at;
    DELETE FROM _migrations WHERE version = 18;`);
}
```

```ts
  it("a fresh DO migrates to v19", async () => {
    expect(SCHEMA_VERSION).toBe(19);
    await runInDurableObject(stubFor(newHive()), (q: QueenNode, state) => {
      expect(version(q.sql)).toBe(19);
      // ... the existing table checks stay as they are
```

```ts
describe("v19: rework loop", () => {
  it("a v18 hive migrates to v19: attempts and races keep their rows (no slot, 0 reopens); the new columns round-trip", async () => {
    const hive = newHive();
    await runInDurableObject(stubFor(hive), (q: QueenNode, state) => {
      const sql = q.sql;
      const att = {
        attemptId: "att_0123456789ab", hive, itemId: "i1", raceId: "r1", trainId: "t1", repo: `${hive}-att-0123456789ab`, baseSha: "b".repeat(40),
        agentId: `ag_${"a".repeat(32)}`, agentName: "opus", model: "claude-opus-5-5", role: "worker" as const, owner: "kyle@example.com",
        state: "REJECTED" as const, headSha: "c".repeat(40), createdAt: 1, expiresAt: 2,
      };
      const race = { raceId: "r1", itemId: "i1", width: 1, state: "RACING" as const, trainIds: ["t1"], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: 1, decidedAt: null };
      dropV19(sql);
      expect(version(sql)).toBe(18);
      upsertAttemptV18(sql, att);
      sql.exec("INSERT INTO races (race_id, item_id, width, state, train_ids, created_at) VALUES ('r1', 'i1', 1, 'RACING', '[\"t1\"]', 1)");
      expect(migrate(state.storage)).toBe(SCHEMA_VERSION);
      for (const c of ["rework_reason", "rework_due_at", "reworks"]) expect(columns(sql, "attempts").has(c), c).toBe(true);
      expect(columns(sql, "races").has("reopens")).toBe(true);
      expect(getAttemptRow(sql, att.attemptId)).toEqual(att);
      expect(rowToRace(sql.exec("SELECT * FROM races WHERE race_id = 'r1'").one())).toEqual(race);

      upsertAttempt(sql, { ...att, reworks: 2, rework: { reason: "conflict", dueAt: 99, round: 2 } });
      expect(getAttemptRow(sql, att.attemptId)).toEqual({ ...att, reworks: 2, rework: { reason: "conflict", dueAt: 99, round: 2 } });
      upsertAttempt(sql, { ...att, reworks: 2, rework: null });
      expect(getAttemptRow(sql, att.attemptId)).toEqual({ ...att, reworks: 2 });
      upsertRace(sql, { ...race, state: "REWORKING", reopens: 1 });
      expect(rowToRace(sql.exec("SELECT * FROM races WHERE race_id = 'r1'").one())).toEqual({ ...race, state: "REWORKING", reopens: 1 });
    });
  });
});

/** An attempt row as v18 wrote it (no v19 columns exist yet). */
function upsertAttemptV18(sql: SqlStorage, a: Attempt): void {
  sql.exec(
    `INSERT INTO attempts (attempt_id, hive, item_id, race_id, train_id, repo, base_sha, agent_id, agent_name, model, role, owner, state, head_sha, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.attemptId, a.hive, a.itemId, a.raceId, a.trainId, a.repo, a.baseSha, a.agentId, a.agentName, a.model, a.role, a.owner, a.state, a.headSha, a.createdAt, a.expiresAt,
  );
}
```

Add `upsertRace`, `rowToRace`, `upsertAttempt`, `getAttemptRow` to the `../src/db` import if missing, and `type Attempt` from `@queenos/queen-types`.

In `apps/queen/test/state-cache.test.ts`, add after the "is cold until loaded ..." test:

```ts
  it("keeps REWORKING races warm (rework loop), on load and on apply; DECIDED and ABANDONED ones are evicted", async () => {
    await runInDurableObject(stubFor(newHive()), (q: QueenNode) => {
      const sql = q.sql;
      const race = (id: string, state: RaceRecord["state"]): RaceRecord => ({ raceId: id, itemId: "i1", width: 1, state, trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: 1, decidedAt: null });
      upsertRace(sql, race("r1", "REWORKING"));
      upsertRace(sql, race("r2", "DECIDED"));
      const cache = new StateCache();
      expect(cache.load(sql).races.map((r) => r.raceId)).toEqual(["r1"]);
      cache.apply({ races: [race("r3", "REWORKING"), race("r1", "ABANDONED")] });
      expect(cache.get()!.races.map((r) => r.raceId)).toEqual(["r3"]);
    });
  });
```

Add one guardrails test to the end of the `describe("migrations", ...)` block in `apps/queen/test/migrations.test.ts` (import `effectiveGuardrails` from `../src/work/guardrails`):

```ts
  it("effectiveGuardrails: the rework guardrails default, clamp to their bounds, and allow 0 slots / 0 reopens", () => {
    expect(effectiveGuardrails({})).toMatchObject({ reworkWindowMs: 1_800_000, reworkHoldMs: 600_000, maxReworksPerAttempt: 3, maxRaceReopens: 3 });
    expect(effectiveGuardrails({ reworkWindowMs: 1, reworkHoldMs: 9e9, maxReworksPerAttempt: 0, maxRaceReopens: 0 })).toMatchObject({ reworkWindowMs: 60_000, reworkHoldMs: 3_600_000, maxReworksPerAttempt: 0, maxRaceReopens: 0 });
    expect(effectiveGuardrails({ maxReworksPerAttempt: 9 }).maxReworksPerAttempt).toBe(5);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/migrations.test.ts test/state-cache.test.ts`
Expected: FAIL (`SCHEMA_VERSION` is 18; there is no `rework_reason` column; the guardrails are not clamped).

- [ ] **Step 7: Implement migration v19 and the row mapping**

`apps/queen/src/db.ts`, append to `MIGRATIONS` after the v18 template string:

```ts
  `
  -- v19: rework loop (docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md §10). An open slot is rework_due_at NOT NULL.
  ALTER TABLE attempts ADD COLUMN rework_reason TEXT;               -- findings | conflict | human; NULL = no open slot
  ALTER TABLE attempts ADD COLUMN rework_due_at INTEGER;            -- epoch ms
  ALTER TABLE attempts ADD COLUMN reworks INTEGER NOT NULL DEFAULT 0; -- slots given (round of the current one)
  ALTER TABLE races ADD COLUMN reopens INTEGER NOT NULL DEFAULT 0;  -- PICKING → RACING drops
  `,
```

Change the v17 comment on `base_sha` in the `CREATE TABLE attempts` block to `-- the base the next push is gated against: the item's base_sha, or main recorded by sync_base (v19)` (comment only: SQLite keeps the original DDL text, so this edit changes nothing at runtime).

`rowToAttempt`, after the `lastRegateAt` line:

```ts
    // v19: rework slots (absent = 0 / none, so pre-v19 rows compare equal).
    ...(Number(r.reworks ?? 0) > 0 ? { reworks: Number(r.reworks) } : {}),
    ...(r.rework_due_at !== null && r.rework_due_at !== undefined
      ? { rework: { reason: String(r.rework_reason), dueAt: Number(r.rework_due_at), round: Number(r.reworks ?? 0) } }
      : {}),
```

`upsertAttempt`: add `rework_reason, rework_due_at, reworks` to the column list and `excluded` update list, three more `?`, and pass:

```ts
    a.rework?.reason ?? null,
    a.rework?.dueAt ?? null,
    a.reworks ?? 0,
```

`rowToRace`, after `rejections`:

```ts
    ...(Number(r.reopens ?? 0) > 0 ? { reopens: Number(r.reopens) } : {}),
```

`upsertRace`: add `reopens` to the insert columns and `reopens = excluded.reopens` to the update list, one more `?`, and pass `r.reopens ?? 0`.

- [ ] **Step 8: Clamp the new guardrails**

`apps/queen/src/work/guardrails.ts`, replace the loop body of `effectiveGuardrails`:

```ts
/** Guardrails whose floor is 0 (0 = off), and the millisecond ones whose floor is 1 min. */
const ZERO_OK: ReadonlySet<keyof Guardrails> = new Set(["maxAutoFiledPerHour", "maxFollowUpsPerBuild", "maxConflictReworks", "maxReworksPerAttempt", "maxRaceReopens"]);
const MIN_MS: Partial<Record<keyof Guardrails, number>> = { reworkWindowMs: 60_000, reworkHoldMs: 60_000 };
```

```ts
  for (const key of Object.keys(GUARDRAIL_DEFAULTS) as (keyof Guardrails)[]) {
    const min = MIN_MS[key] ?? (ZERO_OK.has(key) ? 0 : 1);
    out[key] = clampInt(o[key], min, GUARDRAIL_MAX[key], GUARDRAIL_DEFAULTS[key]);
  }
```

- [ ] **Step 9: Keep REWORKING races warm**

`apps/queen/src/scale/state-cache.ts:36` comment → `/** Open races: RACING, PICKING (held for a human pick, T9a) and REWORKING (a winner's rework, rework-loop spec §5.3). */`; line 138:

```ts
    for (const r of q("SELECT * FROM races WHERE state IN ('RACING', 'PICKING', 'REWORKING')")) {
```

and in `apply()` (line 202):

```ts
      if (r.state === "RACING" || r.state === "PICKING" || r.state === "REWORKING") this.races.set(r.raceId, r);
```

`apps/queen/src/queen-node.ts:2400` (`getSnapshot`):

```ts
      .exec("SELECT * FROM races WHERE state IN ('RACING', 'PICKING', 'REWORKING') OR race_id IN (SELECT race_id FROM races ORDER BY created_at DESC LIMIT 20) ORDER BY created_at")
```

- [ ] **Step 10: Run the Queen tests and typecheck**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`
Expected: PASS. Other suites may fail on an exhaustive `switch` over `RaceState` or `RaceOutcome` (for example in the dashboard or the MCP); those fail in the full gate. Fix each by adding the new value to the nearest existing case. A REWORKING race renders like RACING, and a REWORK candidate like FAILED. Do not add behaviour.

- [ ] **Step 11: Full gate**

Run: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`
Expected: every task successful.

- [ ] **Step 12: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add packages/queen-types/src/state.ts packages/queen-types/src/work.ts packages/queen-types/src/attempt.ts packages/queen-types/src/attempt.test.ts packages/queen-types/src/index.test.ts apps/queen/src/db.ts apps/queen/src/work/guardrails.ts apps/queen/src/scale/state-cache.ts apps/queen/src/queen-node.ts apps/queen/test/migrations.test.ts apps/queen/test/state-cache.test.ts
git commit -m "$(cat <<'MSG'
feat(queen-types,queen): rework loop contracts and migration v19

REWORKING race state, REWORK candidate outcome, rework slot on attempts,
race reopens, four rework guardrails, sync_base and reject payloads.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

Add any dashboard / MCP file you touched in Step 10 to the `git add` line.

---

### Task 2: Planner A: REWORK candidate, holds, slot expiry, caps

**Model: Opus** (race-state logic), Opus review. Pure planner work: no Queen wiring yet (Task 5), so a live hive behaves as before. `ctx.rework` is not passed until Task 5.

**Files:**
- Create: `apps/queen/src/train/rework.ts`
- Modify: `apps/queen/src/train/planner.ts`: imports (:91, :108), `HiveState` (:359), `PlannerContext` (:420), `PlanResult` (:487), class fields and constructor (:823-898), `reconcile` (:1515), `raceCandidateFailed` (:2433), `maybeDecide` (:2446), `abandonRace` (:2486), `finish` (:3024)
- Create: `apps/queen/test/rework-harness.ts`, `apps/queen/test/rework-planner.test.ts`

**Interfaces:**
- Consumes: `AttemptRework`, `ReworkReason`, `reworkReasonText`, `parseReworkReason`, `isInfraStopped`, `RACE_GRACE_MS` from queen-types (Task 1).
- Produces (`apps/queen/src/train/rework.ts`):
  - `interface ReworkSettings { windowMs: number; holdMs: number; maxPerAttempt: number; maxRaceReopens: number }`
  - `interface AttemptSlot { attemptId: string; reworks: number; rework: AttemptRework | null }`
  - `nextSlot(slot: AttemptSlot | undefined, attemptId: string, reason: ReworkReason, s: ReworkSettings, now: number, itemStatus?: WorkStatus): AttemptSlot | null`
  - `graceStartOf(race: Pick<Race, "deadlineAt">, graceMs: number): number | null`
  - `holdEnd(rework: AttemptRework, race: Pick<Race, "deadlineAt">, anyPassed: boolean, s: { holdMs: number; graceMs: number }): number`
  - `reworkDeadlines(input: { races; trains; slots; holdMs; graceMs; now }): number[]`
  - `const iso = (ms: number) => string`
- Produces (planner): `HiveState.slots?: AttemptSlot[]`; `PlannerContext.rework?: ReworkSettings` (absent = no slots, today's behaviour); `PlanResult.slots: AttemptSlot[]` (changed slots); `PlanResult.reworkWaits: { itemId: string; waitReason: string | null }[]` (always empty until Task 3); private `giveSlot`, `openSlotOf`, `holding`, `endRework`, `expireSlots`, `setSlot`.
- Produces (tests): `ReworkHive` harness and the constants `MIN`, `A1`, `B1`, `C1` in `apps/queen/test/rework-harness.ts` (Tasks 3 and 4 extend it).

- [ ] **Step 1: Write the pure rules module**

`apps/queen/src/train/rework.ts`:

```ts
/**
 * The rework loop (docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md): an attempt whose head was rejected
 * while its item is open gets a rework slot (a deadline) to fix and push again as the same candidate. Pure: no I/O, no
 * clock (callers pass `now`). The train planner applies these rules; the Queen stores slots on `attempts` rows (v19).
 */
import type { AttemptRework, Race, ReworkReason, WorkStatus } from "@queenos/queen-types";

/** Per-hive rework guardrails (§5.5), from `Guardrails`. Passed to the planner only for external hives. */
export interface ReworkSettings {
  windowMs: number;
  holdMs: number;
  maxPerAttempt: number;
  maxRaceReopens: number;
}

/** An attempt's slot bookkeeping as the planner sees it (attempts.reworks / rework_reason / rework_due_at). */
export interface AttemptSlot {
  attemptId: string;
  /** Slots given so far (the open one included). */
  reworks: number;
  /** The open slot, or null. */
  rework: AttemptRework | null;
}

const CLOSED_ITEM: ReadonlySet<WorkStatus> = new Set(["LANDED", "SHIPPED", "CANCELLED", "DUPLICATE"]);

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The next slot of an attempt, or null when it has none to give (§5.5 "a slot to give": `reworks < maxReworksPerAttempt`
 * and the item open). Findings, conflicts and human rejects share the count.
 */
export function nextSlot(slot: AttemptSlot | undefined, attemptId: string, reason: ReworkReason, s: ReworkSettings, now: number, itemStatus?: WorkStatus): AttemptSlot | null {
  const cur = slot ?? { attemptId, reworks: 0, rework: null };
  if (itemStatus && CLOSED_ITEM.has(itemStatus)) return null;
  if (cur.reworks >= s.maxPerAttempt) return null;
  const round = cur.reworks + 1;
  return { attemptId, reworks: round, rework: { reason, dueAt: now + s.windowMs, round } };
}

/** When the race's grace clock started (the first pass, or entry close if later): `deadlineAt - raceGraceMs` (plan ruling R2). */
export function graceStartOf(race: Pick<Race, "deadlineAt">, graceMs: number): number | null {
  return race.deadlineAt === null ? null : race.deadlineAt - graceMs;
}

/**
 * Until when a REWORK candidate holds its RACING race (§5.2): its `dueAt`; once another candidate passed and the slot
 * came from gate findings, at most `graceStart + reworkHoldMs`. A human reject-one holds until `dueAt` (the judge chose
 * to wait), whatever the grace clock says.
 */
export function holdEnd(rework: AttemptRework, race: Pick<Race, "deadlineAt">, anyPassed: boolean, s: { holdMs: number; graceMs: number }): number {
  if (rework.reason === "human" || !anyPassed) return rework.dueAt;
  const start = graceStartOf(race, s.graceMs);
  return start === null ? rework.dueAt : Math.min(rework.dueAt, start + s.holdMs);
}

/** What `reworkDeadlines` reads of a train. */
export interface DeadlineTrain {
  trainId: string;
  phase: string;
  attemptId?: string | null;
  raceOutcome?: string | null;
}

/**
 * The rework deadlines the DO alarm must wake for (§12 review focus): every open slot's `dueAt`, and each REWORK
 * candidate's hold end in a RACING race. Only future times (a past one would re-arm the alarm at once, forever).
 */
export function reworkDeadlines(input: {
  races: readonly Pick<Race, "state" | "trainIds" | "deadlineAt">[];
  trains: readonly DeadlineTrain[];
  slots: readonly AttemptSlot[];
  holdMs: number;
  graceMs: number;
  now: number;
}): number[] {
  const open = new Map<string, AttemptRework>();
  for (const s of input.slots) if (s.rework) open.set(s.attemptId, s.rework);
  const out: number[] = [];
  for (const r of open.values()) if (r.dueAt > input.now) out.push(r.dueAt);
  for (const race of input.races) {
    if (race.state !== "RACING") continue;
    const cands = input.trains.filter((t) => race.trainIds.includes(t.trainId));
    const anyPassed = cands.some((t) => t.raceOutcome === "PASSED" && t.phase !== "EJECTED" && t.phase !== "MERGED");
    for (const t of cands) {
      const rw = t.raceOutcome === "REWORK" && t.attemptId ? open.get(t.attemptId) : undefined;
      if (!rw) continue;
      const end = holdEnd(rw, race, anyPassed, input);
      if (end > input.now) out.push(end);
    }
  }
  return out;
}
```

- [ ] **Step 2: Write the test harness**

`apps/queen/test/rework-harness.ts`:

```ts
/**
 * A pure planner hive for the rework loop (rework-loop spec §5, §7): external mode, attempt-tagged pushed trains, slots
 * persisted between plans like the Queen does (v19 attempts columns). Swarm races (drone candidates) for T9b too.
 */
import type { Deployment, EventDraft, GateScore, MergeResult, ProvisionCommand, SubmissionOrigin } from "@queenos/queen-types";
import type { RaceRecord } from "../src/records";
import { TrainPlanner, type Effect, type PlanResult, type PlannerItem, type PromptRecord, type QueueOptions, type TrainRecord } from "../src/train/planner";
import type { AttemptSlot, ReworkSettings } from "../src/train/rework";

export const MIN = 60_000;
export const A1 = "att_aaaaaaaaaaaa";
export const B1 = "att_bbbbbbbbbbbb";
export const C1 = "att_cccccccccccc";
export const ORIGIN: SubmissionOrigin = { kind: "agent", id: "opus@ada@example.com" };
const SCORE: GateScore = { review: "approved", satisfied: 3, missing: 0, changedFiles: 1, changedBytes: 400, checks: 4 };
let shaN = 0;
const sha = () => (0xfeed00 + ++shaN).toString(16).padStart(40, "0");

export class ReworkHive {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  deployments = new Map<string, Deployment>();
  races = new Map<string, RaceRecord>();
  slots = new Map<string, AttemptSlot>();
  effects: Effect[] = [];
  events: EventDraft[] = [];
  /** Items that went FAILED "awaiting contributor" (the fallback), in order. */
  awaiting: string[] = [];
  /** Wait reasons the planner set (`awaiting rework ...`) or cleared (null), per item (Task 3). */
  waits = new Map<string, string | null>();
  now = 1_000_000;
  graceMs = 90_000;
  entryWindowMs = 0;
  judge: "auto" | "human" = "auto";
  external = true;
  rework: ReworkSettings | undefined = { windowMs: 30 * MIN, holdMs: 10 * MIN, maxPerAttempt: 3, maxRaceReopens: 3 };
  queue: QueueOptions | undefined;
  items: PlannerItem[] = [{ itemId: "A", status: "ACTIVE" }];
  last: PlanResult | null = null;
  private ids = 0;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;
  private maxPassedSeq = 0;

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
    const p = new TrainPlanner(
      {
        prompts: [...this.prompts.values()],
        trains: [...this.trains.values()],
        deployments: [...this.deployments.values()],
        maxTrainSeq: this.maxTrainSeq,
        maxPromptSeq: this.maxPromptSeq,
        races: [...this.races.values()],
        items: this.items,
        maxPassedSeq: this.maxPassedSeq,
        slots: [...this.slots.values()],
      },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `t${++this.ids}`,
        external: this.external,
        entryWindowMs: this.entryWindowMs,
        raceGraceMs: this.graceMs,
        pick: { judge: this.judge, pickWindowMs: 15 * MIN, maxPickingRaces: 2 },
        ...(this.rework ? { rework: this.rework } : {}),
        ...(this.queue ? { queue: this.queue } : {}),
      },
    );
    const r = fn(p);
    for (const x of r.prompts) {
      this.prompts.set(x.promptId, x);
      this.maxPromptSeq = Math.max(this.maxPromptSeq, x.seq);
    }
    for (const t of r.trains) {
      this.trains.set(t.trainId, t);
      this.maxTrainSeq = Math.max(this.maxTrainSeq, t.seq);
      this.maxPassedSeq = Math.max(this.maxPassedSeq, t.passedSeq ?? 0);
    }
    for (const x of r.races) this.races.set(x.raceId, x);
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    for (const s of r.slots) this.slots.set(s.attemptId, s);
    for (const w of r.reworkWaits) this.waits.set(w.itemId, w.waitReason);
    this.awaiting.push(...(r.awaitingContributor ?? []).map((a) => a.promptId));
    this.events.push(...r.events);
    this.effects.push(...r.effects);
    this.last = r;
    return r;
  }

  /** Attempt `attemptId` pushes a new head to `itemId` (a new train `<attemptId>-<n>`); joins the item's RACING race, else opens one. */
  push(attemptId: string, opts: { itemId?: string; rejoin?: boolean } = {}): string {
    const itemId = opts.itemId ?? "A";
    const trainId = `${attemptId}-${++this.ids}`;
    const race = [...this.races.values()].filter((r) => r.itemId === itemId && (r.state === "RACING" || (opts.rejoin && r.state === "REWORKING"))).at(-1);
    this.run((p) => p.intent({ trainId, promptId: itemId, origin: ORIGIN, promptText: `do ${itemId}`, attemptId }));
    this.run((p) =>
      p.pushed({
        trainId,
        headSha: sha(),
        baseSha: "b".repeat(40),
        origin: ORIGIN,
        promptId: itemId,
        promptText: `do ${itemId}`,
        attempts: 0,
        item: this.items.find((i) => i.itemId === itemId)!,
        race: race ? { join: race.raceId } : { create: true },
        resume: true,
        ...(opts.rejoin ? { rejoin: true as const } : {}),
      }),
    );
    return trainId;
  }

  /** The train's newest preview DEPLOY reports live (→ TESTING, a gate issued). No-op once it is TESTING. */
  live(trainId: string): void {
    if (this.t(trainId).phase !== "DEPLOYING") return;
    const d = this.effects.filter((e): e is Extract<Effect, { type: "deploy" }> => e.type === "deploy" && e.trainId === trainId && e.command.op === "DEPLOY").at(-1)!;
    this.run((p) => p.deployResult({ commandId: d.command.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.preview` }));
  }

  pass(trainId: string): PlanResult {
    this.live(trainId);
    return this.run((p) => p.trainResult({ trainId, passed: true, summary: "green", score: SCORE }));
  }

  fail(trainId: string, summary = "lint: unused variable x"): PlanResult {
    this.live(trainId);
    return this.run((p) => p.trainResult({ trainId, passed: false, summary }));
  }

  /** Move the clock and run the alarm's reconcile (watchdogs, race deadlines, slot expiry). */
  at(ms: number): PlanResult {
    this.now += ms;
    return this.run((p) => p.reconcile());
  }

  /** The winner's car forks (Provisioner FORK ok): the car is BUILDING with its MERGE drone out. Returns the car id. */
  forkCar(memberId: string): string {
    const carId = this.t(memberId).carId!;
    const f = this.effects.filter((e): e is Extract<Effect, { type: "provision" }> => e.type === "provision" && e.trainId === carId && e.command.op === "FORK").at(-1)!;
    const c = f.command as Extract<ProvisionCommand, { op: "FORK" }>;
    this.run((p) => p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: c.forkName, baseSha: "c".repeat(40) }));
    return carId;
  }

  /** The MERGE drone reports `memberId` conflicting in `carId`. */
  conflict(carId: string, memberId: string, paths = ["src/shared.js"]): PlanResult {
    const r: MergeResult = { trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [], conflicts: [{ trainId: memberId, kind: "content", paths, summary: `Merge conflict in ${paths.join(", ")}` }], fastForward: false, summary: "" };
    return this.run((p) => p.mergeResult(r));
  }

  /** `memberId` merges into `carId`, the car's preview goes live, and its integration gate fails. */
  integrationFail(carId: string, memberId: string): PlanResult {
    const r: MergeResult = { trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [memberId], conflicts: [], fastForward: false, summary: "" };
    this.run((p) => p.mergeResult(r));
    this.live(carId);
    return this.run((p) => p.trainResult({ trainId: carId, passed: false, summary: "integration smoke /tip failed" }));
  }

  t(id: string): TrainRecord {
    return this.trains.get(id)!;
  }

  /** The item's newest race. */
  race(itemId = "A"): RaceRecord {
    return [...this.races.values()].filter((r) => r.itemId === itemId).at(-1)!;
  }

  slot(attemptId: string): AttemptSlot | undefined {
    return this.slots.get(attemptId);
  }
}
```

- [ ] **Step 3: Write the failing planner tests**

`apps/queen/test/rework-planner.test.ts`:

```ts
/** Rework loop, planner (rework-loop spec §5.2, §5.5, §5.6): REWORK candidates, holds, slot expiry, caps. Pure. */
import { describe, expect, it } from "vitest";
import { INFRA_SUMMARY_PREFIX, parseReworkReason } from "@queenos/queen-types";
import { graceStartOf, holdEnd, nextSlot, reworkDeadlines, type ReworkSettings } from "../src/train/rework";
import { A1, B1, C1, MIN, ReworkHive } from "./rework-harness";

const S: ReworkSettings = { windowMs: 30 * MIN, holdMs: 10 * MIN, maxPerAttempt: 3, maxRaceReopens: 3 };

describe("rework.ts: pure rules", () => {
  it("nextSlot: round = reworks + 1, due now + window; none past the cap or on a closed item", () => {
    expect(nextSlot(undefined, A1, "findings", S, 1000)).toEqual({ attemptId: A1, reworks: 1, rework: { reason: "findings", dueAt: 1000 + 30 * MIN, round: 1 } });
    expect(nextSlot({ attemptId: A1, reworks: 2, rework: null }, A1, "conflict", S, 0)!.rework).toEqual({ reason: "conflict", dueAt: 30 * MIN, round: 3 });
    expect(nextSlot({ attemptId: A1, reworks: 3, rework: null }, A1, "human", S, 0)).toBeNull();
    expect(nextSlot(undefined, A1, "findings", { ...S, maxPerAttempt: 0 }, 0)).toBeNull();
    expect(nextSlot(undefined, A1, "findings", S, 0, "LANDED")).toBeNull();
  });

  it("holdEnd: dueAt with no pass; min(dueAt, graceStart + hold) after a pass; a human reject holds until dueAt", () => {
    const g = { holdMs: 10 * MIN, graceMs: 90_000 };
    const race = { deadlineAt: 5 * MIN + 90_000 }; // the first pass at 5 min
    expect(graceStartOf(race, 90_000)).toBe(5 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, race, false, g)).toBe(30 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, race, true, g)).toBe(15 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 12 * MIN, round: 1 }, race, true, g)).toBe(12 * MIN);
    expect(holdEnd({ reason: "human", dueAt: 30 * MIN, round: 1 }, race, true, g)).toBe(30 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, { deadlineAt: null }, true, g)).toBe(30 * MIN);
  });
});

describe("planner: a rejected attempt candidate keeps its place (§5.2)", () => {
  it("a findings rejection opens a slot: REWORK, EJECTED, the due time in the reason; the race stays RACING", () => {
    const h = new ReworkHive();
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b)).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", summary: "lint: unused variable x" });
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: { reason: "findings", dueAt: h.now + 30 * MIN, round: 1 } });
    expect(parseReworkReason(h.t(b).reason)).toEqual({ reason: "findings", dueAt: h.now + 30 * MIN });
    expect(h.race().state).toBe("RACING");
  });

  it("with nothing passed, a REWORK candidate holds the race until dueAt; then it fails and the race is abandoned (the fallback)", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    h.fail(a);
    h.at(29 * MIN);
    expect(h.race().state).toBe("RACING");
    expect(h.awaiting).toEqual([]);
    h.at(2 * MIN);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.slot(A1)).toEqual({ attemptId: A1, reworks: 1, rework: null });
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("with another candidate passed, a findings hold ends at graceStart + reworkHoldMs (not 90 s, not dueAt); it loses and the race decides", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a); // the grace clock starts now
    h.fail(b);
    h.at(2 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(7 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(MIN + 1000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(h.t(b).raceOutcome).toBe("LOST");
    expect(parseReworkReason(h.t(b).reason)?.reason).toBe("findings"); // R20: still reads as rejected
    expect(h.slot(B1)!.rework).toBeNull();
  });

  it("the hold ends at dueAt when that comes before graceStart + reworkHoldMs", () => {
    const h = new ReworkHive();
    h.rework = { ...S, windowMs: 5 * MIN };
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    h.at(4 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(MIN + 1000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(["FAILED", "LOST"]).toContain(h.t(b).raceOutcome);
  });

  it("a RACING candidate is still capped by raceGraceMs", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const c = h.push(C1);
    h.pass(a);
    h.at(91_000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(h.t(c)).toMatchObject({ raceOutcome: "LOST", reason: expect.stringMatching(/still running at the race deadline/) });
  });

  it("an infra-stopped candidate takes no slot (infra keeps its own path)", () => {
    const h = new ReworkHive();
    h.push(A1);
    const b = h.push(B1);
    h.fail(b, `${INFRA_SUMMARY_PREFIX}gate could not run after 4 tries: reviewer empty`);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toBeUndefined();
  });

  it("an attempt past maxReworksPerAttempt fails as today; maxReworksPerAttempt 0 gives no slot", () => {
    const h = new ReworkHive();
    h.slots.set(B1, { attemptId: B1, reworks: 3, rework: null });
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 3, rework: null });

    const z = new ReworkHive();
    z.rework = { ...S, maxPerAttempt: 0 };
    const y = z.push(A1);
    z.fail(y);
    expect(z.t(y).raceOutcome).toBe("FAILED");
    expect(z.race().state).toBe("ABANDONED");
  });

  it("judge human: once the hold ends the race goes to PICKING with the REWORK candidate LOST", () => {
    const h = new ReworkHive();
    h.judge = "human";
    const a = h.push(A1);
    const b = h.push(B1);
    const c = h.push(C1);
    h.pass(a);
    h.pass(c);
    h.fail(b);
    h.at(10 * MIN + 1000);
    expect(h.race().state).toBe("PICKING");
    expect(h.t(b).raceOutcome).toBe("LOST");
  });

  it("no rework settings (a swarm hive, an older caller): a failed candidate is FAILED as before", () => {
    const h = new ReworkHive();
    h.rework = undefined;
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slots.size).toBe(0);
  });

  it("reworkDeadlines: the open slot's dueAt and its hold end (alarm), only future ones", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    const input = { races: [...h.races.values()], trains: [...h.trains.values()], slots: [...h.slots.values()], holdMs: 10 * MIN, graceMs: h.graceMs };
    expect(reworkDeadlines({ ...input, now: h.now }).sort((x, y) => x - y)).toEqual([h.now + 10 * MIN, h.now + 30 * MIN]);
    expect(reworkDeadlines({ ...input, now: h.now + 20 * MIN })).toEqual([h.now + 30 * MIN]);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: FAIL: `TrainPlanner` ignores `slots` / `rework`, and `r.slots` is undefined in the harness.

- [ ] **Step 5: Wire slots into the planner's types and lifecycle**

`apps/queen/src/train/planner.ts`:

Imports. Add `isInfraStopped, parseReworkReason, reworkReasonText` to the value import at :91, `type ReworkReason` to the type import block (:63-90), and a new import line after :108:

```ts
import { holdEnd, iso, nextSlot, type AttemptSlot, type ReworkSettings } from "./rework";
```

`HiveState` (after `maxPassedSeq`):

```ts
  /** Rework loop (v19): slots of the hive's open attempts (attempts.reworks / rework_reason / rework_due_at). */
  slots?: AttemptSlot[];
```

`PlannerContext` (after `entryWindowMs`):

```ts
  /**
   * Rework loop (rework-loop spec §5.5): external hives' rework guardrails. Absent (swarm hives): no attempt ever gets a
   * slot and every rejection is handled as before the rework loop.
   */
  rework?: ReworkSettings;
```

`PlanResult` (after `refused`):

```ts
  /** Rework loop: attempt slots this plan changed (the Queen writes them onto attempts rows). */
  slots: AttemptSlot[];
  /** Rework loop: an item's wait reason while its race is REWORKING (`awaiting rework (...)`); null clears it (Task 3 sets it). */
  reworkWaits: { itemId: string; waitReason: string | null }[];
```

Class fields (next to `dirtyRaces`):

```ts
  private readonly slots = new Map<string, AttemptSlot>();
  private readonly dirtySlots = new Set<string>();
  private readonly reworkWaits = new Map<string, string | null>();
```

Constructor (after the `races` loop):

```ts
    for (const s of state.slots ?? []) this.slots.set(s.attemptId, { ...s, rework: s.rework ? { ...s.rework } : null });
```

`finish()`: in the `result` object add `slots: [...this.dirtySlots].map((id) => { const s = this.slots.get(id)!; return { ...s, rework: s.rework ? { ...s.rework } : null }; }),` and `reworkWaits: [...this.reworkWaits].map(([itemId, waitReason]) => ({ itemId, waitReason })),`; before `return result;` add `this.dirtySlots.clear();` and `this.reworkWaits.clear();`.

New private helpers in the races section (after `setRace`):

```ts
  // ── internals: the rework loop (rework-loop spec §5) ─────────────────

  private setSlot(s: AttemptSlot): void {
    this.slots.set(s.attemptId, s);
    this.dirtySlots.add(s.attemptId);
  }

  /** The train's attempt's open slot, or null. */
  private openSlotOf(t: TrainRecord): AttemptSlot | null {
    if (!t.attemptId) return null;
    const s = this.slots.get(t.attemptId);
    return s?.rework ? s : null;
  }

  /** Open the next slot of `t`'s attempt (an external hive, an attempt's train, a slot left, the item open), or null. */
  private giveSlot(t: TrainRecord, reason: ReworkReason): AttemptSlot | null {
    if (!this.ctx.rework || !t.attemptId || !isContributed(t)) return null;
    const next = nextSlot(this.slots.get(t.attemptId), t.attemptId, reason, this.ctx.rework, this.ctx.now, this.item(t.promptId)?.status);
    if (next) this.setSlot(next);
    return next;
  }

  /** A REWORK candidate still holds its RACING race (§5.2): its slot is open and its hold has not ended. */
  private holding(t: TrainRecord, race: RaceRecord, anyPassed: boolean): boolean {
    const s = this.openSlotOf(t);
    if (!s) return false;
    return this.ctx.now < holdEnd(s.rework!, race, anyPassed, { holdMs: this.ctx.rework?.holdMs ?? 0, graceMs: this.ctx.raceGraceMs ?? RACE_GRACE_MS });
  }

  /**
   * A REWORK candidate leaves the race: FAILED (its slot expired, its attempt ended, the race fell back) or LOST (the race
   * was decided while it was still in rework). Its slot closes. The reason keeps the rework text (R20: the head still reads
   * as rejected); `why` goes on the event.
   */
  private endRework(t: TrainRecord, outcome: "FAILED" | "LOST", why: string): void {
    if (t.raceOutcome !== "REWORK") return;
    this.setTrain(t, { raceOutcome: outcome });
    const s = t.attemptId ? this.slots.get(t.attemptId) : undefined;
    if (s?.rework) this.setSlot({ ...s, rework: null });
    this.event(t, { type: "train.phase", severity: "warn", summary: clip500(`train ${t.trainId} ${outcome} (was in rework): ${why}`), data: { raceId: t.raceId ?? null, raceOutcome: outcome, rework: true } });
  }

  /** Slots whose dueAt passed (alarm): the REWORK candidate fails, its race decides (or abandons). */
  private expireSlots(): void {
    for (const s of [...this.slots.values()]) {
      if (!s.rework || s.rework.dueAt > this.ctx.now) continue;
      const t = this.trains.find((x) => x.attemptId === s.attemptId && x.raceOutcome === "REWORK");
      if (!t) {
        this.setSlot({ ...s, rework: null });
        continue;
      }
      const race = t.raceId ? this.races.get(t.raceId) : undefined;
      this.endRework(t, "FAILED", `rework slot ${s.rework.round} of attempt ${s.attemptId} expired at ${iso(s.rework.dueAt)}`);
      if (race) this.maybeDecide(race);
    }
  }
```

- [ ] **Step 6: Give a rejected candidate a slot (`raceCandidateFailed`)**

Replace `raceCandidateFailed` (planner.ts:2433-2440):

```ts
  /**
   * A candidate failed (gate, build, watchdog): eject it alone; no rework yet. Rework loop (§5.2): an attempt's candidate
   * rejected on findings in a RACING race keeps its place with a rework slot (REWORK) instead; infra never uses a slot.
   */
  private raceCandidateFailed(t: TrainRecord, race: RaceRecord, summary: string): void {
    const why = `failed in race: ${summary}`;
    const slot = race.state === "RACING" && !isInfraStopped({ summary }) ? this.giveSlot(t, "findings") : null;
    if (slot) {
      this.ejectKeepingFork(t, reworkReasonText("findings", slot.rework!.dueAt, why), { raceOutcome: "REWORK", summary: clip500(summary) });
      this.maybeDecide(race);
      return;
    }
    const patch: Partial<TrainRecord> = { raceOutcome: "FAILED", summary: clip500(summary) };
    if (isContributed(t)) this.ejectKeepingFork(t, why, patch);
    else this.eject(t, why, patch);
    this.maybeDecide(race);
  }
```

- [ ] **Step 7: Hold the race for REWORK candidates (`maybeDecide`, `abandonRace`, `reconcile`)**

Replace the body of `maybeDecide` (planner.ts:2446-2484) up to the `if (passed.length) {` line, and add the REWORK handling:

```ts
  private maybeDecide(race: RaceRecord): void {
    if (race.state === "PICKING") {
      this.maybeDecidePicking(race);
      return;
    }
    if (race.state !== "RACING") return;
    const cands = race.trainIds.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const live = cands.filter(isActive);
    const pending = live.filter((t) => t.raceOutcome === "RACING");
    const passed = live.filter((t) => t.raceOutcome === "PASSED");
    const reworking = cands.filter((t) => t.raceOutcome === "REWORK");
    // The grace clock belongs to a live pass: once the last one left (superseded, failed), the next pass restarts it.
    if (!passed.length && race.deadlineAt !== null) this.setRace(race, { deadlineAt: null });
    // An open entry window holds everything (passes and all-failed alike): another agent may still enter.
    if (race.entryClosesAt != null && this.ctx.now < race.entryClosesAt) return;
    const due = race.deadlineAt !== null && this.ctx.now >= race.deadlineAt;
    if (pending.length && !(due && passed.length)) return;
    // Rework loop (§5.2): a REWORK candidate is pending until its hold ends, even though its train is no longer active.
    if (reworking.some((t) => this.holding(t, race, passed.length > 0))) return;
    const predicted = this.item(race.itemId)?.paths ?? [];
    if (passed.length) {
      for (const t of reworking) this.endRework(t, "LOST", `lost race ${race.raceId}: still in rework at the race deadline`);
      // ... the existing body from `const judge = judgeOf(...)` to the end of the `if (passed.length)` block, unchanged
    }
    this.abandonRace(race, cands, predicted);
  }
```

At the top of `abandonRace` (planner.ts:2486), before `const prompt = ...`:

```ts
    for (const t of cands) this.endRework(t, "FAILED", `race ${race.raceId} abandoned: no candidate passed`);
```

In `reconcile()` (planner.ts:1515), before the `for (const race of [...this.races.values()])` loop:

```ts
    this.expireSlots();
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 9: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`
Expected: PASS. Nothing in production passes `rework` yet, so `planner.test.ts`, `pick.test.ts` and the attempt suites are unchanged.
Run: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`. Expected: every task successful.

- [ ] **Step 10: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/train/rework.ts apps/queen/src/train/planner.ts apps/queen/test/rework-harness.ts apps/queen/test/rework-planner.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): rework slots for rejected race candidates (planner)

A findings rejection of an attempt's candidate keeps its place as REWORK;
the race holds until the slot's hold ends, then decides or abandons.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Planner B: slot push, REWORKING, fallback, `attemptEnded`

**Model: Opus**, Opus review. Still pure planner.

**Files:**
- Modify: `apps/queen/src/train/planner.ts`: `pushed` (:988-1073, the race-join block :1023-1035), `withdraw` (:1137), `trainResult` (:1402, the `racingRaceOf` block :1440-1450), `fail` (:2090), `racingRaceOf` (:2420), `raceCandidateFailed`, `expireSlots`, `finish`; new `attemptEnded`, `winnerRejected`, `reworkWon`, `reworkFixFailed`, `abandonRework`, `closeSlotByPush`, `reworkWait`
- Test: `apps/queen/test/rework-planner.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's slot helpers and harness.
- Produces:
  - `PlanResult.reworkWaits` (declared in Task 2) is now filled: the item's wait reason while its race is REWORKING (`awaiting rework (attempt <id>, due <ISO>)`); `null` clears it. Task 5 wires it into the ledger.
  - `TrainPlanner.attemptEnded(attemptId: string, why: string): PlanResult`: the Queen calls it on `end_attempt` and on watchdog expiry (Task 6).
  - `pushed({..., rejoin: true})` now also (a) joins a REWORKING race, and (b) closes the attempt's open slot: old REWORK train FAILED, slot `rework: null`, R3 deadline extension.

- [ ] **Step 1: Write the failing tests**

Append to `apps/queen/test/rework-planner.test.ts`:

```ts
describe("planner: the slot fix (§5.1, §5.2)", () => {
  /** A passed at t0, B rejected at t0 (REWORK); entries close at t0 + 15 min. */
  function reworkAfterClose() {
    const h = new ReworkHive();
    h.entryWindowMs = 15 * MIN;
    const t0 = h.now;
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    h.at(16 * MIN); // entries closed; B's hold ends at the grace start (entry close) + 10 min = t0 + 25 min
    return { h, t0, a, b };
  }

  it("the fix rejoins its own race after entry close as the same candidate; the old REWORK train fails; the slot closes", () => {
    const { h, a, b } = reworkAfterClose();
    expect(h.race().state).toBe("RACING");
    const fix = h.push(B1, { rejoin: true });
    expect(h.t(fix)).toMatchObject({ raceId: h.race().raceId, raceOutcome: "RACING", phase: "DEPLOYING" });
    expect(h.race().trainIds).toEqual([a, b, fix]);
    expect(h.races.size).toBe(1);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: null });
  });

  it("R3: the fix is not cut off by the old grace clock; the race waits for its verdict up to the hold end", () => {
    const { h, t0, a } = reworkAfterClose();
    const fix = h.push(B1, { rejoin: true });
    expect(h.race().deadlineAt).toBe(t0 + 25 * MIN);
    h.at(2 * MIN); // t0 + 18 min: past the old deadline (t0 + 16.5 min), the fix still gating
    expect(h.race().state).toBe("RACING");
    h.pass(fix);
    expect(h.race().state).toBe("DECIDED");
    expect([a, fix]).toContain(h.race().winnerTrainId);
  });

  it("a slot fix pushed before dueAt survives the slot's expiry alarm", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    h.fail(a);
    h.at(29 * MIN);
    const fix = h.push(A1, { rejoin: true });
    h.at(2 * MIN); // past the old dueAt: nothing to expire, the slot closed with the push
    expect(h.t(fix).raceOutcome).toBe("RACING");
    expect(h.race().state).toBe("RACING");
    h.pass(fix);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: fix });
  });

  it("a second push before the fix's verdict supersedes it in place: no new slot, still one race", () => {
    const { h } = reworkAfterClose();
    const fix = h.push(B1, { rejoin: true });
    const second = h.push(B1, { rejoin: true });
    h.run((p) => p.supersede(fix, "f".repeat(40)));
    expect(h.t(fix)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(h.t(second).raceOutcome).toBe("RACING");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: null });
    expect(h.races.size).toBe(1);
    expect(h.race().state).toBe("RACING");
  });
});

describe("planner: a winner rejected in the train (§5.3)", () => {
  function winner() {
    const h = new ReworkHive();
    h.queue = { settings: { maxQueueBatch: 1, maxQueueDepth: 1 } };
    const a = h.push(A1);
    h.pass(a);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    const car = h.forkCar(a);
    return { h, a, car };
  }

  it("a merge conflict: race REWORKING, the winner REWORK with a conflict slot, the item waits (no awaiting contributor)", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    expect(h.t(a)).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", conflict: { paths: ["src/shared.js"] } });
    expect(parseReworkReason(h.t(a).reason)?.reason).toBe("conflict");
    expect(h.race()).toMatchObject({ state: "REWORKING", winnerTrainId: a });
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "conflict", round: 1 });
    expect(h.waits.get("A")).toMatch(/^awaiting rework \(attempt att_aaaaaaaaaaaa, due 20\d\d-/);
    expect(h.awaiting).toEqual([]);
  });

  it("the fix rejoins the REWORKING race (no new race, no window), is gated, wins on PASS and takes a queue ticket", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    expect(h.t(fix)).toMatchObject({ raceId: h.race().raceId, raceOutcome: "RACING", phase: "DEPLOYING" });
    expect(h.races.size).toBe(1);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    h.pass(fix);
    expect(h.t(fix)).toMatchObject({ phase: "PASSED", raceOutcome: "WON", passedSeq: expect.any(Number) });
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: fix });
    expect(h.waits.get("A")).toBeNull();
  });

  it("an integration-gate failure of the winner also reworks it (reason findings)", () => {
    const { h, a, car } = winner();
    h.integrationFail(car, a);
    expect(h.t(a).raceOutcome).toBe("REWORK");
    expect(h.race().state).toBe("REWORKING");
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "findings", round: 1 });
  });

  it("a rebased head rejected again keeps the race REWORKING with the next round", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.fail(fix);
    expect(h.t(fix).raceOutcome).toBe("REWORK");
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "findings", round: 2 });
    expect(h.race().state).toBe("REWORKING");
  });

  it("slot expiry in REWORKING is the fallback: ABANDONED, the REWORK train FAILED, the item awaits any agent", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    h.at(31 * MIN);
    expect(h.race()).toMatchObject({ state: "ABANDONED", reason: expect.stringMatching(/rework slot 1 of attempt att_aaaaaaaaaaaa expired/) });
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.awaiting).toEqual(["A"]);
    expect(h.waits.get("A")).toBeNull();
  });

  it("R8: no slot left when the winner conflicts: the fallback at once", () => {
    const { h, a, car } = winner();
    h.rework = { ...h.rework!, maxPerAttempt: 0 };
    h.conflict(car, a);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("R7: an infra-stopped fix leaves the race REWORKING; the attempt ending then falls back", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.fail(fix, `${INFRA_SUMMARY_PREFIX}gate could not run after 4 tries: reviewer empty`);
    expect(h.t(fix).raceOutcome).toBe("FAILED");
    expect(h.race().state).toBe("REWORKING");
    expect(h.run((p) => p.attemptEnded(A1, "attempt expired")).outcome).toBe("applied");
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("withdrawing the fix in flight (end_attempt) falls back once", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.run((p) => p.withdraw(fix, "opus ended attempt"));
    expect(h.t(fix)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(h.race().state).toBe("ABANDONED");
    expect(h.run((p) => p.attemptEnded(A1, "end_attempt")).outcome).toBe("ignored:stale");
    expect(h.awaiting).toEqual(["A"]);
  });
});

describe("planner: attemptEnded in a RACING race", () => {
  it("the REWORK candidate fails and the race decides without it; a loser's attempt ending never touches a REWORKING race", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    expect(h.run((p) => p.attemptEnded(B1, "end_attempt")).outcome).toBe("applied");
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)!.rework).toBeNull();
    h.at(91_000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: FAIL: `attemptEnded` is not a function; a rejoin does not close the slot; a car conflict leaves the race DECIDED.

- [ ] **Step 3: `reworkWait`**

`PlanResult.reworkWaits` and its map already exist (Task 2). Add the helper (rework section):

```ts
  /** Set (or clear) the item's REWORKING wait reason; its prompt rides along so the ledger absorbs it. */
  private reworkWait(itemId: string, waitReason: string | null): void {
    this.reworkWaits.set(itemId, waitReason === null ? null : clip(waitReason, 200));
    const p = this.prompts.get(itemId);
    if (p) this.markPrompt(p, false);
  }
```

- [ ] **Step 4: The slot push (`pushed`, `closeSlotByPush`)**

In `pushed`, update the `rejoin` doc comment ("`attemptRegate`, or a rework slot's fix (rework-loop spec §5.1): ... a REWORKING race may be rejoined too") and replace the join decision (planner.ts:1023-1035):

```ts
    let race = input.race && "join" in input.race ? this.races.get(input.race.join) : undefined;
    // Defensive (intake already files a follow-up): never join a race whose entry window has closed.
    const closedJoin = !input.rejoin && !!race && race.state === "RACING" && race.entryClosesAt != null && this.ctx.now >= race.entryClosesAt;
    // A rejoin (re-gate, rework slot fix) may also re-enter a REWORKING race: only the winner's attempt is routed there.
    const joinable = !!race && (race.state === "RACING" || (input.rejoin === true && race.state === "REWORKING"));
    if (race && (!joinable || closedJoin)) race = undefined;
    if (race) {
      const anyPassed = race.trainIds.some((id) => {
        const x = this.find(id);
        return !!x && isActive(x) && x.raceOutcome === "PASSED";
      });
      // ... the existing join body (setRace trainIds, setTrain RACING, the train.enqueued event), unchanged
      if (input.rejoin) this.closeSlotByPush(t, race, anyPassed);
    } else if (input.race && !closedJoin) {
```

New helper:

```ts
  /**
   * A push inside the attempt's open slot (§5.1): the slot closes (reworks kept), the old REWORK train of the attempt
   * fails (no longer pending), and (R3) a RACING race's grace deadline moves out to the slot's hold end, so the fix is
   * not cut off by a grace clock that started before it existed.
   */
  private closeSlotByPush(t: TrainRecord, race: RaceRecord, anyPassed: boolean): void {
    const s = t.attemptId ? this.slots.get(t.attemptId) : undefined;
    if (!s?.rework || s.rework.dueAt <= this.ctx.now) return;
    const end = holdEnd(s.rework, race, anyPassed, { holdMs: this.ctx.rework?.holdMs ?? 0, graceMs: this.ctx.raceGraceMs ?? RACE_GRACE_MS });
    for (const old of this.trains) if (old !== t && old.attemptId === t.attemptId && old.raceOutcome === "REWORK") this.setTrain(old, { raceOutcome: "FAILED" }, false);
    this.setSlot({ ...s, rework: null });
    if (race.state === "RACING" && race.deadlineAt !== null && end > race.deadlineAt) this.setRace(race, { deadlineAt: end });
  }
```

- [ ] **Step 5: REWORKING races in `racingRaceOf`, `trainResult`, `raceCandidateFailed`, `withdraw`, `expireSlots`**

`racingRaceOf`:

```ts
  /** The train's race, if it is a candidate still in a RACING race (a passed candidate held in PICKING; a fix in REWORKING). */
  private racingRaceOf(t: TrainRecord): RaceRecord | undefined {
    if (!t.raceId || isCar(t)) return undefined;
    const race = this.races.get(t.raceId);
    if (race?.state !== "RACING" && race?.state !== "PICKING" && race?.state !== "REWORKING") return undefined;
    return t.raceOutcome === "RACING" || t.raceOutcome === "PASSED" ? race : undefined;
  }
```

`trainResult`: replace `const race = this.racingRaceOf(t);` + `if (race) {` with:

```ts
    const race = this.racingRaceOf(t);
    if (race?.state === "REWORKING") {
      this.reworkWon(t, race, r);
      return this.finish("applied");
    }
    if (race) {
```

At the top of `raceCandidateFailed`:

```ts
    if (race.state === "REWORKING") {
      this.reworkFixFailed(t, race, summary);
      return;
    }
```

`withdraw`, replace the two lines after `const race = this.racingRaceOf(t);`:

```ts
    this.eject(t, clip500(`withdrawn: ${reason}`), race ? { raceOutcome: "LOST" } : {});
    if (race?.state === "REWORKING") {
      this.abandonRework(race, `the winner's attempt withdrew its fix (${reason})`);
      return this.finish("applied");
    }
    if (race) this.maybeDecide(race);
```

`expireSlots`, replace `if (race) this.maybeDecide(race);`:

```ts
      if (race?.state === "REWORKING") this.abandonRework(race, `rework slot ${s.rework.round} of attempt ${s.attemptId} expired`);
      else if (race) this.maybeDecide(race);
```

- [ ] **Step 6: A winner rejected in the train (`fail`, `winnerRejected`)**

In `fail()`, right after the `if (isCar(t)) {...}` block:

```ts
    // Rework loop (§5.3): a race winner (an attempt's train) ejected from its car by a conflict or an integration failure.
    if (opts.cause && t.attemptId && t.raceOutcome === "WON" && this.ctx.rework) {
      const won = t.raceId ? this.races.get(t.raceId) : undefined;
      if (won && won.state === "DECIDED" && won.winnerTrainId === t.trainId) {
        this.winnerRejected(t, won, summary, opts);
        return;
      }
    }
```

New methods (rework section):

```ts
  /**
   * §5.3: the winner was rejected in the merge train. With a slot: REWORK (conflict, or findings for an integration
   * failure), race DECIDED → REWORKING, the item waits for the fix ("awaiting rework"); only this attempt may push, and its
   * push rejoins this race (no new race, no entry window). Without one (R8): the fallback at once.
   */
  private winnerRejected(t: TrainRecord, race: RaceRecord, summary: string, opts: FailOptions): void {
    const reason: ReworkReason = opts.cause === "conflict" ? "conflict" : "findings";
    const extra: Partial<TrainRecord> = opts.conflict ? { conflict: opts.conflict } : {};
    const slot = this.giveSlot(t, reason);
    if (!slot) {
      this.ejectKeepingFork(t, clip500(`failed: ${summary}`), { ...extra, raceOutcome: "FAILED" });
      this.abandonRework(race, `winner ${t.trainId} was rejected in the train (${reason}) and attempt ${t.attemptId} has no rework slot left`);
      return;
    }
    const { dueAt, round } = slot.rework!;
    this.ejectKeepingFork(t, reworkReasonText(reason, dueAt, `failed: ${summary}`), { ...extra, raceOutcome: "REWORK" });
    this.setRace(race, { state: "REWORKING" });
    this.raceEvent(race, t, `race ${race.raceId} reworking: winner ${t.trainId} was rejected in the train (${reason}); attempt ${t.attemptId} may push a fix until ${iso(dueAt)}`, { outcome: "REWORKING", winner: t.trainId, reason, dueAt, round }, "warn");
    this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}, due ${iso(dueAt)})`);
    this.maybeLand();
  }

  /** §5.3: the REWORKING race's fix passed its gate: it wins (a queue ticket), the race is DECIDED again. */
  private reworkWon(t: TrainRecord, race: RaceRecord, r: TrainResult): void {
    for (const id of race.trainIds) {
      const x = this.find(id);
      if (x && x !== t) this.endRework(x, "FAILED", `race ${race.raceId}: the rework of attempt ${t.attemptId ?? "?"} passed`);
    }
    const reason = clip(`reworked by attempt ${t.attemptId ?? "?"}: ${t.trainId} passed every gate`, 300);
    this.pass(t, { raceOutcome: "WON", reason, summary: r.summary, headSha: r.commitSha ?? t.headSha, score: r.score ?? null });
    this.setRace(race, { state: "DECIDED", winnerTrainId: t.trainId, reason, decidedAt: this.ctx.now });
    this.raceEvent(race, t, `race ${race.raceId} decided again: ${t.trainId} (the rework of the winner) passed`, { winner: t.trainId, outcome: "DECIDED", rework: true });
    this.reworkWait(race.itemId, null);
    this.maybeLand();
  }

  /** §5.3: the REWORKING race's fix was rejected: the next round's slot, or the fallback. Infra keeps the race waiting (R7). */
  private reworkFixFailed(t: TrainRecord, race: RaceRecord, summary: string): void {
    const why = `failed in race: ${summary}`;
    if (isInfraStopped({ summary })) {
      this.ejectKeepingFork(t, why, { raceOutcome: "FAILED", summary: clip500(summary) });
      this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}: its rebased head could not be gated; retry_gates)`);
      return;
    }
    const slot = this.giveSlot(t, "findings");
    if (!slot) {
      this.ejectKeepingFork(t, why, { raceOutcome: "FAILED", summary: clip500(summary) });
      this.abandonRework(race, `the rebased head of attempt ${t.attemptId} was rejected and it has no rework slot left`);
      return;
    }
    const { dueAt, round } = slot.rework!;
    this.ejectKeepingFork(t, reworkReasonText("findings", dueAt, why), { raceOutcome: "REWORK", summary: clip500(summary) });
    this.raceEvent(race, t, `race ${race.raceId} still reworking: the rebased head ${t.trainId} was rejected; attempt ${t.attemptId} has until ${iso(dueAt)} (round ${round})`, { outcome: "REWORKING", reason: "findings", dueAt, round }, "warn");
    this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}, due ${iso(dueAt)})`);
  }

  /**
   * §5.6, the rework fallback: the race is ABANDONED (REWORK → FAILED, a fix in flight is withdrawn), the item goes FAILED
   * "awaiting contributor", which reopens it to any agent's start_attempt. The Queen then releases its base (R6).
   */
  private abandonRework(race: RaceRecord, why: string): void {
    if (race.state === "ABANDONED") return;
    for (const id of race.trainIds) {
      const x = this.find(id);
      if (!x) continue;
      if (x.raceOutcome === "REWORK") this.endRework(x, "FAILED", why);
      else if (isActive(x) && x.raceOutcome === "RACING") this.eject(x, clip500(`withdrawn: race ${race.raceId} abandoned (${why})`), { raceOutcome: "LOST" });
    }
    this.setRace(race, { state: "ABANDONED", reason: clip(`abandoned: ${why}`, 300), decidedAt: this.ctx.now });
    this.raceEvent(race, this.find(race.winnerTrainId ?? ""), `race ${race.raceId} abandoned: ${why}; the item reopens to any agent`, { outcome: "ABANDONED", fallback: true }, "warn");
    this.reworkWait(race.itemId, null);
    this.awaitContributor(race.itemId, `rework fallback: ${why}`);
    this.maybeLand();
  }
```

- [ ] **Step 7: `attemptEnded` (public)**

Next to `withdraw`:

```ts
  /**
   * Rework loop (§5.6): the attempt ended (end_attempt, or the watchdog expired it). Its REWORK candidate leaves its RACING
   * race (FAILED; the race then decides), and a REWORKING race whose winner is this attempt falls back. Its slot closes.
   * Call it after `withdraw` (which handles an active train). `ignored:stale` when it held nothing.
   */
  attemptEnded(attemptId: string, why: string): PlanResult {
    let changed = false;
    for (const race of [...this.races.values()]) {
      if (race.state === "REWORKING") {
        if (this.find(race.winnerTrainId ?? "")?.attemptId !== attemptId) continue;
        this.abandonRework(race, `attempt ${attemptId} ended (${why})`);
        changed = true;
      } else if (race.state === "RACING") {
        const rework = race.trainIds.map((id) => this.find(id)).filter((x): x is TrainRecord => !!x && x.attemptId === attemptId && x.raceOutcome === "REWORK");
        if (!rework.length) continue;
        for (const x of rework) this.endRework(x, "FAILED", `attempt ${attemptId} ended (${why})`);
        this.maybeDecide(race);
        changed = true;
      }
    }
    const s = this.slots.get(attemptId);
    if (s?.rework) {
      this.setSlot({ ...s, rework: null });
      changed = true;
    }
    this.maybeLand();
    return this.finish(changed ? "applied" : "ignored:stale");
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: PASS. If "the fix rejoins the REWORKING race ... takes a queue ticket" fails on `passedSeq`, check that `pass()` ran (`reworkWon`). Do not change `maxQueueDepth`.

- [ ] **Step 9: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`, then `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`.
Expected: PASS / every task successful.

- [ ] **Step 10: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/train/planner.ts apps/queen/test/rework-planner.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): REWORKING races and the rework fallback (planner)

A winner rejected in the train reworks in place; its fix rejoins the race
and wins on PASS. Slot expiry, end of attempt or a spent cap abandon the
race and reopen the item to any agent.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Planner C: human reject (external and swarm hives)

**Model: Opus**, Opus review. Still pure planner.

**Files:**
- Modify: `apps/queen/src/train/rework.ts` (add `checkReject`)
- Modify: `apps/queen/src/train/planner.ts` (`PlanResult.rejected`, new public `reject`, private `rejectSwarm`, `rejectedEvent`; place them after `closeEntries` :2667)
- Modify: `apps/queen/test/rework-harness.ts` (add `settle`, `swarmRace`)
- Test: `apps/queen/test/rework-planner.test.ts` (append)

**Interfaces:**
- Produces:
  - `checkReject(race: Pick<Race, "raceId" | "state" | "trainIds">, target: string, cands: readonly { trainId: string; phase: string; raceOutcome?: string | null }[]): RejectCheck`, where `type RejectCheck = { ok: true; targets: string[] } | { ok: false; status: 409; message: string }`.
  - `TrainPlanner.reject(input: { raceId: string; target: string; by: string; reason: string }): PlanResult`. `target` is a trainId or `"all"`; `by` is `human:<email>`. Refusals come back in `PlanResult.refused` (404 / 409), like `pick`.
  - `PlanResult.rejected?: { fallback: boolean }`.

- [ ] **Step 1: Extend the harness**

Append to `ReworkHive` in `apps/queen/test/rework-harness.ts`:

```ts
  /** Complete every pending FORK and preview DEPLOY (swarm races; pick.test.ts's Hive.settle). */
  settle(): void {
    for (;;) {
      const forks = this.effects.filter((e): e is Extract<Effect, { type: "provision" }> => e.type === "provision" && e.command.op === "FORK");
      const deploys = this.effects.filter((e): e is Extract<Effect, { type: "deploy" }> => e.type === "deploy" && e.command.op === "DEPLOY");
      if (!forks.length && !deploys.length) return;
      this.effects = this.effects.filter((e) => !forks.includes(e as never) && !deploys.includes(e as never));
      for (const f of forks) {
        const c = f.command as Extract<ProvisionCommand, { op: "FORK" }>;
        this.run((p) => p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: "base" }));
      }
      for (const d of deploys) {
        this.run((p) => p.deployResult({ commandId: d.command.commandId, op: "DEPLOY", environment: "preview", trainId: d.trainId, ok: true, url: `https://${d.trainId}.preview` }));
      }
    }
  }

  /** A swarm hive (no rework settings): item A races 3 drone candidates t2, t3, t4 (race t1), all built and live. */
  static swarmRace(): ReworkHive {
    const h = new ReworkHive();
    h.external = false;
    h.rework = undefined;
    h.judge = "human";
    h.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: 3 }));
    h.settle();
    for (const id of ["t2", "t3", "t4"]) h.run((p) => p.buildResult({ trainId: id, headSha: `h-${id}` }));
    h.settle();
    return h;
  }
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/queen/test/rework-planner.test.ts` (add `checkReject` to the `../src/train/rework` import):

```ts
describe("planner: reject with a reason (§7)", () => {
  const BY = "human:k@kaikeru.com";
  /** Judge human: A, B, C all pass → PICKING. */
  function picking() {
    const h = new ReworkHive();
    h.judge = "human";
    const a = h.push(A1);
    const b = h.push(B1);
    const c = h.push(C1);
    h.pass(a);
    h.pass(b);
    h.pass(c);
    expect(h.race().state).toBe("PICKING");
    return { h, a, b, c };
  }
  const reject = (h: ReworkHive, target: string, reason = "the button is unreadable") => h.run((p) => p.reject({ raceId: h.race().raceId, target, by: BY, reason }));

  it("checkReject: PICKING only; one live passed candidate, or all of them", () => {
    const cands = [
      { trainId: "a", phase: "TESTING", raceOutcome: "PASSED" },
      { trainId: "b", phase: "EJECTED", raceOutcome: "FAILED" },
    ];
    expect(checkReject({ raceId: "r", state: "PICKING", trainIds: ["a", "b"] }, "a", cands)).toEqual({ ok: true, targets: ["a"] });
    expect(checkReject({ raceId: "r", state: "PICKING", trainIds: ["a", "b"] }, "all", cands)).toEqual({ ok: true, targets: ["a"] });
    expect(checkReject({ raceId: "r", state: "PICKING", trainIds: ["a", "b"] }, "b", cands)).toMatchObject({ ok: false, status: 409 });
    expect(checkReject({ raceId: "r", state: "RACING", trainIds: ["a", "b"] }, "a", cands)).toMatchObject({ ok: false, status: 409 });
  });

  it("refusals change nothing: unknown race 404, a race not PICKING 409, not a live passed candidate 409", () => {
    const { h, a } = picking();
    expect(h.run((p) => p.reject({ raceId: "nope", target: a, by: BY, reason: "x" })).refused).toMatchObject({ status: 404 });
    const before = JSON.stringify([...h.races.values()]);
    expect(h.run((p) => p.reject({ raceId: h.race().raceId, target: "ghost", by: BY, reason: "x" })).refused).toMatchObject({ status: 409 });
    expect(JSON.stringify([...h.races.values()])).toBe(before);
  });

  it("reject one: REWORK (human), back to RACING (reopens 1); the hold runs to dueAt despite the stale grace clock; then PICKING again", () => {
    const { h, b } = picking();
    const r = reject(h, b);
    expect(r.rejected).toEqual({ fallback: false });
    expect(h.t(b)).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", summary: "rejected by k@kaikeru.com: the button is unreadable" });
    expect(parseReworkReason(h.t(b).reason)).toEqual({ reason: "human", dueAt: h.now + 30 * MIN });
    expect(h.slot(B1)!.rework).toMatchObject({ reason: "human", round: 1 });
    expect(h.race()).toMatchObject({ state: "RACING", reopens: 1, pickDeadlineAt: null, recommendedTrainId: null, deadlineAt: h.now + h.graceMs });
    expect(h.race().rejections).toEqual([{ trainId: b, by: BY, reason: "the button is unreadable" }]);
    expect(h.events.filter((e) => e.type === "race.rejected")).toEqual([expect.objectContaining({ trainId: b, data: expect.objectContaining({ target: b, by: BY, outcome: "REWORK" }) })]);
    h.at(20 * MIN);
    expect(h.race().state).toBe("RACING"); // not 90 s, not 10 min
    h.at(11 * MIN);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.race()).toMatchObject({ state: "PICKING", pickDeadlineAt: h.now + 15 * MIN });
  });

  it("the rejected candidate's fix brings it back; with three passes the race picks again", () => {
    const { h, a, b, c } = picking();
    reject(h, b);
    const fix = h.push(B1, { rejoin: true });
    h.pass(fix);
    expect(h.race().state).toBe("PICKING");
    expect([a, c, fix].every((id) => h.t(id).raceOutcome === "PASSED")).toBe(true);
  });

  it("reject all: every candidate in rework, entries reopen for reworkWindowMs, no auto-pick, no grace deadline", () => {
    const { h, a, b, c } = picking();
    expect(reject(h, "all", "none of these handle an empty cart").rejected).toEqual({ fallback: false });
    for (const id of [a, b, c]) expect(h.t(id).raceOutcome).toBe("REWORK");
    expect(h.race()).toMatchObject({ state: "RACING", reopens: 1, entryClosesAt: h.now + 30 * MIN, pickDeadlineAt: null, deadlineAt: null });
    expect(h.race().rejections).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "race.rejected")).toHaveLength(3);
  });

  it("past maxRaceReopens: reject one is LOST and the race stays PICKING (one pass left → queen:single); reject all falls back", () => {
    const { h, a, b, c } = picking();
    h.rework = { ...h.rework!, maxRaceReopens: 0 };
    reject(h, a);
    expect(h.t(a).raceOutcome).toBe("LOST");
    expect(h.race().state).toBe("PICKING");
    reject(h, b);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: c, decidedBy: "queen:single" });

    const z = picking().h;
    z.rework = { ...z.rework!, maxRaceReopens: 0 };
    expect(reject(z, "all").rejected).toEqual({ fallback: true });
    expect(z.race().state).toBe("ABANDONED");
    expect(z.awaiting).toEqual(["A"]);
  });

  it("a candidate past maxReworksPerAttempt is LOST instead of REWORK; no reopen is used", () => {
    const { h, b } = picking();
    h.slots.set(B1, { attemptId: B1, reworks: 3, rework: null });
    reject(h, b);
    expect(h.t(b).raceOutcome).toBe("LOST");
    expect(h.race().state).toBe("PICKING");
    expect(h.race().reopens ?? 0).toBe(0);
  });

  it("a second reject or a pick of the rejected candidate after a reject is refused (409), nothing changes", () => {
    const { h, b, c } = picking();
    reject(h, b);
    expect(reject(h, c).refused).toMatchObject({ status: 409 });
    expect(h.run((p) => p.pick({ raceId: h.race().raceId, trainId: b, by: BY })).refused).toMatchObject({ status: 409 });
    expect(h.race()).toMatchObject({ state: "RACING", reopens: 1 });
  });

  it("swarm hive (T9b): reject one is LOST (fork deleted, preview down); reject all abandons and reworks with the summary", () => {
    const h = ReworkHive.swarmRace();
    for (const id of ["t2", "t3", "t4"]) h.pass(id);
    expect(h.race()).toMatchObject({ raceId: "t1", state: "PICKING" });
    reject(h, "t2", "ugly");
    expect(h.t("t2")).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST", forkState: "DELETING" });
    expect(h.race().state).toBe("PICKING");
    expect(h.race().reopens ?? 0).toBe(0);

    reject(h, "all", "neither handles an empty cart");
    expect(h.race().state).toBe("ABANDONED");
    expect(h.prompts.get("A")!.summary).toBe("Human rejected all candidates: neither handles an empty cart");
    expect([...h.trains.values()].some((t) => t.action === "REWORK" && t.promptId === "A")).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: FAIL: `checkReject` / `p.reject` do not exist.

- [ ] **Step 4: `checkReject`**

Append to `apps/queen/src/train/rework.ts`:

```ts
export type RejectCheck = { ok: true; targets: string[] } | { ok: false; status: 409; message: string };

/**
 * Who a reject applies to (§7.4): only a PICKING race; a trainId must be a live (not terminal) passed candidate; "all"
 * means every live passed candidate. Otherwise 409 (the route answers it; 404 for an unknown race is the caller's).
 */
export function checkReject(race: Pick<Race, "raceId" | "state" | "trainIds">, target: string, cands: readonly { trainId: string; phase: string; raceOutcome?: string | null }[]): RejectCheck {
  if (race.state !== "PICKING") return { ok: false, status: 409, message: `race ${race.raceId} is ${race.state}, not PICKING` };
  const live = cands.filter((c) => race.trainIds.includes(c.trainId) && c.phase !== "EJECTED" && c.phase !== "MERGED" && c.raceOutcome === "PASSED");
  if (target === "all") return live.length ? { ok: true, targets: live.map((c) => c.trainId) } : { ok: false, status: 409, message: `race ${race.raceId} has no live passed candidate` };
  if (!live.some((c) => c.trainId === target)) return { ok: false, status: 409, message: `train ${target} is not a live passed candidate of race ${race.raceId}` };
  return { ok: true, targets: [target] };
}
```

- [ ] **Step 5: `reject` in the planner**

`planner.ts`: import `checkReject` from `./rework`; add `rejected?: { fallback: boolean };` to `PlanResult`; a field `private rejected: { fallback: boolean } | null = null;`; in `finish()` add `...(this.rejected ? { rejected: this.rejected } : {}),` and reset `this.rejected = null;`. Then, after `closeEntries`:

```ts
  /**
   * `POST /hives/:hive/races/:raceId/reject` (rework-loop spec §7): a human sends candidates of a PICKING race back with a
   * reason. External hives (§7.2): a candidate with a slot left goes to REWORK (reason `human`, preview torn down, fork
   * kept) and the race drops to RACING, using one of its reopens. Reject one holds the race until the slot's dueAt; reject
   * all also reopens entries for reworkWindowMs. Past maxRaceReopens: one is LOST (the race stays PICKING); all is the
   * fallback. Swarm hives (§7.3, T9b): LOST; all → ABANDONED and a REWORK. Refusals in `refused` (404 / 409), nothing changes.
   */
  reject(input: { raceId: string; target: string; by: string; reason: string }): PlanResult {
    const race = this.races.get(input.raceId);
    if (!race) {
      this.refused = { status: 404, message: `race ${input.raceId} not found` };
      return this.finish("ignored:unknown");
    }
    const cands = race.trainIds.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const check = checkReject(race, input.target, cands);
    if (!check.ok) {
      this.refused = { status: check.status, message: check.message };
      return this.finish("ignored:stale");
    }
    const who = input.by.replace(/^human:/, "");
    const reason = clip(input.reason.trim(), 300);
    const why = clip500(`rejected by ${who}: ${reason}`);
    const all = input.target === "all";
    const targets = check.targets.map((id) => this.find(id)!);
    this.setRace(race, { rejections: [...(race.rejections ?? []), ...targets.map((t) => ({ trainId: t.trainId, by: input.by, reason }))].slice(-16) });
    if (!this.ctx.external || !this.ctx.rework) {
      this.rejectSwarm(race, targets, all, why, input.by, reason);
      this.rejected = { fallback: false };
      return this.finish("applied");
    }
    const reopens = race.reopens ?? 0;
    const canReopen = reopens < this.ctx.rework.maxRaceReopens;
    if (all && !canReopen) {
      for (const t of targets) {
        this.eject(t, clip500(`lost race ${race.raceId}: ${why}`), { raceOutcome: "LOST" });
        this.rejectedEvent(race, t, input.by, reason, all, "LOST");
      }
      const cause = clip(`${why} (maxRaceReopens ${this.ctx.rework.maxRaceReopens} reached)`, 280);
      this.setRace(race, { state: "ABANDONED", reason: clip(`abandoned: ${cause}`, 300), decidedAt: this.ctx.now, pickDeadlineAt: null });
      this.raceEvent(race, targets[0], `race ${race.raceId} abandoned: ${cause}; the item reopens to any agent`, { outcome: "ABANDONED", fallback: true, by: input.by }, "warn");
      this.awaitContributor(race.itemId, `rework fallback: ${cause}`);
      this.rejected = { fallback: true };
      this.maybeLand();
      return this.finish("applied");
    }
    let dropped = false;
    for (const t of targets) {
      const slot = canReopen ? this.giveSlot(t, "human") : null;
      if (slot) {
        this.ejectKeepingFork(t, reworkReasonText("human", slot.rework!.dueAt, why), { raceOutcome: "REWORK", summary: why });
        dropped = true;
      } else {
        this.eject(t, clip500(`lost race ${race.raceId}: ${why}`), { raceOutcome: "LOST" });
      }
      this.rejectedEvent(race, t, input.by, reason, all, slot ? "REWORK" : "LOST");
    }
    const back = { state: "RACING" as const, reopens: reopens + 1, pickDeadlineAt: null, recommendedTrainId: null, recommendReason: null };
    if (all) {
      this.setRace(race, { ...back, deadlineAt: null, entryClosesAt: this.ctx.now + this.ctx.rework.windowMs });
      this.maybeDecide(race);
    } else if (dropped) {
      this.setRace(race, { ...back, deadlineAt: this.ctx.now + (this.ctx.raceGraceMs ?? RACE_GRACE_MS) });
      this.maybeDecide(race);
    } else {
      this.maybeDecidePicking(race);
    }
    this.rejected = { fallback: false };
    this.maybeLand();
    return this.finish("applied");
  }

  /** T9b (human-push design §10.4), swarm hives: one → LOST (fork and preview cleaned up); all → ABANDONED and a REWORK. */
  private rejectSwarm(race: RaceRecord, targets: TrainRecord[], all: boolean, why: string, by: string, reason: string): void {
    for (const t of targets) {
      this.eject(t, clip500(`lost race ${race.raceId}: ${why}`), { raceOutcome: "LOST" });
      this.rejectedEvent(race, t, by, reason, all, "LOST");
    }
    if (!all) {
      this.maybeDecidePicking(race);
      this.maybeLand();
      return;
    }
    const summary = clip500(`Human rejected all candidates: ${reason}`);
    this.setRace(race, { state: "ABANDONED", reason: clip(`abandoned: ${why}`, 300), decidedAt: this.ctx.now, pickDeadlineAt: null });
    this.raceEvent(race, targets[0], `race ${race.raceId} abandoned: none of these (${by.replace(/^human:/, "")})`, { outcome: "ABANDONED", by }, "warn");
    const p = this.prompts.get(race.itemId);
    if (p) {
      this.setPromptSummary(p.promptId, summary);
      this.rework(p.promptId, { summary });
    }
    this.maybeLand();
  }

  /** `race.rejected` per rejected candidate (§7.4); the actor is the human. */
  private rejectedEvent(race: RaceRecord, t: TrainRecord, by: string, reason: string, all: boolean, outcome: "REWORK" | "LOST"): void {
    const who = by.replace(/^human:/, "");
    this.events.push({
      type: "race.rejected",
      severity: "warn",
      actor: clip(`user:${who}`, 340),
      traceId: traceOfTrain(t),
      spanId: spanIdFor(race.raceId),
      parentSpanId: spanIdFor(race.itemId),
      itemId: race.itemId,
      trainId: t.trainId,
      summary: clip500(`race ${race.raceId}: ${t.trainId} rejected by ${who} (${outcome === "REWORK" ? "rework" : "lost"}): ${reason}`),
      data: { raceId: race.raceId, trainId: t.trainId, target: all ? "all" : t.trainId, by, reason, model: t.model, outcome },
    });
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @queenos/queen test -- test/rework-planner.test.ts`
Expected: PASS. In the swarm test `forkState` is `"DELETING"` (a drone train's fork is deleted, not kept). If the harness ids differ (`t1` race, `t2`-`t4` trains), check that `newId` is `t${n}` and that `submit` runs first.

- [ ] **Step 7: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`, then `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`.
Expected: PASS / every task successful.

- [ ] **Step 8: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/train/rework.ts apps/queen/src/train/planner.ts apps/queen/test/rework-harness.ts apps/queen/test/rework-planner.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): reject race candidates with a reason (planner)

External hives send rejected candidates back for rework and drop the race
to RACING within maxRaceReopens; swarm hives keep T9b.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: Queen A: slot wiring, alarm deadlines, watchdog, refresh, base release, verdict fix

**Model: Opus** (race / attempt state integration), Opus review. From this task on the rework loop is live in external hives: `decide()` passes `rework` settings.

**Files:**
- Modify: `apps/queen/src/queen-node.ts`: imports; `Acc` (:443-532: `slots`, `reworkWaits`, `train()`); `decide()` (:2775: `HiveState.slots`, `ctx.rework`, the absorb prompt map); `withExtras` (:2970, R13); `syncAttempts` (:1557); `attemptRefresh` (:1436); `releaseBases` (:1646); `attemptDeadline` (:1686); `attemptView` (:1707); `armWatchdog` (:3359); new private `attemptSlots()`
- Modify: `apps/queen/src/work/attempts.ts` (`attemptVerdict` :71, `attemptVerdictKind` :84)
- Modify: `apps/queen/src/work/ledger.ts` (`AbsorbPrompt` :175, absorb loop :806-823)
- Modify: `apps/queen/test/attempt-helpers.ts` (add `conflictCarOf`)
- Create: `apps/queen/test/attempts-rework.test.ts`
- Modify (expectations only, see Step 9): pre-existing `apps/queen/test/attempts*.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3 planner API (`HiveState.slots`, `PlannerContext.rework`, `PlanResult.slots`, `PlanResult.reworkWaits`), `reworkDeadlines`, `AttemptSlot`, `REWORK_EXPIRY_GRACE_MS`.
- Produces:
  - Attempt rows carry `reworks` / `rework`. A newly opened slot sets `expires_at := max(expires_at, dueAt + 10 min)`. Events: `attempt.state` "rework slot N/M (<reason>) until <ISO>" and "rework slot N closed".
  - `AttemptView` adds `rework: AttemptRework | null` (always present from this Queen), `train.conflict`, `race.reopens`; `verdict` / `verdictKind` follow §6.2.
  - `attemptVerdict(t: Pick<TrainRecord, "phase" | "raceOutcome" | "reason"> | null)`; `attemptVerdictKind(t: Pick<TrainRecord, "phase" | "raceOutcome" | "summary" | "reason" | "conflict"> | null, rework?: AttemptRework | null)`.
  - `AbsorbPrompt.reworkWait?: string | null`.
  - `attempt-helpers.ts`: `conflictCarOf(ns: string, memberId: string, paths?: string[]): Promise<string>` (returns the car id).

- [ ] **Step 1: Write the failing tests**

Append to `apps/queen/test/attempt-helpers.ts`:

```ts
/** Play the car of `memberId` up to its MERGE drone, which reports `memberId` conflicting. Returns the car id. */
export async function conflictCarOf(ns: string, memberId: string, paths: string[] = ["src/shared.js"]): Promise<string> {
  const stub = stubFor(ns);
  const carId = String((await trainOf(ns, memberId)).car_id);
  const fork = (await look(ns)).provisions.find((c) => c.op === "FORK" && c.trainId === carId);
  if (fork && fork.op === "FORK") await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: fork.forkName, baseSha: "c".repeat(40) });
  await stub.reportMergeResult({ trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [], conflicts: [{ trainId: memberId, kind: "content", paths, summary: `Merge conflict in ${paths.join(", ")}` }] });
  return carId;
}
```

Create `apps/queen/test/attempts-rework.test.ts`:

```ts
/**
 * Rework loop, the Queen (rework-loop spec §5.1, §5.3, §5.6, §6.2): slots on attempt rows, the alarm's slot deadline, the
 * watchdog leaving a slot alone, refresh, the fresh-base rule (R6), a winner's conflict → REWORKING, and the verdict fix.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INFRA_SUMMARY_PREFIX, REWORK_EXPIRY_GRACE_MS, parseReworkReason, reworkReasonText } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { attemptVerdict, attemptVerdictKind } from "../src/work/attempts";
import { OTHER, agent, conflictCarOf, deletesOf, externalHive, fileItem, gateFail, gatePass, goLive, later, look, readyAttempt, sha, stubFor, trainOf } from "./attempt-helpers";

const MIN = 60_000;
const push = (ns: string, att: { attemptId: string; repo: string }, after = sha(), title = "Add a tip jar") =>
  stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, after, title, message: `${title}\n\nAcceptance:\n- shows a jar` }).then((res) => ({ after, res }));
const own = (ns: string, r: { attemptId: string; agent: { agentId: string; owner: string } }) => ({ hive: ns, attemptId: r.attemptId, owner: r.agent.owner, agentId: r.agent.agentId });

/** Item A raced by two agents (no entry window): A passes, B is rejected on findings. */
async function aPassesBRejected(opts: { guardrails?: Record<string, number> } = {}) {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 }, ...opts });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await goLive(ns, b.trainId);
  await gateFail(ns, b.trainId, "lint: unused variable x");
  return { ns, stub, itemId, a, b };
}

/** One attempt on a fresh item fails its gate alone. */
async function aloneRejected(opts: { guardrails?: Record<string, number>; beforeFail?: (ns: string, a: { attemptId: string }) => Promise<void> } = {}) {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 }, ...(opts.guardrails ? { guardrails: opts.guardrails } : {}) });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  await push(ns, a);
  await goLive(ns, a.trainId);
  if (opts.beforeFail) await opts.beforeFail(ns, a);
  await gateFail(ns, a.trainId);
  return { ns, stub, itemId, a };
}

describe("rework slots on attempt rows (§5.1)", () => {
  it("a findings rejection opens a slot: REJECTED with rework, expires_at extended, the view carries it, the race holds", async () => {
    const { ns, stub, b } = await aPassesBRejected();
    const v = (await stub.getAttempt(b.attemptId))!;
    expect(v).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "findings", reworks: 1, rework: { reason: "findings", round: 1 } });
    expect(v.expiresAt).toBeGreaterThanOrEqual(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
    expect(v.train).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", conflict: null });
    expect(parseReworkReason(v.train!.reason)).toEqual({ reason: "findings", dueAt: v.rework!.dueAt });
    expect(v.race).toMatchObject({ state: "RACING", reopens: 0 });
    expect((await look(ns)).events.some((e) => e.type === "attempt.state" && /rework slot 1\/3 \(findings\) until /.test(e.summary))).toBe(true);
    const due = await runInDurableObject(stubFor(ns), (q: QueenNode) => (q as unknown as { attemptDeadline(t: number): number | null }).attemptDeadline(10 * MIN));
    expect(due).not.toBeNull();
    expect(due!).toBeLessThanOrEqual(v.rework!.dueAt);
  });

  it("the hold ends 10 min after the first pass: B loses (LOST), A wins", async () => {
    const { ns, stub, a, b } = await aPassesBRejected();
    await later(ns, 5 * MIN);
    expect((await stub.getAttempt(b.attemptId))!.state).toBe("REJECTED");
    await later(ns, 5 * MIN + 5_000);
    expect((await stub.getAttempt(b.attemptId))!).toMatchObject({ state: "LOST", verdict: "rejected" });
    expect((await stub.getAttempt(a.attemptId))!.state).toBe("WON");
  });

  it("alone and unfixed: the slot expires at dueAt → race ABANDONED, item FAILED, attempt REJECTED without a slot, base deleted once (R6)", async () => {
    const { ns, stub, itemId, a } = await aloneRejected();
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "ACTIVE", base_repo: a.base.baseRepo });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(0);
    await later(ns, 30 * MIN + 5_000);
    s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED", base_repo: null });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null, reworks: 1 });
  });

  it("the watchdog leaves an open slot alone: a slot opened near the attempt's expiry extends it past dueAt", async () => {
    const { ns, stub, a } = await aloneRejected({
      beforeFail: (n, att) => runInDurableObject(stubFor(n), (q: QueenNode) => void q.sql.exec("UPDATE attempts SET expires_at = ? WHERE attempt_id = ?", Date.now() + 5 * MIN, att.attemptId)),
    });
    const v = (await stub.getAttempt(a.attemptId))!;
    expect(v.expiresAt).toBe(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
    await later(ns, 20 * MIN);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: { reason: "findings" } });
  });

  it("refresh_attempt with an open slot never shortens expires_at: max(now + 2 h, dueAt + 10 min)", async () => {
    const { ns, stub, a } = await aloneRejected({ guardrails: { reworkWindowMs: 7_200_000 } });
    const v = (await stub.getAttempt(a.attemptId))!;
    const r = await stub.attemptRefresh(own(ns, a));
    expect(r.ok && r.attempt.expiresAt).toBe(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
  });

  it("maxReworksPerAttempt 0: no slot, today's path (item FAILED awaiting contributor at once)", async () => {
    const { ns, stub, itemId, a } = await aloneRejected({ guardrails: { maxReworksPerAttempt: 0 } });
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
  });
});

describe("a winner rejected in the train (§5.3)", () => {
  it("a merge conflict: race REWORKING, item ACTIVE awaiting rework, attempt REJECTED (conflict) with the conflicting paths; no new attempts", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await gatePass(ns, a.trainId);
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "WON", car_id: expect.any(String) });
    await conflictCarOf(ns, a.trainId);
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "REWORKING", winner_train_id: a.trainId });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "ACTIVE", wait_reason: expect.stringMatching(/^awaiting rework \(attempt att_[0-9a-f]{12}, due 20\d\d-/) });
    const v = (await stub.getAttempt(a.attemptId))!;
    expect(v).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "conflict", rework: { reason: "conflict", round: 1 } });
    expect(v.train!.conflict).toEqual({ paths: ["src/shared.js"], summary: "Merge conflict in src/shared.js" });
    const other = await stub.attemptIntent({ hive: ns, owner: OTHER, agent: agent({ owner: OTHER }), target: { itemId } });
    expect(other).toMatchObject({ verdict: "refuse", code: "ITEM_NOT_ACCEPTING" });
  });
});

describe("attemptVerdict / attemptVerdictKind (§6.2)", () => {
  it("an ejected winner reads rejected (conflict); REWORK is rejected; a REWORK that lost stays rejected; human from the slot or the reason", () => {
    const conflict = { trainId: "t", kind: "content" as const, paths: ["src/a.js"], summary: "Merge conflict in src/a.js" };
    const human = reworkReasonText("human", 5, "rejected by k@kaikeru.com: ugly");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "WON", reason: "failed: Merge conflict" })).toBe("rejected");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "WON", reason: "x", summary: null, conflict })).toBe("conflict");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x" })).toBe("rejected");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "LOST", reason: human })).toBe("rejected");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "LOST", reason: "lost race r: ranked lower" })).toBe("passed");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: human, summary: null, conflict: null })).toBe("human");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x", summary: null, conflict: null }, { reason: "human", dueAt: 5, round: 1 })).toBe("human");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "FAILED", reason: "x", summary: `${INFRA_SUMMARY_PREFIX}gate`, conflict: null })).toBe("infra");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x", summary: "lint", conflict: null })).toBe("findings");
    expect(attemptVerdict({ phase: "PASSED", raceOutcome: "WON", reason: null })).toBe("passed");
    expect(attemptVerdict({ phase: "MERGED", raceOutcome: "WON", reason: null })).toBe("passed");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/attempts-rework.test.ts`
Expected: FAIL. No slot is opened (`decide` passes no `rework`); `attemptVerdict` reads an ejected WON as passed.

- [ ] **Step 3: The verdict fix (`attempts.ts`)**

Add `parseReworkReason, type AttemptRework` to the queen-types import. Replace `attemptVerdict` and `attemptVerdictKind`:

```ts
/**
 * The gate's word on a train: none (no train yet), pending, passed (incl. a race loser that passed) or rejected.
 * Rework loop §6.2: an ejected train is rejected even when it had won (a merge conflict or an integration failure in its
 * car); a REWORK candidate is rejected; one that lost while in rework keeps its rework reason (R20) and stays rejected.
 */
export function attemptVerdict(t: Pick<TrainRecord, "phase" | "raceOutcome" | "reason"> | null): AttemptVerdict {
  if (!t) return "none";
  if (t.raceOutcome === "FAILED" || t.raceOutcome === "REWORK") return "rejected";
  if (t.raceOutcome === "LOST") return parseReworkReason(t.reason) ? "rejected" : "passed";
  if (t.phase === "EJECTED") return "rejected";
  if (t.raceOutcome === "PASSED" || t.raceOutcome === "WON") return "passed";
  if (t.phase === "PASSED" || t.phase === "LANDING" || t.phase === "MERGED") return "passed";
  return "pending";
}

/**
 * Why a rejected train was rejected: `infra` (INFRA_SUMMARY_PREFIX: the gate could not run), `conflict` (a merge conflict
 * ejected it from its car), `human` (a judge's reject: the open slot's reason, or the train's rework reason text, R10),
 * else `findings`. Null unless rejected.
 */
export function attemptVerdictKind(t: Pick<TrainRecord, "phase" | "raceOutcome" | "summary" | "reason" | "conflict"> | null, rework?: AttemptRework | null): AttemptVerdictKind | null {
  if (attemptVerdict(t) !== "rejected") return null;
  if (isInfraStopped({ summary: t!.summary })) return "infra";
  if (t!.conflict) return "conflict";
  if (rework?.reason === "human" || parseReworkReason(t!.reason)?.reason === "human") return "human";
  return "findings";
}
```

- [ ] **Step 4: The ledger takes the REWORKING wait reason**

`apps/queen/src/work/ledger.ts`, `AbsorbPrompt` (after `awaiting`):

```ts
  /** Rework loop: the item's REWORKING wait reason (`awaiting rework (...)`); null clears one the loop set. */
  reworkWait?: string | null;
```

In `absorb`, inside `for (const p of input.prompts ?? [])`, right before `if (p.status === "MERGED")`:

```ts
      if (p.reworkWait !== undefined) {
        if (p.reworkWait !== null) this.setWait(item, p.reworkWait);
        else if (item.waitReason?.startsWith("awaiting rework")) {
          item.waitReason = null;
          this.markItem(item);
        }
      }
```

- [ ] **Step 5: Wire slots through `decide()` (`queen-node.ts`)**

Imports: add `RACE_GRACE_MS, REWORK_EXPIRY_GRACE_MS, type ReworkReason` to the queen-types import, and `import { iso, reworkDeadlines, type AttemptSlot } from "./train/rework";`.

`Acc`: fields

```ts
  /** Rework loop: attempt slots the planner changed (applied to attempt rows in syncAttempts). */
  slots = new Map<string, AttemptSlot>();
  /** Rework loop: REWORKING wait reasons per item (null clears). */
  reworkWaits = new Map<string, string | null>();
```

and in `train(r)`:

```ts
    for (const s of r.slots) this.slots.set(s.attemptId, s);
    for (const w of r.reworkWaits) this.reworkWaits.set(w.itemId, w.waitReason);
```

New private reader (attempts section):

```ts
  /** v19: the slots of the hive's open attempts (the planner's HiveState.slots). */
  private attemptSlots(): AttemptSlot[] {
    return this.sql
      .exec(`SELECT attempt_id, reworks, rework_reason, rework_due_at FROM attempts WHERE state IN (${OPEN_ATTEMPTS_SQL}) AND (reworks > 0 OR rework_due_at IS NOT NULL)`)
      .toArray()
      .map((r) => ({
        attemptId: String(r.attempt_id),
        reworks: Number(r.reworks ?? 0),
        rework:
          r.rework_due_at === null || r.rework_due_at === undefined
            ? null
            : { reason: String(r.rework_reason) as ReworkReason, dueAt: Number(r.rework_due_at), round: Number(r.reworks ?? 0) },
      }));
  }
```

In `decide()`: add `slots: this.attemptSlots(),` to `hiveState`. Add to the `TrainPlanner` context:

```ts
      // Rework loop (rework-loop spec §5.5): external hives only; swarm hives keep today's rejections.
      ...(external ? { rework: { windowMs: g.reworkWindowMs, holdMs: g.reworkHoldMs, maxPerAttempt: g.maxReworksPerAttempt, maxRaceReopens: g.maxRaceReopens } } : {}),
```

In the absorb `prompts` map add:

```ts
        ...(acc.reworkWaits.has(p.promptId) ? { reworkWait: acc.reworkWaits.get(p.promptId)! } : {}),
```

`withExtras` (R13). After the `wantRaces` block and before `if (races.length) {`:

```ts
    // Rework loop (R13): a DECIDED race whose winner (an attempt's train) is still active, so a car conflict can move it to REWORKING.
    const wonRaceIds = [...new Set([...trains.values()].filter((t) => t.attemptId && t.raceOutcome === "WON" && isActive(t) && t.raceId).map((t) => t.raceId!))].filter((id) => !races.some((r) => r.raceId === id));
    if (wonRaceIds.length) {
      const extra = this.sql.exec(`SELECT * FROM races WHERE race_id IN (${wonRaceIds.map(() => "?").join(",")})`, ...wonRaceIds).toArray().map(rowToRace);
      if (extra.length) {
        races = [...races, ...extra];
        changed = true;
      }
    }
```

- [ ] **Step 6: Slots onto attempt rows (`syncAttempts`), the view, refresh**

At the top of `syncAttempts(d)`:

```ts
    // Rework loop: the planner's slot changes land on the attempt rows first. A new slot extends expires_at to at least
    // dueAt + REWORK_EXPIRY_GRACE_MS, so the watchdog never expires an attempt mid-slot (§5.1).
    for (const s of d.acc.slots.values()) {
      const a = this.attemptOf(s.attemptId, d.acc);
      if (!a) continue;
      const prev = a.rework ?? null;
      const opened = !!s.rework && (!prev || prev.round !== s.rework.round);
      const next: Attempt = { ...a, reworks: s.reworks, rework: s.rework, ...(opened ? { expiresAt: Math.max(a.expiresAt, s.rework!.dueAt + REWORK_EXPIRY_GRACE_MS) } : {}) };
      d.acc.attempts.set(a.attemptId, next);
      if (opened) {
        const r = s.rework!;
        d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: rework slot ${r.round}/${d.hs.guardrails.maxReworksPerAttempt} (${r.reason}) until ${iso(r.dueAt)}`, { rework: r, expiresAt: next.expiresAt }, "queen", "warn"));
      } else if (prev && !s.rework) {
        d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: rework slot ${prev.round} closed`, { reworkClosed: prev }, "queen"));
      }
    }
```

`attemptView`: in the returned object add `rework: a.rework ?? null,` (after `...a`). Add to the `train` object `conflict: t.conflict ? { paths: [...t.conflict.paths], summary: t.conflict.summary } : null,`. Make the `race` object `{ raceId: race.raceId, state: race.state, entryClosesAt: race.entryClosesAt ?? null, winnerTrainId: race.winnerTrainId, reopens: race.reopens ?? 0 }`. Change `verdictKind` to `attemptVerdictKind(t, a.rework ?? null)`.

`attemptRefresh`: replace the `next` line:

```ts
    // A refresh never shortens an open slot's protection (§5.1): max(now + 2 h, dueAt + 10 min).
    const floor = a!.rework ? a!.rework.dueAt + REWORK_EXPIRY_GRACE_MS : 0;
    const next: Attempt = { ...a!, expiresAt: Math.max(this.now() + ATTEMPT_TTL_MS, floor) };
```

- [ ] **Step 7: Alarm deadlines and base release**

`attemptDeadline`: add a line to the `UNION ALL` list:

```sql
           UNION ALL SELECT MIN(rework_due_at) AS t FROM attempts WHERE rework_due_at IS NOT NULL AND state IN (${OPEN_ATTEMPTS_SQL})
```

(Make the SQL string a template literal: it already interpolates nothing, so switch the quotes.)

`armWatchdog`: after the `deadlines` array is built, add the REWORK hold ends (§12 review focus):

```ts
    const slots = this.attemptSlots();
    if (slots.some((s) => s.rework)) {
      // REWORK candidates are EJECTED, so the warm state does not hold them: read the RACING races' candidates.
      const racing = state.races.filter((r) => r.state === "RACING");
      const trains = this.loadTrains(racing.flatMap((r) => r.trainIds));
      const holdMs = effectiveSettings(state.settings, now).guardrails.reworkHoldMs;
      deadlines.push(...reworkDeadlines({ races: racing, trains, slots, holdMs, graceMs: RACE_GRACE_MS, now }));
    }
```

(`deadlines` is a `const` array of `number | null`; `push` is fine.)

`releaseBases`: replace the per-item body after `const cancelled = ...`:

```ts
      const nonTerminal = this.attemptsOfItemNow(itemId, d.acc).filter((a) => !isTerminalAttemptState(a.state));
      const races = new Map(this.sql.exec("SELECT * FROM races WHERE item_id = ?", itemId).toArray().map((r) => [String(r.race_id), rowToRace(r)] as const));
      for (const r of d.acc.races.values()) if (r.itemId === itemId) races.set(r.raceId, r);
      const itemRaces = [...races.values()].sort((x, y) => x.createdAt - y.createdAt);
      const openRace = itemRaces.some((r) => r.state === "RACING" || r.state === "PICKING" || r.state === "REWORKING");
      // R6 (§5.6.3): after a fallback (newest race ABANDONED, none open) a REJECTED attempt without an open slot never forks
      // from the base again, so it does not hold it: the next start_attempt forks a fresh base from current main.
      const fallback = !openRace && itemRaces.at(-1)?.state === "ABANDONED";
      const holders = nonTerminal.filter((a) => !(fallback && a.state === "REJECTED" && !a.rework));
      if (cancelled) {
        for (const a of nonTerminal) {
          // ... the existing ABANDONED-on-cancel body, unchanged
        }
        if (!b?.baseRepo || !b.baseSha) continue;
      } else {
        if (!b?.baseRepo || !b.baseSha) continue;
        if (holders.length || openRace) continue;
      }
```

Update its doc comment: "... or none of its attempts holds it (R6) and it has no RACING / PICKING / REWORKING race."

- [ ] **Step 8: Run the new tests**

Run: `pnpm --filter @queenos/queen test -- test/attempts-rework.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 9: Run the whole Queen suite and re-baseline the pre-rework attempt tests**

Run: `pnpm --filter @queenos/queen test`
Expected: some pre-existing attempt tests fail, because external hives now open slots. Fix each one as follows, and nothing else:
- A test whose subject is not the rework loop and that asserts today's rejection path (for example "item FAILED awaiting contributor after a rejection", "a re-push reopens the item", the T2/T3/T4 ledger gaps in `attempts-infra.test.ts`): add `guardrails: { maxReworksPerAttempt: 0 }` to its `externalHive(...)` call. With 0 slots the planner follows exactly the old path.
- A test that asserts *when* a base is deleted after a lone rejection (`attempts-watchdog.test.ts`, "base deleted exactly once"): the delete now happens at the fallback (R6, spec §5.6.3), not at the attempt's expiry. Move the assertion to the decision that abandons the race, and keep "exactly once".
- A test that compares a whole `AttemptView` with `toEqual` gains `rework: null`, `train.conflict: null` and `race.reopens: 0` (the view now always carries them).
- An infra test (`kind: "infra"`) must keep passing **unchanged**: infra never opens a slot. If one fails, that is a bug in Task 2's `isInfraStopped` guard. Fix the code, not the test.
List every test you changed in the commit message body.

Then: `pnpm --filter @queenos/queen typecheck`. Expected: PASS.

- [ ] **Step 10: Full gate**

Run: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`. Expected: every task successful.

- [ ] **Step 11: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/queen-node.ts apps/queen/src/work/attempts.ts apps/queen/src/work/ledger.ts apps/queen/test/attempt-helpers.ts apps/queen/test/attempts-rework.test.ts
# plus every pre-existing test file changed in Step 9, by path
git commit -m "$(cat <<'MSG'
feat(queen): rework slots on attempts, alarm deadlines, verdict fix

External hives give a rejected attempt a rework slot: the slot lands on the
attempt row (expires_at extended), the alarm wakes at dueAt and hold ends,
refresh never shortens it, a fallback releases the base, and an ejected
winner now reads rejected (kind conflict).

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: Queen B: push routing, REWORKING end to end, `retry_gates`, `end_attempt`, expiry

**Model: Opus**, Opus review.

**Files:**
- Modify: `apps/queen/src/queen-node.ts`: `attemptPushed` (:1222-1262), `enterAttemptHead` (:1271-1384, the `rejoinRaceId` parameter), `attemptRegate` (:1392-1434), `attemptEnd` (:1457-1486), `attemptWatchdog` (:1579-1613); new private `reworkRejoin`
- Create: `apps/queen/test/attempts-rework-flow.test.ts`

**Interfaces:**
- Consumes: `TrainPlanner.attemptEnded`, `pushed({rejoin})` closing slots (Task 3), the Task 5 wiring.
- Produces:
  - `enterAttemptHead(hive, a, head, mode, rejoin?: { raceId: string; supersede?: string })` (was `rejoinRaceId?: string`).
  - `private reworkRejoin(a: Attempt, now: number): { raceId: string; supersede?: string } | null`: a push inside an open slot rejoins the attempt's RACING / REWORKING race. A push while the attempt's pending fix is still being gated (R4) rejoins and supersedes it. Anything else goes through normal intake.

- [ ] **Step 1: Write the failing tests**

`apps/queen/test/attempts-rework-flow.test.ts`:

```ts
/**
 * Rework loop end to end through the QueenNode DO (rework-loop spec §5.1-§5.3, §5.6; Review Focus 1-3): the slot push
 * rejoins its race (after entry close, in REWORKING), a second push supersedes in place, late and replayed pushes,
 * retry_gates on a REWORKING fix, end_attempt and expiry fall back once, and a fresh base afterwards.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueenNode } from "../src/queen-node";
import { MAX_GATE_INFRA_ROUNDS } from "../src/train/planner";
import { OTHER, agent, conflictCarOf, deletesOf, externalHive, fileItem, gateFail, gateInfra, gatePass, goLive, landCarOf, later, look, readyAttempt, sha, stubFor, trainOf } from "./attempt-helpers";

const MIN = 60_000;
const push = (ns: string, att: { attemptId: string; repo: string }, after = sha(), title = "Add a tip jar") =>
  stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, after, title, message: `${title}\n\nAcceptance:\n- shows a jar` }).then((res) => ({ after, res }));
const own = (ns: string, r: { attemptId: string; agent: { agentId: string; owner: string } }) => ({ hive: ns, attemptId: r.attemptId, owner: r.agent.owner, agentId: r.agent.agentId });
/** Move the Queen's clock without running the alarm (a late alarm). */
const skew = (ns: string, ms: number) => runInDurableObject(stubFor(ns), (q: QueenNode) => void ((q as unknown as { clockOffset: number }).clockOffset += ms));

/** One attempt wins item A alone (no entry window) and boards a car; then its car conflicts. */
async function reworking() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  await push(ns, a);
  await gatePass(ns, a.trainId);
  await conflictCarOf(ns, a.trainId);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
  return { ns, stub, itemId, a, raceId };
}

/** A and B race item A with a 15 min entry window: A passes, B is rejected (REWORK); the clock is moved past the close. */
async function reworkAfterClose() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * MIN } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await goLive(ns, b.trainId);
  await gateFail(ns, b.trainId);
  await later(ns, 16 * MIN);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  return { ns, stub, itemId, a, b, raceId };
}

describe("the winner's rework: conflict → REWORKING → fix → WON → LANDED (§5.3)", () => {
  it("the fix push rejoins the same race (no new race, no window), is gated, wins and lands", async () => {
    const { ns, stub, itemId, a, raceId } = await reworking();
    const { res } = await push(ns, a);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    const fix = res.trainId!;
    expect(await trainOf(ns, fix)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect((await look(ns)).races).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "PUSHED", rework: null, reworks: 1 });
    await gatePass(ns, fix);
    expect(await trainOf(ns, fix)).toMatchObject({ race_outcome: "WON" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "DECIDED", winner_train_id: fix });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.wait_reason).toBeNull();
    await landCarOf(ns, fix);
    expect((await stub.getAttempt(a.attemptId))!.state).toBe("LANDED");
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.status).toBe("LANDED");
  });

  it("an integration-gate failure of the winner reworks it too (kind findings)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await gatePass(ns, a.trainId);
    const carId = String((await trainOf(ns, a.trainId)).car_id);
    const fork = (await look(ns)).provisions.find((c) => c.op === "FORK" && c.trainId === carId);
    if (fork && fork.op === "FORK") await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: fork.forkName, baseSha: "c".repeat(40) });
    await stub.reportMergeResult({ trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [a.trainId], fastForward: false });
    await goLive(ns, carId);
    await stub.reportTrainResult({ trainId: carId, passed: false, summary: "integration: smoke /tip failed" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "findings", rework: { reason: "findings" } });
  });

  it("REWORKING slot expiry falls back: ABANDONED, item FAILED, base deleted once; a new agent gets a fresh base and a new race while the old teardown is still out", async () => {
    const { ns, stub, itemId, a } = await reworking();
    await later(ns, 30 * MIN + 5_000);
    let s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED", base_repo: null });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null });
    expect(s.deploys.some((c) => c.op === "TEARDOWN" && c.trainId === a.trainId)).toBe(true);
    const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
    expect(b.base.kind).toBe("create");
    expect(b.base.baseRepo).not.toBe(a.base.baseRepo);
    await push(ns, b);
    s = await look(ns);
    expect(s.races).toHaveLength(2);
    expect(s.races.at(-1)).toMatchObject({ state: "RACING" });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
  });

  it("end_attempt while the fix is gated in a REWORKING race falls back once; a second end_attempt is a no-op", async () => {
    const { ns, stub, itemId, a } = await reworking();
    const { res } = await push(ns, a);
    await goLive(ns, res.trainId!);
    const r = await stub.attemptEnd(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.attemptEnd(own(ns, a))).toMatchObject({ ok: true, changed: false });
    expect(deletesOf((await look(ns)).provisions, a.base.baseRepo)).toHaveLength(1);
  });

  it("retry_gates on an infra-stopped fix rejoins the REWORKING race (R7)", async () => {
    const { ns, stub, a, raceId } = await reworking();
    const { res } = await push(ns, a);
    const fix = res.trainId!;
    await goLive(ns, fix);
    for (let i = 0; i <= MAX_GATE_INFRA_ROUNDS; i++) await gateInfra(ns, fix);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
    const r = await stub.attemptRegate(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(await trainOf(ns, r.ok ? r.attempt.trainId : "")).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
  });

  it("the watchdog expiring an attempt whose infra-stopped fix holds a REWORKING race falls back", async () => {
    const { ns, a } = await reworking();
    const { res } = await push(ns, a);
    await goLive(ns, res.trainId!);
    for (let i = 0; i <= MAX_GATE_INFRA_ROUNDS; i++) await gateInfra(ns, res.trainId!);
    await later(ns, 3 * 60 * MIN);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "ABANDONED" });
  });
});

describe("the slot fix in a RACING race (§5.1, §5.2; Review Focus 1, 2)", () => {
  it("the fix rejoins after entry close as the same candidate: no follow-up item, the old train FAILED, the slot closed", async () => {
    const { ns, stub, b, raceId } = await reworkAfterClose();
    const items = (await look(ns)).items.length;
    const { res } = await push(ns, b);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    expect(await trainOf(ns, res.trainId!)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect(await trainOf(ns, b.trainId)).toMatchObject({ race_outcome: "FAILED" });
    expect((await look(ns)).items).toHaveLength(items);
    expect(await stub.getAttempt(b.attemptId)).toMatchObject({ state: "PUSHED", rework: null, reworks: 1 });
  });

  it("a second push before the fix's verdict supersedes it in place (R4): no follow-up, no second slot", async () => {
    const { ns, stub, b, raceId } = await reworkAfterClose();
    const first = (await push(ns, b)).res.trainId!;
    const items = (await look(ns)).items.length;
    const { res } = await push(ns, b);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    expect(await trainOf(ns, first)).toMatchObject({ phase: "EJECTED", race_outcome: "LOST" });
    expect(await trainOf(ns, res.trainId!)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect((await look(ns)).items).toHaveLength(items);
    expect((await stub.getAttempt(b.attemptId))!.reworks).toBe(1);
  });

  it("a replayed slot push is a duplicate: one train, one closed slot", async () => {
    const { ns, stub, b } = await reworkAfterClose();
    const after = sha();
    const first = await push(ns, b, after);
    const again = await push(ns, b, after);
    expect(again.res).toMatchObject({ outcome: "duplicate", trainId: first.res.trainId });
    expect((await stub.getAttempt(b.attemptId))!.reworks).toBe(1);
  });

  it("a push after dueAt is a late push even before the alarm ran: normal intake (a follow-up), never the old slot's candidate", async () => {
    const { ns, b, raceId } = await reworkAfterClose();
    await skew(ns, 15 * MIN); // t0 + 31 min, past dueAt (t0 + 30 min); no alarm
    const { res } = await push(ns, b);
    expect(res.disposition).toBe("late-new-item");
    const race = (await look(ns)).races.find((r) => r.race_id === raceId)!;
    expect(JSON.parse(String(race.train_ids))).not.toContain(res.trainId);
  });

  it("a slot fix pushed before dueAt survives the expiry alarm (Review Focus 1)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    await later(ns, 29 * MIN);
    const { res } = await push(ns, a);
    await later(ns, 2 * MIN);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "PUSHED", trainId: res.trainId });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "RACING" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/attempts-rework-flow.test.ts`
Expected: FAIL. The fix push goes through intake ("already being built" / a follow-up) instead of rejoining; `end_attempt` leaves REWORKING.

- [ ] **Step 3: `reworkRejoin` and the push route**

New private method (attempts helpers section):

```ts
  /**
   * Rework loop: where an attempt's push re-enters without intake. Inside an open slot (dueAt still ahead), its own RACING
   * or REWORKING race: the same candidate, never a follow-up (§5.1, §5.2, §5.3). While its slot's fix is still pending
   * (R4: reworks > 0, its current train an active unboarded RACING candidate of that race), the same race, superseding
   * that fix in place. Otherwise null: normal intake (a late push after dueAt included, §5.1).
   */
  private reworkRejoin(a: Attempt, now: number): { raceId: string; supersede?: string } | null {
    if (!a.raceId) return null;
    const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", a.raceId).toArray()[0];
    const race = row ? rowToRace(row) : null;
    if (!race || (race.state !== "RACING" && race.state !== "REWORKING")) return null;
    if (a.rework && a.rework.dueAt > now) return { raceId: race.raceId };
    const t = this.trainExists(a.trainId) ? this.loadTrain(a.trainId) : null;
    if ((a.reworks ?? 0) > 0 && t && isActive(t) && t.raceId === race.raceId && t.raceOutcome === "RACING" && !t.carId) return { raceId: race.raceId, supersede: t.trainId };
    return null;
  }
```

`attemptPushed`, replace the `enterAttemptHead` call:

```ts
    const entered = await this.enterAttemptHead(hive, a, { after: p.after, before: p.before ?? null, title: p.title, message: p.message }, "push", this.reworkRejoin(a, this.now()) ?? undefined);
```

`enterAttemptHead`: rename the last parameter and update its doc comment:

```ts
    /**
     * Re-enter this RACING / REWORKING race without intake: a re-gate (the previous train is its candidate), a rework slot's
     * fix, or (R4) a re-push of a pending fix, which `supersede`s that fix in place. The entry window may have closed: not
     * a new entry.
     */
    rejoin?: { raceId: string; supersede?: string },
```

and the plan:

```ts
    const plan: IntakePlan = rejoin
      ? { disposition: "joined-race", itemId: a.itemId, reopen: false, race: { join: rejoin.raceId }, messages: [], ...(rejoin.supersede ? { supersedeTrainId: rejoin.supersede } : {}) }
      : decideIntake(
          { ref, headSha: head.after, title: head.title, message: head.message, trailers: trailersOf(head.message, {}), newItemId: crypto.randomUUID() },
          { now, lookup: this.intakeLookup({ state: this.activeState() }), previousOnRef: previous },
        );
```

and in the `tp.pushed` call: `...(rejoin ? { rejoin: true as const } : {}),`.

- [ ] **Step 4: `retry_gates` rejoins a REWORKING race; `end_attempt` and the watchdog end the attempt's rework**

`attemptRegate`: after the `if (intakeItem?.racing) {...}` block:

```ts
    // Rework loop (R7): an infra-stopped fix of a REWORKING race re-enters that race (no intake: the item is ACTIVE).
    if (!rejoin && att.raceId) {
      const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", att.raceId).toArray()[0];
      const r = row ? rowToRace(row) : null;
      if (r && r.state === "REWORKING" && r.trainIds.includes(att.trainId)) rejoin = r.raceId;
    }
```

and its call: `this.enterAttemptHead(hive, att, {...}, "regate", rejoin ? { raceId: rejoin } : undefined)`.

`attemptEnd`, inside the decide callback:

```ts
        if (t) {
          if (isActive(t)) d.acc.train(d.tp.withdraw(t.trainId, `${att.agentName} ended attempt ${att.attemptId}`));
          // Rework loop (§5.6): an open slot closes; a REWORK candidate leaves its race; a REWORKING race falls back.
          d.acc.train(d.tp.attemptEnded(att.attemptId, "ended by the agent"));
          d.acc.train(d.tp.deleteAttemptFork(t.trainId));
        } else if (att.state !== "INTENT") {
```

`attemptWatchdog`, in the expiry loop:

```ts
      if (a.state === "INTENT") this.repoDelete(d, a.attemptId, a.repo, null);
      else {
        d.acc.train(d.tp.attemptEnded(a.attemptId, "attempt expired"));
        this.deleteAttemptRepo(d, a);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @queenos/queen test -- test/attempts-rework-flow.test.ts`
Expected: PASS (11 tests).

If "the fix push rejoins the same race" fails because the fix never boards a car in `landCarOf`, check that `reworkWon` ran (`race_outcome: "WON"`, `passed_seq` set). The queue forms the car on the next `maybeLand`.

- [ ] **Step 6: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`, then `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`.
Expected: PASS / every task successful.

- [ ] **Step 7: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/queen-node.ts apps/queen/test/attempts-rework-flow.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): route rework pushes into their own race

A push inside a rework slot rejoins the attempt's RACING or REWORKING race
as the same candidate; a re-push of a pending fix supersedes it in place;
late pushes take normal intake. retry_gates rejoins a REWORKING race, and
end_attempt or expiry runs the fallback once.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Queen C: `attemptSyncBase`, `rejectRace` RPC and route, note bodies

**Model: Sonnet** (Opus review of `rejectRace`). **Gate:** the `attemptSyncBase` half (Steps 1-4) waits for C1 PASS. If C1 failed, skip it, do Steps 5-12, and say so in the commit body.

**Files:**
- Modify: `apps/queen/src/queen-node.ts` (new RPCs `attemptSyncBase` next to `attemptRegate`, `rejectRace` next to `pick` :745; `notesInput` :1811 adds `attemptId`)
- Modify: `apps/queen/src/index.ts` (route after `/races/:raceId/pick` :177)
- Modify: `apps/queen/src/work/notes.ts` (`NotesTrain.attemptId`, the `next` body, a human-reject branch, the conflict body)
- Create: `apps/queen/test/attempts-sync-reject.test.ts`
- Test: `apps/queen/test/notes.test.ts` (append)

**Interfaces:**
- Consumes: `AttemptSyncBaseSchema`, `RejectRaceSchema`, `RejectRaceResult`, `parseReworkReason` (Task 1); `TrainPlanner.reject` (Task 4).
- Produces:
  - `QueenNode.attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult>`. Allowed in READY, or REJECTED with an open slot (`rework.dueAt > now`). Otherwise `CONFLICT`; terminal is `ATTEMPT_EXPIRED`; another agent is `FORBIDDEN_OWNER`. It records `base_sha` only (the item's base is untouched). Event `attempt.state` with `data.syncBase: true`. The same sha again is `changed: false`.
  - `QueenNode.rejectRace(input: { hive: string; raceId: string; user: string; reject: RejectRace }): Promise<RejectRaceResult>`. Errors are `QueenError` `NOT_FOUND` / `CONFLICT` / `INVALID_INPUT`, like `pick`.
  - `POST /hives/:hive/races/:raceId/reject`: a user route (401 without `x-queen-user`), 400 on a bad body.
  - `NotesTrain.attemptId?: string | null`.

- [ ] **Step 1 (C1-gated): Write the failing `attemptSyncBase` tests**

`apps/queen/test/attempts-sync-reject.test.ts`:

```ts
/** Rework loop: attemptSyncBase (rework-loop spec §6.1) and rejectRace + its route (§7.4). */
import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueenNode } from "../src/queen-node";
import { BASE_SHA, OTHER, OWNER, agent, externalHive, fileItem, gateFail, gatePass, goLive, look, readyAttempt, rpcError, sha, stubFor } from "./attempt-helpers";

const push = (ns: string, att: { attemptId: string; repo: string }, after = sha(), title = "Add a tip jar") =>
  stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, after, title, message: `${title}\n\nAcceptance:\n- shows a jar` }).then((res) => ({ after, res }));
const own = (ns: string, r: { attemptId: string; agent: { agentId: string; owner: string } }) => ({ hive: ns, attemptId: r.attemptId, owner: r.agent.owner, agentId: r.agent.agentId });
const baseOfTrain = (ns: string, trainId: string) => runInDurableObject(stubFor(ns), (q: QueenNode) => String(q.sql.exec("SELECT base_sha FROM merge_trains WHERE train_id = ?", trainId).one().base_sha));
const MAIN = "e".repeat(40);

describe("attemptSyncBase (§6.1)", () => {
  it("READY: records the attempt's base (the item's base untouched); the next push is gated against it; PUSHED is CONFLICT", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: true, attempt: { state: "READY", baseSha: MAIN } });
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: false });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.base_sha).toBe(BASE_SHA);
    expect((await look(ns)).events.some((e) => e.type === "attempt.state" && (JSON.parse(e.data ?? "null") as { syncBase?: boolean } | null)?.syncBase === true)).toBe(true);
    const { res } = await push(ns, a);
    expect(await baseOfTrain(ns, res.trainId!)).toBe(MAIN);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: "f".repeat(40) })).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("REJECTED with an open slot is allowed; without one it is CONFLICT; another agent FORBIDDEN_OWNER; terminal ATTEMPT_EXPIRED", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: true });
    expect(await stub.attemptSyncBase({ ...own(ns, a), agentId: agent().agentId, baseSha: MAIN })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });
    await stub.attemptEnd(own(ns, a));
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: false, code: "ATTEMPT_EXPIRED" });

    const z = await externalHive({ race: { entryWindowMs: 0 }, guardrails: { maxReworksPerAttempt: 0 } });
    const zi = await fileItem(z.ns);
    const za = await readyAttempt(z.ns, zi);
    await push(z.ns, za);
    await goLive(z.ns, za.trainId);
    await gateFail(z.ns, za.trainId);
    expect(await z.stub.attemptSyncBase({ ...own(z.ns, za), baseSha: MAIN })).toMatchObject({ ok: false, code: "CONFLICT" });
  });
});
```

- [ ] **Step 2 (C1-gated): Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/attempts-sync-reject.test.ts`
Expected: FAIL: `stub.attemptSyncBase is not a function`.

- [ ] **Step 3 (C1-gated): Implement `attemptSyncBase`**

Import `AttemptSyncBaseSchema, type AttemptSyncBase` from queen-types. Add after `attemptRegate`:

```ts
  /**
   * `sync_base` (rework-loop spec §6.1): record hive main's sha (queenos-mcp read it from Artifacts; the Queen has no
   * Artifacts binding) as the attempt's base. The gates and the reviewer diff its next push against it; the item's shared
   * base is untouched. Only READY, or REJECTED with an open rework slot: anything else is CONFLICT.
   */
  async attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult> {
    const r = parseOrThrow(AttemptSyncBaseSchema, input, "attempt sync base");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    const refused = this.ownerRefusal(a, r);
    if (refused) return refused;
    const att = a!;
    const slotOpen = !!att.rework && att.rework.dueAt > this.now();
    if (att.state !== "READY" && !(att.state === "REJECTED" && slotOpen)) {
      const why = att.state === "REJECTED" ? "REJECTED with no open rework slot" : att.state;
      return { ok: false, code: "CONFLICT", message: clip(`attempt ${att.attemptId} is ${why}; sync_base needs READY or an open rework slot`, 200) };
    }
    if (att.baseSha === r.baseSha) return { ok: true, attempt: this.attemptView(att), changed: false };
    const next: Attempt = { ...att, baseSha: r.baseSha };
    const { acc } = this.decide(hive, (d) => {
      d.acc.attempts.set(att.attemptId, next);
      d.acc.events.push(
        this.attemptEvent("attempt.state", att.itemId, att.attemptId, `attempt ${att.attemptId}: base synced to main@${short(r.baseSha)}`, { syncBase: true, from: att.baseSha, to: r.baseSha }, `agent:${att.agentName}@${att.owner}`),
      );
    });
    await this.commit(hive, acc);
    return { ok: true, attempt: this.attemptView(next), changed: true };
  }
```

- [ ] **Step 4 (C1-gated): Run the sync tests**

Run: `pnpm --filter @queenos/queen test -- test/attempts-sync-reject.test.ts -t "attemptSyncBase"`
Expected: PASS.

- [ ] **Step 5: Write the failing `rejectRace` tests**

Append to `apps/queen/test/attempts-sync-reject.test.ts`:

```ts
const worker = exports.default;
const rejectRoute = (hive: string, raceId: string, body: unknown, user?: string) =>
  worker.fetch(`http://queen.test/hives/${hive}/races/${raceId}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user === undefined ? {} : { "x-queen-user": user }) },
    body: JSON.stringify(body),
  });

/** Judge human, two agents pass: the race is PICKING. */
async function pickingRace() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0, judge: "human" } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await gatePass(ns, b.trainId);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  expect((await look(ns)).races.at(-1)).toMatchObject({ state: "PICKING" });
  return { ns, stub, itemId, a, b, raceId };
}

describe("rejectRace (§7.4)", () => {
  it("reject one: the candidate's attempt is REJECTED (human) with a slot; the race drops to RACING; a second reject is CONFLICT", async () => {
    const { ns, stub, a, b, raceId } = await pickingRace();
    const r = await stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: b.trainId, reason: "the jar overlaps the footer" } });
    expect(r).toMatchObject({ outcome: "applied", fallback: false, race: { state: "RACING", reopens: 1, rejections: [{ trainId: b.trainId, by: `human:${OWNER}`, reason: "the jar overlaps the footer" }] } });
    expect(await stub.getAttempt(b.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "human", rework: { reason: "human", round: 1 } });
    expect((await look(ns)).events.filter((e) => e.type === "race.rejected")).toHaveLength(1);
    expect(await rpcError(stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: a.trainId, reason: "x" } }))).toMatch(/^CONFLICT: /);
    expect(await rpcError(stub.rejectRace({ hive: ns, raceId: "nope", user: OWNER, reject: { trainId: "all", reason: "x" } }))).toMatch(/^NOT_FOUND: /);
  });

  it("reject all: every candidate in rework, the window reopens; past maxRaceReopens it falls back (fallback: true)", async () => {
    const { ns, stub, raceId } = await pickingRace();
    const r = await stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: "all", reason: "none handles an empty cart" } });
    expect(r).toMatchObject({ fallback: false, race: { state: "RACING", reopens: 1, pickDeadlineAt: null } });
    expect(r.race.entryClosesAt).toBeGreaterThan(Date.now());

    const z = await externalHive({ race: { entryWindowMs: 0, judge: "human" }, guardrails: { maxRaceReopens: 0 } });
    const zi = await fileItem(z.ns);
    const za = await readyAttempt(z.ns, zi);
    const zb = await readyAttempt(z.ns, zi, agent({ owner: OTHER, name: "kimi" }));
    await push(z.ns, za);
    await push(z.ns, zb);
    await gatePass(z.ns, za.trainId);
    await gatePass(z.ns, zb.trainId);
    const zr = String((await look(z.ns)).races.at(-1)!.race_id);
    expect(await z.stub.rejectRace({ hive: z.ns, raceId: zr, user: OWNER, reject: { trainId: "all", reason: "no" } })).toMatchObject({ fallback: true, race: { state: "ABANDONED" } });
    expect((await look(z.ns)).items.find((i) => i.item_id === zi)).toMatchObject({ status: "FAILED" });
  });

  it("is a user route: 401 without x-queen-user, 400 on an empty or long reason, 404 for an unknown race", async () => {
    const hive = `route-${crypto.randomUUID().slice(0, 8)}`;
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "x" })).status).toBe(401);
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "" }, OWNER)).status).toBe(400);
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "x".repeat(301) }, OWNER)).status).toBe(400);
    const res = await rejectRoute(hive, "r1", { trainId: "all", reason: "x" }, OWNER);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/attempts-sync-reject.test.ts -t "rejectRace"`
Expected: FAIL: `stub.rejectRace is not a function`; the route answers 404 for every request.

- [ ] **Step 7: Implement `rejectRace` and the route**

`queen-node.ts`: import `RejectRaceSchema, type RejectRace, type RejectRaceResult`. After `pick`:

```ts
  /**
   * `POST /hives/:hive/races/:raceId/reject` (user, rework-loop spec §7): a human sends a PICKING race's candidate (or all
   * of them) back with a reason (`by: human:<email>`). 404 for an unknown race; 409 unless the race is PICKING and `trainId`
   * a live passed candidate. `fallback`: the reject ended the race and the item reopened to any agent.
   */
  async rejectRace(input: { hive: string; raceId: string; user: string; reject: RejectRace }): Promise<RejectRaceResult> {
    const reject = parseOrThrow(RejectRaceSchema, input.reject, "reject");
    const hive = this.hiveFor(input.hive);
    const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", input.raceId).toArray()[0];
    if (!row) throw new QueenError("NOT_FOUND", `race ${input.raceId} not found`);
    const race = rowToRace(row);
    const { value: res, acc } = this.decide(
      hive,
      (d) => d.acc.train(d.tp.reject({ raceId: race.raceId, target: reject.trainId, by: humanBy(input.user), reason: reject.reason })),
      { races: [race.raceId], trains: race.trainIds, items: [race.itemId] },
    );
    if (res.refused) throw new QueenError(res.refused.status === 404 ? "NOT_FOUND" : "CONFLICT", res.refused.message);
    await this.commit(hive, acc);
    const after = this.sql.exec("SELECT * FROM races WHERE race_id = ?", race.raceId).toArray()[0];
    return { outcome: res.outcome, race: after ? rowToRace(after) : race, fallback: res.rejected?.fallback ?? false };
  }
```

`apps/queen/src/index.ts`, import `RejectRaceSchema`, and after the pick route:

```ts
// Rework loop (rework-loop spec §7): send a PICKING race's candidate (or "all") back with a reason. 409 unless the race is
// PICKING and trainId a live passed candidate; 404 for an unknown race.
hive.post("/races/:raceId/reject", async (c) => {
  const user = userOf(c);
  const reject = parseOrThrow(RejectRaceSchema, await body(c), "reject");
  return c.json(await stub(c, hiveOf(c)).rejectRace({ hive: hiveOf(c), raceId: c.req.param("raceId"), user, reject }));
});
```

- [ ] **Step 8: Run the reject tests**

Run: `pnpm --filter @queenos/queen test -- test/attempts-sync-reject.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing note tests**

Append to `apps/queen/test/notes.test.ts` (import `reworkReasonText` from queen-types):

```ts
describe("rework loop notes (rework-loop spec §6.2, R19)", () => {
  const AGENT = { kind: "agent" as const, id: "opus@ada@example.com" };
  const DUE = Date.UTC(2026, 9, 13, 12, 30);

  it("an attempt's conflict says sync_base, rebase onto queen/main, push before the due time; no slot left says the item reopened", () => {
    const reason = reworkReasonText("conflict", DUE, "failed: Merge conflict in src/a.js");
    const events = [ev("train.phase", { trainId: "t1", data: { to: "EJECTED", reason } })];
    const t = train({ phase: "EJECTED", landedSha: null, origin: AGENT, attemptId: "att_0123456789ab", raceOutcome: "REWORK", reason, conflict: { paths: ["src/a.js"], summary: "conflict" } });
    const [entry] = parseNotes(projectNotes({ trains: [t], events, releases: [] }, "refs/notes/verdict")[0]!.text);
    expect(entry).toMatchObject({ verdict: "REJECTED", summary: "REJECTED (CONFLICT): conflicts with work that landed: src/a.js" });
    expect(entry!.body).toBe("Call sync_base, rebase onto queen/main and push again before 2026-10-13T12:30:00.000Z.");
    const closed = parseNotes(projectNotes({ trains: [{ ...t, raceOutcome: "FAILED" }], events, releases: [] }, "refs/notes/verdict")[0]!.text);
    expect(closed[0]!.body).toBe("No rework slot left: the item reopened to any agent (start_attempt).");
    const human = parseNotes(projectNotes({ trains: [{ ...t, origin: { kind: "human", id: "ada@example.com" }, attemptId: null }], events, releases: [] }, "refs/notes/verdict")[0]!.text);
    expect(human[0]!.body).toBe("Rebase on origin/main and push the branch again, or hand off.");
  });

  it("a human reject is a REJECTED verdict with the reason as a finding", () => {
    const reason = reworkReasonText("human", DUE, "rejected by k@kaikeru.com: the jar overlaps the footer");
    const events = [
      ev("gate.verdict", { trainId: "t1", summary: "gate passed: ok", data: { outcome: "PASSED", applied: "applied" } }),
      ev("train.phase", { trainId: "t1", data: { to: "EJECTED", reason } }),
    ];
    const t = train({ phase: "EJECTED", landedSha: null, origin: AGENT, attemptId: "att_0123456789ab", raceOutcome: "REWORK", reason });
    const entries = parseNotes(projectNotes({ trains: [t], events, releases: [] }, "refs/notes/verdict")[0]!.text);
    expect(currentVerdict(entries)).toBe("REJECTED");
    expect(entries.at(-1)).toMatchObject({ summary: "REJECTED by human: the jar overlaps the footer", findings: [{ severity: "error", path: "review", message: "rejected by k@kaikeru.com: the jar overlaps the footer" }] });
    expect(entries.at(-1)!.body).toBe("Address the reviewer's reason and push again before 2026-10-13T12:30:00.000Z.");
  });

  it("an attempt's gate findings body says fix and push before the due time", () => {
    const reason = reworkReasonText("findings", DUE, "failed in race: lint");
    const events = [ev("gate.verdict", { trainId: "t1", summary: "gate failed: lint", data: { outcome: "FAILED", applied: "applied" } })];
    const t = train({ phase: "EJECTED", landedSha: null, origin: AGENT, attemptId: "att_0123456789ab", raceOutcome: "REWORK", reason });
    const entries = parseNotes(projectNotes({ trains: [t], events, releases: [] }, "refs/notes/verdict")[0]!.text);
    expect(entries[0]!.body).toBe("Fix it and push again before 2026-10-13T12:30:00.000Z.");
  });
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm --filter @queenos/queen test -- test/notes.test.ts`
Expected: FAIL: `attemptId` is not a `NotesTrain` field; the bodies are today's.

- [ ] **Step 11: Implement the note bodies**

`apps/queen/src/work/notes.ts`: import `parseReworkReason`. Add to `NotesTrain`:

```ts
  /** v17: the MCP attempt whose fork this train is (its notes speak MCP: sync_base, rework due times). */
  attemptId?: string | null;
```

In `trainEntries`, replace `const next = ...`:

```ts
  const rework = parseReworkReason(t.reason);
  const due = rework && t.raceOutcome === "REWORK" ? new Date(rework.dueAt).toISOString() : null;
  const next = t.attemptId
    ? due
      ? `Fix it and push again before ${due}.`
      : "Fix it and push again."
    : contributed(t)
      ? `Push a fix to ${branch ?? "your branch"}, or hand off: a "Queen: rework" trailer, or "Let the swarm fix it" on item ${t.promptId}.`
      : "The swarm reworks it.";
```

In the `train.phase` `EJECTED` branch, insert a human-reject case right after the infra-stopped case (before `/^lost race/i`):

```ts
        } else if (/^(?:in rework \(human\) until \S+: |lost race \S+: )rejected by [^:]+: /.test(reason)) {
          const text = reason.replace(/^(?:in rework \(human\) until \S+: |lost race \S+: )/, "");
          const said = text.replace(/^rejected by [^:]+: /, "");
          out[NOTES_REF_VERDICT].push({
            seq: e.seq,
            entry: {
              ...common,
              kind: "verdict",
              verdict: "REJECTED",
              summary: oneLine(`REJECTED by human: ${said}`, 300),
              ...(due ? { body: `Address the reviewer's reason and push again before ${due}.` } : {}),
              findings: [{ severity: "error", path: "review", message: oneLine(text, 500) }],
            },
          });
```

and in the conflict branch replace the `body:` line:

```ts
              body: t.attemptId
                ? due
                  ? `Call sync_base, rebase onto queen/main and push again before ${due}.`
                  : "No rework slot left: the item reopened to any agent (start_attempt)."
                : contributed(t)
                  ? "Rebase on origin/main and push the branch again, or hand off."
                  : "The swarm reworks it on top of main.",
```

`queen-node.ts` `notesInput`: add `attemptId: t.attemptId ?? null,` to the `NotesTrain` map.

- [ ] **Step 12: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`, then `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`.
Expected: PASS / every task successful.

- [ ] **Step 13: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/queen-node.ts apps/queen/src/index.ts apps/queen/src/work/notes.ts apps/queen/test/attempts-sync-reject.test.ts apps/queen/test/notes.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): attemptSyncBase, reject route, rework note bodies

attemptSyncBase records hive main (read by queenos-mcp) as an attempt's base;
POST /races/:raceId/reject sends PICKING candidates back with a reason; an
attempt's notes say sync_base / push before the due time.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: MCP: `sync_base`, `reject`, verdict fields, descriptions

**Model: Sonnet**, Sonnet review (Opus if the token handling changes). **Gates:** the `sync_base` tool (Steps 1-5) needs C1 PASS. If C1 failed, skip it and keep the tool count at 18. Its `next` text needs C2 PASS. If C2 failed, use the merge wording in Step 3's note.

**Files:**
- Modify: `apps/mcp/src/ports.ts` (`QueenPort`: `attemptSyncBase`, `rejectRace`)
- Modify: `apps/mcp/src/commands.ts` (`syncCommand`, `syncNext`)
- Modify: `apps/mcp/src/tools.ts` (new tools `sync_base`, `reject`; `withCleanup`, `findingsOf`, `get_verdict`, `get_item`; descriptions of `create_goal`, `start_attempt`, `wait`, `get_verdict`)
- Modify: `apps/mcp/test/fakes.ts` (token scope, `FakeQueen.attemptSyncBase` / `rejectRace` / `races`)
- Test: `apps/mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: `AttemptSyncBase`, `RejectRace`, `RejectRaceResult`, `SyncBaseResult`, `SYNC_TOKEN_TTL_S`, `AttemptRework` (Task 1); Queen RPCs `attemptSyncBase`, `rejectRace` (Task 7).
- Produces:
  - `syncCommand(hiveRemote: string, readToken: string, baseSha: string, dir: string): string`; `syncNext(dir: string): string`.
  - MCP tool `sync_base({attemptId})` → `SyncBaseResult`.
  - MCP tool `reject({hive, itemId, target: attemptId | "all", reason})` → `{outcome, race: {raceId, state, reopens}, fallback}`.
  - `get_verdict` adds `rework` and the `conflict` / `human` kinds; `get_attempt` / `list_attempts` / `wait` views carry `rework` (null when none); `get_item` candidates carry `rework`.

- [ ] **Step 1: Extend the fakes**

`apps/mcp/test/fakes.ts`:
- `FakeRepo.tokens` becomes `{ id: string; state: string; scope: "read" | "write" }[]`. `createToken` pushes `{ id, state: "active", scope: _scope }` (rename `_scope` to `scope`).
- `FakeQueen` gains:

```ts
  /** Races getItemDetail answers (newest last). */
  races: Race[] = [];
  /** null = behave like a Queen without the RPC. */
  syncBase: ((input: AttemptSyncBase) => AttemptResult) | null = (input) => {
    const v = this.views.get(input.attemptId);
    if (!v) return { ok: false, code: "NOT_FOUND", message: "no attempt" };
    const next = { ...v, baseSha: input.baseSha };
    this.views.set(input.attemptId, next);
    return { ok: true, attempt: next, changed: true };
  };
  async attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult> {
    this.rec("attemptSyncBase", input);
    if (!this.syncBase) throw new Error('The RPC receiver does not implement the method "attemptSyncBase".');
    return this.syncBase(input);
  }
  /** null = behave like a Queen without the RPC. */
  reject: ((input: { hive: string; raceId: string; user: string; reject: RejectRace }) => RejectRaceResult) | null = (input) => ({
    outcome: "applied",
    race: { ...this.races.find((r) => r.raceId === input.raceId)!, state: "RACING", reopens: 1 },
    fallback: false,
  });
  async rejectRace(input: { hive: string; raceId: string; user: string; reject: RejectRace }): Promise<RejectRaceResult> {
    this.rec("rejectRace", input);
    if (!this.reject) throw new Error('The RPC receiver does not implement the method "rejectRace".');
    return this.reject(input);
  }
```

- `getItemDetail` returns `races: this.races` instead of `races: []`.
- Import `AttemptSyncBase, RejectRace, RejectRaceResult` types.

- [ ] **Step 2: Write the failing tests**

In `apps/mcp/test/tools.test.ts`, change the tool-table test to 19 tools (`..., "reject", ..., "sync_base", ...`). Add `rework: null` to the expected object of "get_verdict returns the verdict note of the head and the gate findings". Then append:

```ts
describe("rework loop: sync_base (§6.1)", () => {
  async function withSlot(state: "READY" | "REJECTED" = "REJECTED", rework: unknown = { reason: "conflict", dueAt: 9e12, round: 1 }) {
    const w = new FakeWorld();
    const { s, agent } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state, ...(state === "REJECTED" ? { verdict: "rejected", rework } : {}) } as never));
    return { w, s, agent };
  }

  it("mints one read token on the hive repo, reads main, records it with the Queen; the token appears once, in syncCommand only", async () => {
    const { w, s, agent } = await withSlot();
    w.artifacts.repos.get(HIVE)!.main = "e".repeat(40);
    const r = value<{ baseSha: string; syncCommand: string; next: string }>(await run(w, s, "sync_base", { attemptId: ATT }));
    expect(r.baseSha).toBe("e".repeat(40));
    expect(w.queen.inputs("attemptSyncBase")).toEqual([{ hive: HIVE, attemptId: ATT, owner: OWNER, agentId: agent.agentId, baseSha: "e".repeat(40) }]);
    const hiveTokens = w.artifacts.repos.get(HIVE)!.tokens;
    expect(hiveTokens).toEqual([expect.objectContaining({ state: "active", scope: "read" })]);
    expect(JSON.stringify(r).match(/art_v1_/g)).toHaveLength(1);
    const dir = `.queenos/attempts/${ATT}`;
    expect(r.syncCommand).toContain(`(git -C '${dir}' remote remove queen || true) && git -C '${dir}' remote add queen '${REMOTE(HIVE)}'`);
    expect(r.syncCommand).toContain(`config --local --replace-all 'http.${REMOTE(HIVE)}.extraHeader' 'Authorization: Bearer art_v1_`);
    expect(r.syncCommand).toContain(`git -C '${dir}' fetch queen +main:refs/remotes/queen/main`);
    expect(r.syncCommand).toContain(`test "$(git -C '${dir}' rev-parse refs/remotes/queen/main)" = '${"e".repeat(40)}' || { echo 'main moved; call sync_base again' >&2; false; }`);
    expect(r.next).toContain(`git -C '${dir}' rebase queen/main`);
    expect(r.next).toContain("push --force-with-lease origin HEAD:main");
  });

  it("READY is allowed; PUSHED or REJECTED without a slot is CONFLICT, before any token is minted; terminal is ATTEMPT_EXPIRED", async () => {
    const ready = await withSlot("READY");
    expect(value(await run(ready.w, ready.s, "sync_base", { attemptId: ATT }))).toMatchObject({ baseSha: MAIN_SHA });
    const noSlot = await withSlot("REJECTED", null);
    expect(errOf(await run(noSlot.w, noSlot.s, "sync_base", { attemptId: ATT }))).toMatchObject({ code: "CONFLICT", retryable: false });
    noSlot.w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PUSHED" }));
    expect(errOf(await run(noSlot.w, noSlot.s, "sync_base", { attemptId: ATT }))).toMatchObject({ code: "CONFLICT" });
    expect(noSlot.w.artifacts.repos.get(HIVE)!.tokens).toEqual([]);
    noSlot.w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "ABANDONED" }));
    expect(errOf(await run(noSlot.w, noSlot.s, "sync_base", { attemptId: ATT }))).toMatchObject({ code: "ATTEMPT_EXPIRED" });
  });

  it("a Queen refusal revokes the read token it minted; a Queen without the RPC is UNAVAILABLE (not retryable), token revoked", async () => {
    const { w, s } = await withSlot();
    w.queen.syncBase = () => ({ ok: false, code: "CONFLICT", message: "slot closed" });
    expect(errOf(await run(w, s, "sync_base", { attemptId: ATT }))).toEqual({ code: "CONFLICT", message: "slot closed", retryable: false });
    expect(w.artifacts.repos.get(HIVE)!.tokens.map((t) => t.state)).toEqual(["revoked"]);
    w.queen.syncBase = null;
    expect(errOf(await run(w, s, "sync_base", { attemptId: ATT }))).toEqual({ code: "UNAVAILABLE", message: "sync_base needs a newer Queen", retryable: false });
    expect(w.artifacts.activeTokens(HIVE)).toEqual([]);
  });

  it("an unreadable main is ARTIFACTS_UNAVAILABLE (retry in 5 s), no token is minted, the Queen is not called", async () => {
    const { w, s } = await withSlot();
    w.artifacts.repos.get(HIVE)!.main = "";
    expect(errOf(await run(w, s, "sync_base", { attemptId: ATT }))).toMatchObject({ code: "ARTIFACTS_UNAVAILABLE", retryable: true, retryAfterMs: 5000 });
    expect(w.queen.inputs("attemptSyncBase")).toEqual([]);
    expect(w.artifacts.activeTokens(HIVE)).toEqual([]);
  });

  it("someone else's attempt is FORBIDDEN_OWNER", async () => {
    const { w } = await withSlot();
    const { s: other } = await worker(w);
    expect(errOf(await run(w, other, "sync_base", { attemptId: ATT }))).toMatchObject({ code: "FORBIDDEN_OWNER" });
  });

  it("a second sync_base rotates the header and revokes nothing it did not mint (Review Focus 5)", async () => {
    const { w, s } = await withSlot();
    w.artifacts.repos.get(HIVE)!.tokens.push({ id: "proxy-token", state: "active", scope: "write" });
    const first = value<{ syncCommand: string }>(await run(w, s, "sync_base", { attemptId: ATT }));
    const second = value<{ syncCommand: string }>(await run(w, s, "sync_base", { attemptId: ATT }));
    expect(second.syncCommand).toContain("--replace-all");
    expect(second.syncCommand).not.toBe(first.syncCommand);
    expect(w.artifacts.activeTokens(HIVE)).toEqual(expect.arrayContaining(["proxy-token"]));
    expect(w.artifacts.activeTokens(HIVE)).toHaveLength(3);
  });
});

describe("rework loop: reject (§7.4)", () => {
  const race = (over: Partial<Race> = {}): Race => ({ raceId: "race-1", itemId: "item-1", width: 2, state: "PICKING", trainIds: ["train-1", "train-2"], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: 1, decidedAt: null, ...over });

  it("resolves the item's PICKING race and the attempt's current train; any role; returns the race and fallback", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w, "orchestrator");
    w.queen.races = [race({ raceId: "race-0", state: "ABANDONED" }), race()];
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, trainId: "train-2", state: "PASSED" }));
    expect(value(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: ATT, reason: "the jar overlaps the footer" }))).toEqual({ outcome: "applied", race: { raceId: "race-1", state: "RACING", reopens: 1 }, fallback: false });
    expect(w.queen.inputs("rejectRace")).toEqual([{ hive: HIVE, raceId: "race-1", user: OWNER, reject: { trainId: "train-2", reason: "the jar overlaps the footer" } }]);
    value(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "all", reason: "none of these" }));
    expect(w.queen.inputs<{ reject: { trainId: string } }>("rejectRace")[1]!.reject.trainId).toBe("all");
  });

  it("errors: no PICKING race CONFLICT; a target not in the race CONFLICT; reason empty or > 300 INVALID_INPUT; unknown attempt NOT_FOUND; old Queen UNAVAILABLE", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    w.queen.races = [race({ state: "RACING" })];
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "all", reason: "x" }))).toMatchObject({ code: "CONFLICT" });
    w.queen.races = [race()];
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, trainId: "train-9" }));
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: ATT, reason: "x" }))).toMatchObject({ code: "CONFLICT" });
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "all", reason: "" }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "all", reason: "x".repeat(301) }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "att_ffffffffffff", reason: "x" }))).toMatchObject({ code: "NOT_FOUND" });
    w.queen.reject = null;
    expect(errOf(await run(w, s, "reject", { hive: HIVE, itemId: "item-1", target: "all", reason: "x" }))).toEqual({ code: "UNAVAILABLE", message: "reject needs a newer Queen", retryable: false });
  });
});

describe("rework loop: verdicts (§6.2, §7.4)", () => {
  const DUE = Date.UTC(2026, 9, 13, 12, 30);
  async function withAttempt() {
    const w = new FakeWorld();
    const { s } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    return { w, s };
  }
  const train = (over: Record<string, unknown> = {}) => ({ trainId: "train-1", phase: "EJECTED", raceOutcome: "REWORK", headSha: "c".repeat(40), previewUrl: null, summary: "s", reason: "r", score: null, ...over });

  it("conflict: the conflicting paths are the findings; next says sync_base and the due time; rework passes through", async () => {
    const { w, s } = await withAttempt();
    w.queen.views.set(ATT, REJ({ verdictKind: "conflict", rework: { reason: "conflict", dueAt: DUE, round: 1 }, train: train({ conflict: { paths: ["src/a.js", "src/b.js"], summary: "Merge conflict" } }) }));
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({
      kind: "conflict",
      findings: ["src/a.js", "src/b.js"],
      rework: { reason: "conflict", dueAt: DUE, round: 1 },
      next: "call sync_base, rebase onto queen/main, push again before 2026-10-13T12:30:00.000Z",
    });
  });

  it("human: the reason is the finding; findings with a slot: fix and push before; no slot on a newer Queen: next null", async () => {
    const { w, s } = await withAttempt();
    const head = "c".repeat(40);
    w.queen.views.set(ATT, REJ({ verdictKind: "human", rework: { reason: "human", dueAt: DUE, round: 1 }, train: train() }));
    w.queen.notes.set(head, "Queen-Verdict: REJECTED\nQueen-Finding: error review rejected by k@kaikeru.com: ugly");
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: "human", findings: ["error review rejected by k@kaikeru.com: ugly"], next: "address the reviewer's reason, push again before 2026-10-13T12:30:00.000Z" });
    w.queen.views.set(ATT, REJ({ verdictKind: "findings", rework: { reason: "findings", dueAt: DUE, round: 2 }, train: train() }));
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: "findings", next: "fix and push before 2026-10-13T12:30:00.000Z" });
    w.queen.views.set(ATT, REJ({ verdictKind: "findings", rework: null, train: train({ raceOutcome: "FAILED" }) }));
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: "findings", rework: null, next: null });
  });

  it("get_attempt and get_item carry rework (null when absent)", async () => {
    const { w, s } = await withAttempt();
    w.queen.views.set(ATT, REJ({ verdictKind: "conflict", rework: { reason: "conflict", dueAt: DUE, round: 1 } }));
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ rework: { reason: "conflict", dueAt: DUE, round: 1 } });
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PUSHED" }));
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ rework: null });
  });
});
```

Add `Race` to the `@queenos/queen-types` type import of the test file if it is not there.

- [ ] **Step 3: `syncCommand` and `syncNext`**

Append to `apps/mcp/src/commands.ts`:

```ts
const SHA_OK = /^[0-9a-f]{40}$/;

/**
 * `sync_base` (rework-loop spec §6.1): one `&&` chain that (re)adds a read-only `queen` remote for hive main, sets its read
 * token in the clone's local config (the token appears only here; `--replace-all` rotates it on a rerun), fetches main
 * as refs/remotes/queen/main, and fails loudly when main moved after the read. Fetch only: the rebase is the agent's.
 */
export function syncCommand(hiveRemote: string, readToken: string, baseSha: string, dir: string): string {
  checked(hiveRemote, readToken);
  if (!SHA_OK.test(baseSha)) throw new ToolError("ARTIFACTS_UNAVAILABLE", "reading the hive's main failed; retry sync_base", { retryAfterMs: 5000 });
  const d = sq(dir);
  return [
    `(git -C ${d} remote remove queen || true)`,
    `git -C ${d} remote add queen ${sq(hiveRemote)}`,
    `git -C ${d} config --local --replace-all ${sq(`http.${hiveRemote}.extraHeader`)} ${sq(`Authorization: Bearer ${readToken}`)}`,
    `git -C ${d} fetch queen +main:refs/remotes/queen/main`,
    `{ test "$(git -C ${d} rev-parse refs/remotes/queen/main)" = ${sq(baseSha)} || { echo ${sq("main moved; call sync_base again")} >&2; false; }; }`,
  ].join(" && ");
}

/** What to do after `syncCommand` (§6.1 `next`). */
export const syncNext = (dir: string): string =>
  `Rebase onto queen/main (git -C ${sq(dir)} rebase queen/main), resolve conflicts keeping both behaviours, run the tests, then git -C ${sq(dir)} push --force-with-lease origin HEAD:main.`;
```

**If C2 failed**, `syncNext` reads instead: `` `Merge queen/main into your branch (git -C ${sq(dir)} merge queen/main), resolve conflicts keeping both behaviours, run the tests, then git -C ${sq(dir)} push origin HEAD:main.` ``, and the two `next` assertions in Step 2 change to match.

- [ ] **Step 4: The `sync_base` tool, ports**

`apps/mcp/src/ports.ts`: import `AttemptSyncBase, RejectRace, RejectRaceResult`; add to `QueenPort`:

```ts
  /** Rework loop: record hive main as the attempt's base. A Queen older than the rework loop lacks it ("does not implement"). */
  attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult>;
  /** Rework loop: send PICKING candidates back with a reason (409 → CONFLICT, 404 → NOT_FOUND). */
  rejectRace(input: { hive: string; raceId: string; user: string; reject: RejectRace }): Promise<RejectRaceResult>;
```

`apps/mcp/src/tools.ts`: import `SYNC_TOKEN_TTL_S, type AttemptResult, type SyncBaseResult` from queen-types and `syncCommand, syncNext` from `./commands`; `McpRepoHandle` from `./ports`. Add to `TOOLS` after `retry_gates`:

```ts
  {
    name: "sync_base",
    description:
      "Your attempt: bring the hive's current main into your clone as queen/main, to rebase on (READY, or REJECTED with an open rework slot, e.g. after a conflict). Run the returned syncCommand (fetch only; it fails if main moved, then call again), rebase, run the tests, push --force-with-lease origin HEAD:main. Your next push is gated against baseSha.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }): Promise<SyncBaseResult> => {
      const agent = agentOf(ctx);
      const { hive, view } = await ownAttempt(ctx, agent, a.attemptId);
      if (isTerminalAttemptState(view.state)) throw new ToolError("ATTEMPT_EXPIRED", `attempt ${a.attemptId} is ${view.state}`);
      const slotOpen = !!view.rework && view.rework.dueAt > ctx.ports.now();
      if (view.state !== "READY" && !(view.state === "REJECTED" && slotOpen)) {
        throw new ToolError("CONFLICT", `attempt ${a.attemptId} is ${view.state === "REJECTED" ? "REJECTED with no open rework slot" : view.state}; sync_base needs READY or an open rework slot`);
      }
      const unavailable = () => new ToolError("ARTIFACTS_UNAVAILABLE", "reading the hive's main failed; retry sync_base", { retryAfterMs: 5000 });
      let handle: McpRepoHandle;
      try {
        handle = await ctx.ports.artifacts.get(hive);
      } catch {
        throw unavailable();
      }
      using repo = handle;
      let tok: { id: string; plaintext: string } | null = null;
      // Only the token this call minted is ever revoked (R16): the hive repo has other tokens.
      const revoke = async () => {
        if (tok) await repo.revokeToken(tok.id).catch(() => false);
      };
      let baseSha: string;
      let cmd: string;
      try {
        const remote = (await repo.info()).remote.replace(/\/+$/, "");
        baseSha = (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? "";
        if (!/^[0-9a-f]{40}$/.test(baseSha)) throw unavailable();
        tok = await repo.createToken("read", SYNC_TOKEN_TTL_S);
        cmd = syncCommand(remote, tok.plaintext, baseSha, attemptDir(a.attemptId));
      } catch (e) {
        await revoke();
        throw e instanceof ToolError ? e : unavailable();
      }
      let r: AttemptResult;
      try {
        r = await ctx.ports.queen(hive).attemptSyncBase({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId, baseSha });
      } catch (e) {
        await revoke();
        if (lacksRpc(e)) throw new ToolError("UNAVAILABLE", "sync_base needs a newer Queen", { retryable: false });
        throw e;
      }
      if (!r.ok) {
        await revoke();
        throw refusal(r);
      }
      return { baseSha, syncCommand: cmd, next: syncNext(attemptDir(a.attemptId)) };
    },
  },
```

- [ ] **Step 5: Run the sync_base tests**

Run: `pnpm --filter @queenos/mcp test -- test/tools.test.ts -t "sync_base"`
Expected: PASS.

- [ ] **Step 6: The `reject` tool**

Add to `TOOLS` after `pick`:

```ts
  {
    name: "reject",
    description:
      "Send candidates of a race you are judging back for rework, with a reason the agent can act on (what is wrong and what you expect instead). target: an attemptId, or \"all\". Only while the item's race waits for a pick (PICKING).",
    shape: { hive: HiveSlugSchema, itemId: ItemIdSchema, target: z.union([AttemptIdSchema, z.literal("all")]), reason: z.string().min(1).max(300) },
    run: async (ctx, a: { hive: string; itemId: string; target: string; reason: string }) => {
      const agent = agentOf(ctx);
      await requireHive(ctx, a.hive);
      const queen = ctx.ports.queen(a.hive);
      const detail = await queen.getItemDetail(a.itemId);
      const race = detail.races.filter((r) => r.state === "PICKING").at(-1);
      if (!race) throw new ToolError("CONFLICT", `item ${a.itemId} has no race waiting for a pick`);
      let trainId = "all";
      if (a.target !== "all") {
        const view = await queen.getAttempt(a.target);
        if (!view) throw new ToolError("NOT_FOUND", `attempt ${a.target} not found`);
        if (!race.trainIds.includes(view.trainId)) throw new ToolError("CONFLICT", `attempt ${a.target} is not a candidate of race ${race.raceId}`);
        trainId = view.trainId;
      }
      let r;
      try {
        r = await queen.rejectRace({ hive: a.hive, raceId: race.raceId, user: agent.owner, reject: { trainId, reason: a.reason } });
      } catch (e) {
        if (lacksRpc(e)) throw new ToolError("UNAVAILABLE", "reject needs a newer Queen", { retryable: false });
        throw e;
      }
      return { outcome: r.outcome, race: { raceId: r.race.raceId, state: r.race.state, reopens: r.race.reopens ?? 0 }, fallback: r.fallback };
    },
  },
```

- [ ] **Step 7: Verdict fields and descriptions**

`withCleanup`:

```ts
const withCleanup = (v: AttemptView) => {
  const view = { ...v, verdictKind: v.verdictKind ?? null, regating: v.regating ?? null, rework: v.rework ?? null };
  return isTerminalAttemptState(v.state) ? { ...view, cleanup: cleanupOf(v.attemptId) } : view;
};
```

`findingsOf`, first line after the infra guard:

```ts
  if (view.verdictKind === "conflict") {
    const c = view.train?.conflict;
    if (c?.paths.length) return c.paths.slice(0, 50);
    return [c?.summary ?? view.train?.reason ?? "merge conflict"];
  }
```

`get_verdict`. Update the description:

```ts
    description:
      "Your attempt's verdict on its current head: the v1 verdict note, kind (findings = fix and push; infra = the gate could not run, call retry_gates; conflict = sync_base, rebase onto queen/main, push; human = a judge's reason, address it and push), findings, rework ({reason, dueAt, round}: you may push again as the same candidate before dueAt), next, regating and the preview URL.",
```

and the result:

```ts
      const kind = view.verdictKind ?? null;
      // R12: an older Queen has no `rework` key (keep today's next); a newer one says null when no slot is open.
      const rework = view.rework;
      const due = rework ? new Date(rework.dueAt).toISOString() : null;
      const next =
        kind === "infra"
          ? "retry_gates"
          : kind === "conflict"
            ? due && `call sync_base, rebase onto queen/main, push again before ${due}`
            : kind === "human"
              ? due && `address the reviewer's reason, push again before ${due}`
              : kind === "findings"
                ? rework === undefined
                  ? "fix and push"
                  : due && `fix and push before ${due}`
                : null;
      return {
        headSha: view.headSha,
        verdict: view.verdict,
        kind,
        findings: findingsOf(view, note),
        summary: view.train?.summary ?? null,
        note,
        previewUrl: view.train?.previewUrl ?? null,
        regating: view.regating ?? null,
        rework: rework ?? null,
        next: next || null,
      };
```

`get_item`, in the candidate map add `rework: x.rework ?? null,` and change the description's "kind: findings or infra" to "kind: findings, infra, conflict or human; rework".

`create_goal` description:

```ts
    description:
      "Orchestrators only: file a goal in an external hive. Write it as a work spec, like a ticket, for whoever picks it up: the outcome, acceptance criteria and constraints. It becomes one item agents race on. judge: auto (the Queen ranks) or pick (a human or an orchestrator picks, and may reject with a reason). entryWindowMs: how long the race takes entries after its first push (max 1 h).",
```

`start_attempt` description, append: ` A rejection may come with a rework slot (rework.dueAt): fix it (for a conflict: sync_base, then rebase) and push again before dueAt, as the same candidate.`

`wait` description, append: ` A rejection may open a rework slot (attempt.rework): fix and push again before rework.dueAt.`

- [ ] **Step 8: Run all MCP tests**

Run: `pnpm --filter @queenos/mcp test && pnpm --filter @queenos/mcp typecheck`
Expected: PASS (19 tools).

- [ ] **Step 9: Full gate**

Run: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`. Expected: every task successful.

- [ ] **Step 10: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/mcp/src/ports.ts apps/mcp/src/commands.ts apps/mcp/src/tools.ts apps/mcp/test/fakes.ts apps/mcp/test/tools.test.ts
git commit -m "$(cat <<'MSG'
feat(mcp): sync_base and reject tools, rework verdicts

sync_base fetches hive main into the clone as queen/main with a 30 min read
token that appears only in syncCommand; reject sends PICKING candidates back
with a reason; get_verdict adds conflict / human kinds, rework and due-time
next steps.

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: Dashboard: Reject and Reject all, rework rendering

**Model: Sonnet**, Sonnet review.

**Files:**
- Modify: `apps/dashboard/src/api.ts` (`rejectBody`, `api.rejectRace`)
- Modify: `apps/dashboard/src/raceLogic.ts` (`REJECT_REASON_MAX`, `canSendReject`, `rejectFailure`, `reworkLines`)
- Modify: `apps/dashboard/src/RacePick.tsx` (Reject per card, Reject all, `RejectBox`)
- Modify: `apps/dashboard/src/RaceEntries.tsx` (rework lines, REWORKING)
- Modify: `apps/dashboard/src/swarm.ts:357` (`isOpenRace` includes REWORKING)
- Test: `apps/dashboard/test/racepick.test.tsx` (append)

**Interfaces:**
- Consumes: `RejectRace`, `parseReworkReason` (Task 1); `POST /hives/:hive/races/:raceId/reject` (Task 7; the edge already forwards every `/hives/*` route, `apps/edge/src/app.ts:362`).
- Produces: `rejectBody(trainId: string, reason: string): RejectRace`; `api.rejectRace(hive: string, raceId: string, trainId: string, reason: string)`; `canSendReject(reason: string): boolean`; `rejectFailure(e: unknown): PickFailure`; `reworkLines(view: RaceView, now: number): string[]`; `RejectBox` component (exported for tests).

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/test/racepick.test.tsx` (extend the imports: `rejectBody` from `../src/api`; `canSendReject, rejectFailure, reworkLines` from `../src/raceLogic`; `RejectBox` from `../src/RacePick`; `reworkReasonText` from `@queenos/queen-types`):

```tsx
describe("reject (rework loop §7.4)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const view = (r: Race, ts = three()) => raceView(state(r, ts), "r1", NOW)!;

  test("Send needs a reason of 1..300 characters; the body trims and caps it", () => {
    expect(canSendReject("")).toBe(false);
    expect(canSendReject("   ")).toBe(false);
    expect(canSendReject("ugly")).toBe(true);
    expect(canSendReject("x".repeat(301))).toBe(false);
    expect(rejectBody("all", "  none of these  ")).toEqual({ trainId: "all", reason: "none of these" });
  });

  test("rejectRace POSTs {trainId, reason} to the reject route; a 409 asks for a refresh", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await api.rejectRace("demo", "r1", "b", "the jar overlaps the footer");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/hives/demo/races/r1/reject");
    expect(JSON.parse(init.body as string)).toEqual({ trainId: "b", reason: "the jar overlaps the footer" });
    const r = rejectFailure(new ApiError("race is RACING, not PICKING", 409));
    expect(r.refresh).toBe(true);
    expect(r.message).toContain("no longer waiting for a pick");
    expect(rejectFailure(new ApiError("boom", 500))).toEqual({ message: "boom", refresh: false });
  });

  test("PICKING renders Reject on each pickable card and Reject all; a decided race renders neither", () => {
    const html = renderToString(<RacePick hive="demo" view={view(race())} now={NOW} />);
    expect(html.match(/>Reject</g)).toHaveLength(3);
    expect(html).toContain("Reject all");
    const done = renderToString(<RacePick hive="demo" view={view(race({ state: "DECIDED", winnerTrainId: "a", decidedBy: "human:k@kaikeru.com" }))} now={NOW} />);
    expect(done).not.toContain("Reject");
  });

  test("the reason box: a textarea, Send disabled until a reason is typed, Cancel; no browser dialog", () => {
    const empty = renderToString(<RejectBox label="Reason for rejecting c2" onSend={async () => undefined} onCancel={() => undefined} />);
    expect(empty).toContain("<textarea");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
    const typed = renderToString(<RejectBox label="x" initialReason="ugly" onSend={async () => undefined} onCancel={() => undefined} />);
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
    expect(typed).toContain("Cancel");
  });

  test("rework lines: a REWORK candidate in a RACING race, and the REWORKING race's winner, with their due time", () => {
    const rw = (reason: "findings" | "conflict" | "human") => reworkReasonText(reason, NOW + 723_000, "failed: x");
    const racing = view(race({ state: "RACING", pickDeadlineAt: undefined }), [train("a", 0), train("b", 1, { raceOutcome: "REWORK", status: "EJECTED", reason: rw("human") })]);
    expect(reworkLines(racing, NOW)).toEqual(["model-b in rework (human) · due in 12:03"]);
    const reworking = view(race({ state: "REWORKING", winnerTrainId: "a" }), [train("a", 0, { raceOutcome: "REWORK", status: "EJECTED", reason: rw("conflict") })]);
    expect(reworkLines(reworking, NOW)).toEqual(["Reworking · model-a fixing a conflict rejection · due in 12:03"]);
    const html = renderToString(<RaceEntries hive="demo" view={reworking} now={NOW} />);
    expect(html).toContain("Reworking · model-a fixing a conflict rejection");
  });

  test("raceViewForItem treats a REWORKING race as open (it wins over a newer decided one)", () => {
    const s = state(race({ state: "REWORKING", winnerTrainId: "a" }), three());
    s.races = { r1: race({ state: "REWORKING", winnerTrainId: "a" }), r0: race({ raceId: "r0", state: "DECIDED", createdAt: NOW }) };
    expect(raceViewForItem(s, "i1", NOW)?.race.raceId).toBe("r1");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @queenos/dashboard test -- test/racepick.test.tsx`
Expected: FAIL: the exports are missing.

- [ ] **Step 3: API and logic**

`apps/dashboard/src/api.ts` (import `type RejectRace`):

```ts
/** Request body for POST /hives/:hive/races/:raceId/reject: a trainId or "all", the reason trimmed and capped at 300. */
export function rejectBody(trainId: string, reason: string): RejectRace {
  return { trainId, reason: reason.trim().slice(0, 300) };
}
```

and in `api`:

```ts
  /** Rework loop: send a PICKING race's candidate (or "all") back with a reason. 409 = no longer PICKING (raceLogic.rejectFailure). */
  rejectRace: (hive: string, raceId: string, trainId: string, reason: string) =>
    request("POST", `/hives/${enc(hive)}/races/${enc(raceId)}/reject`, AnyParser, rejectBody(trainId, reason), "include"),
```

`apps/dashboard/src/raceLogic.ts` (import `parseReworkReason` from queen-types):

```ts
export const REJECT_REASON_MAX = 300;

/** Send is enabled only with a reason the agent can act on: 1..300 characters after trimming. */
export function canSendReject(reason: string): boolean {
  const r = reason.trim();
  return r.length > 0 && r.length <= REJECT_REASON_MAX;
}

/** 409: the race no longer waits for a pick (a reject already sent it back, or it was decided): refetch to show its state. */
export function rejectFailure(e: unknown): PickFailure {
  if (e instanceof ApiError && e.status === 409) {
    return { message: "This race is no longer waiting for a pick (a reject already sent it back, or it was decided). Refreshing…", refresh: true };
  }
  return { message: e instanceof Error ? e.message : String(e), refresh: false };
}

/**
 * Rework loop: "model-b in rework (human) · due in 12:03" for each REWORK candidate of a RACING race, or
 * "Reworking · model-a fixing a conflict rejection · due in 12:03" for a REWORKING race. The due time comes from the
 * train's rework reason text (plan ruling R9). Unknown or older trains are skipped.
 */
export function reworkLines(view: RaceView, now: number): string[] {
  const out: string[] = [];
  for (const c of view.candidates) {
    if (c.train.raceOutcome !== "REWORK") continue;
    const r = parseReworkReason(c.train.reason);
    if (!r) continue;
    const who = c.model ?? `c${c.candidate + 1}`;
    const left = countdownText(r.dueAt - now);
    out.push(view.race.state === "REWORKING" ? `Reworking · ${who} fixing a ${r.reason} rejection · due in ${left}` : `${who} in rework (${r.reason}) · due in ${left}`);
  }
  return out;
}
```

`apps/dashboard/src/swarm.ts:357`:

```ts
const isOpenRace = (r: Race): boolean => r.state === "RACING" || r.state === "PICKING" || r.state === "REWORKING";
```

- [ ] **Step 4: The Reject UI**

`apps/dashboard/src/RacePick.tsx` (import `canSendReject, rejectFailure, REJECT_REASON_MAX` from `./raceLogic`):

```tsx
/** The inline reason box of Reject / Reject all (no browser dialog): Send stays disabled until a reason is typed. */
export function RejectBox({ label, onSend, onCancel, initialReason = "" }: { label: string; onSend: (reason: string) => Promise<void>; onCancel: () => void; initialReason?: string }) {
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await onSend(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rp__confirm rp__reject">
      <textarea value={reason} maxLength={REJECT_REASON_MAX} rows={3} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong, and what do you expect instead?" aria-label={label} />
      <button type="button" className="btn btn--primary" disabled={busy || !canSendReject(reason)} onClick={() => void send()}>{busy ? "Sending…" : "Send"}</button>
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** "Reject all" on the race panel (PICKING only). */
function RejectAll({ hive, raceId, onChanged }: { hive: string; raceId: string; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (reason: string) => {
    setErr(null);
    try {
      await api.rejectRace(hive, raceId, "all", reason);
      setOpen(false);
      onChanged?.();
    } catch (e) {
      const f = rejectFailure(e);
      setErr(f.message);
      setOpen(false);
      if (f.refresh) onChanged?.();
    }
  };
  return (
    <div className="rp__reject-all">
      {open ? (
        <RejectBox label="Reason for rejecting every candidate" onSend={send} onCancel={() => setOpen(false)} />
      ) : (
        <button type="button" className="btn" disabled={MOCK} title={MOCK ? "Mock mode: not available" : undefined} onClick={() => setOpen(true)}>Reject all</button>
      )}
      {err && <p className="sh-err" role="alert">{err}</p>}
    </div>
  );
}
```

In `RacePick`, after `<ul className="rp__cards">...</ul>`: `{picking && <RejectAll hive={hive} raceId={race.raceId} onChanged={onChanged} />}`.

In `Card`, add state `const [rejecting, setRejecting] = useState(false);` and a send handler:

```tsx
  const reject = async (why: string) => {
    setErr(null);
    try {
      await api.rejectRace(hive, raceId, c.trainId, why);
      setRejecting(false);
      onChanged?.();
    } catch (e) {
      const f = rejectFailure(e);
      setErr(f.message);
      setRejecting(false);
      if (f.refresh) onChanged?.();
    }
  };
```

and next to the "Pick this one" button (inside the same `picking && c.pickable` branch, when neither box is open):

```tsx
      {picking && c.pickable && !confirm && (
        rejecting ? (
          <RejectBox label={`Reason for rejecting ${c.tag}`} onSend={reject} onCancel={() => setRejecting(false)} />
        ) : (
          <button type="button" className="btn" disabled={MOCK} title={MOCK ? "Mock mode: not available" : undefined} onClick={() => setRejecting(true)}>Reject</button>
        )
      )}
```

- [ ] **Step 5: Rework lines in the race box**

`apps/dashboard/src/RaceEntries.tsx` (import `reworkLines`): show the box when there is an entry window or a rework line:

```tsx
  const state = entryState(race, now);
  const lines = reworkLines(view, now);
  if (!state && !lines.length) return null;
```

and render, after the entries line:

```tsx
      <p className="eyebrow">{race.state === "REWORKING" ? "REWORK" : "RACE ENTRIES"}</p>
      {state && <p className="rp__count" role="timer">{entriesLine(race, view.candidates.length, now)}</p>}
      {lines.map((l) => (
        <p key={l} className="sh-muted rp__rework" role="status">{l}</p>
      ))}
```

(keep the "End entries now" button under `state?.kind === "open"`). Update the component's doc comment: "... and, in the rework loop, each REWORK candidate's or the REWORKING winner's due time."

- [ ] **Step 6: Run the dashboard tests**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck`
Expected: PASS. If "PICKING renders Reject ..." counts more than 3 `>Reject<`, check that the cards render "Reject" only while `picking && c.pickable`.

- [ ] **Step 7: Full gate**

Run: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`. Expected: every task successful.

- [ ] **Step 8: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/dashboard/src/api.ts apps/dashboard/src/raceLogic.ts apps/dashboard/src/RacePick.tsx apps/dashboard/src/RaceEntries.tsx apps/dashboard/src/swarm.ts apps/dashboard/test/racepick.test.tsx
git commit -m "$(cat <<'MSG'
feat(dashboard): reject candidates with a reason, show rework due times

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: Sim: `[conflict-once]` and the rework demo (`dev:sim`)

**Model: Sonnet**, Sonnet review. R14: the sim has no MCP server or Artifacts, so a sim-only driver plays two agents through the Queen's attempt RPCs.

**Files:**
- Modify: `apps/queen/src/sim/sim-v2.ts` (`CONFLICT_ONCE_MARKER`, `CONFLICT_ONCE_KEY`, next to `FORK_KEY` :247)
- Modify: `apps/queen/src/sim/sim-ports.ts` (`runMerge` :745)
- Create: `apps/queen/src/sim/rework-demo.ts`
- Modify: `apps/queen/src/sim/worker.ts` (`POST /sim/rework-demo?hive=<h>`, localhost-only like the rest of the sim)
- Create: `apps/queen/test/sim-rework.test.ts`

**Interfaces:**
- Consumes: the Queen RPCs `updateSettings`, `fileWorkItem`, `attemptIntent`, `attemptBaseReady`, `attemptReady`, `attemptPushed`, `getAttempt`, `attemptSyncBase`; `fakeSha` (sim-ports.ts:229).
- Produces: `reworkDemo(q: DemoQueen, hive: string, opts: { tick: () => Promise<void>; maxTicks?: number }): Promise<string[]>` (a transcript); `CONFLICT_ONCE_MARKER = "[conflict-once]"`.

- [ ] **Step 1: Write the failing test**

`apps/queen/test/sim-rework.test.ts`:

```ts
/** Sim mode (rework-loop spec §11): two items on one file; the second winner conflicts once, reworks, lands. */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reworkDemo, type DemoQueen } from "../src/sim/rework-demo";
import type { SimQueenNode } from "./worker";

const simNs = () => (env as unknown as { SIM_QUEEN: DurableObjectNamespace<SimQueenNode> }).SIM_QUEEN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sim: the rework demo", () => {
  it("the second winner conflicts, gets a conflict slot, syncs its base, pushes a rebased head as the same candidate and lands", async () => {
    const hive = `rework-${crypto.randomUUID().slice(0, 8)}`;
    const stub = simNs().get(simNs().idFromName(hive));
    const log = await reworkDemo(stub as unknown as DemoQueen, hive, {
      tick: async () => {
        await runDurableObjectAlarm(stub);
        await sleep(5);
      },
    });
    expect(log.join("\n")).toMatch(/opus: .* LANDED/);
    expect(log.join("\n")).toMatch(/kimi: REJECTED \(conflict in src\/shared\.js\)/);
    expect(log.at(-1)).toMatch(/kimi: rebased head .* LANDED as the same candidate in race /);
  }, 60_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @queenos/queen test -- test/sim-rework.test.ts`
Expected: FAIL: `../src/sim/rework-demo` does not exist.

- [ ] **Step 3: The marker in the sim MERGE drone**

`apps/queen/src/sim/sim-v2.ts`, after `PATHS_KEY`:

```ts
/** `[conflict-once]` (rework demo): an item's first merge in a car conflicts on its `[touch:]` paths; later merges are clean. */
export const CONFLICT_ONCE_MARKER = "[conflict-once]";
export const CONFLICT_ONCE_KEY = (promptId: string) => `sim:conflict-once:${promptId}`;
```

`apps/queen/src/sim/sim-ports.ts` `runMerge`: before `const out = simMerge(main, {`, split the members:

```ts
    // `[conflict-once]`: the item's first merge conflicts (the rework demo), whatever the sim main says.
    const forced: MergeConflict[] = [];
    const rest: typeof members = [];
    for (const m of members) {
      if (m.title.includes(CONFLICT_ONCE_MARKER) && !(await this.store.get<boolean>(CONFLICT_ONCE_KEY(m.promptId)))) {
        await this.store.put(CONFLICT_ONCE_KEY(m.promptId), true);
        const clash = simChangedPaths(m.title).filter((p) => !isGeneratedPath(p));
        forced.push({ trainId: m.trainId, kind: "content", paths: clash.slice(0, 50), summary: `Merge conflict in ${clash.join(", ")}: changed by an earlier merge (sim [conflict-once]).`.slice(0, 500) });
      } else {
        rest.push(m);
      }
    }
```

Pass `members: rest.map((m) => ({ trainId: m.trainId, promptId: m.promptId, title: m.title }))` to `simMerge`. Report `conflicts: [...forced, ...out.conflicts]`, and in the summary use `const conflicts = [...forced, ...out.conflicts];` in place of `out.conflicts`. Import `CONFLICT_ONCE_KEY, CONFLICT_ONCE_MARKER` from `./sim-v2`, and `isGeneratedPath, type MergeConflict` from queen-types if they are not imported yet.

- [ ] **Step 4: The demo driver**

`apps/queen/src/sim/rework-demo.ts`:

```ts
/**
 * Sim-only rework demo (rework-loop spec §11 "Sim mode", plan ruling R14): two agents, two items on one file. The first
 * lands. The second wins its race, conflicts in the merge queue (`[conflict-once]`), gets a conflict slot, syncs its
 * base (attemptSyncBase) and pushes a rebased head as the same candidate, which lands. It plays the agents through the
 * Queen's attempt RPCs, because the sim has no MCP server and no Artifacts.
 */
import type {
  AttemptBaseReady,
  AttemptIntent,
  AttemptIntentDecision,
  AttemptPushed,
  AttemptPushedResult,
  AttemptReady,
  AttemptResult,
  AttemptSyncBase,
  AttemptView,
  FileWorkItemInput,
  McpAgentIdentity,
  UpdateHiveSettings,
} from "@queenos/queen-types";
import { fakeSha } from "./sim-ports";

/** The QueenNode RPCs the demo calls (a DO stub fits it). */
export interface DemoQueen {
  updateSettings(input: { hive: string; user: string; patch: UpdateHiveSettings }): Promise<unknown>;
  fileWorkItem(input: { hive: string; user: string; item: FileWorkItemInput }): Promise<{ item: { itemId: string } }>;
  attemptIntent(input: AttemptIntent): Promise<AttemptIntentDecision>;
  attemptBaseReady(input: AttemptBaseReady): Promise<{ outcome: string }>;
  attemptReady(input: AttemptReady): Promise<AttemptResult>;
  attemptPushed(input: AttemptPushed): Promise<AttemptPushedResult>;
  getAttempt(attemptId: string): Promise<AttemptView | null>;
  attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult>;
}

const OWNER = "sim@example.com";

export async function reworkDemo(q: DemoQueen, hive: string, opts: { tick: () => Promise<void>; maxTicks?: number }): Promise<string[]> {
  const log: string[] = [];
  const say = (line: string) => log.push(line);
  await q.updateSettings({ hive, user: OWNER, patch: { executors: "external", race: { entryWindowMs: 0 } } as UpdateHiveSettings });
  const titles = ["Add a tip jar [touch:src/shared.js]", "Add a badge [touch:src/shared.js] [conflict-once]"];
  const agents: McpAgentIdentity[] = ["opus", "kimi"].map((name, i) => ({ agentId: `ag_${(i + 1).toString(16).padStart(32, "0")}`, name, model: "sim-model", role: "worker", owner: OWNER }));
  const attempts: { attemptId: string; repo: string; baseSha: string; agent: McpAgentIdentity }[] = [];
  for (const [i, title] of titles.entries()) {
    const { item } = await q.fileWorkItem({ hive, user: OWNER, item: { kind: "feature", title } });
    const d = await q.attemptIntent({ hive, owner: OWNER, agent: agents[i]!, target: { itemId: item.itemId } });
    if (d.verdict !== "accept") throw new Error(`rework demo: attempt refused: ${d.code} ${d.message}`);
    const baseSha = d.base.kind === "existing" ? d.base.baseSha : fakeSha(`base:${item.itemId}`);
    if (d.base.kind === "create") await q.attemptBaseReady({ hive, itemId: item.itemId, baseRepo: d.base.baseRepo, baseSha });
    const r = await q.attemptReady({ hive, attemptId: d.attemptId, repo: d.repo, baseSha, expiresAt: Date.now() + 7_200_000 });
    if (!r.ok) throw new Error(`rework demo: attempt not ready: ${r.code} ${r.message}`);
    attempts.push({ attemptId: d.attemptId, repo: d.repo, baseSha, agent: agents[i]! });
    say(`${agents[i]!.name}: attempt ${d.attemptId} READY on item ${item.itemId} "${title}"`);
  }
  const push = async (a: (typeof attempts)[number], n: number, title: string) => {
    const after = fakeSha(`demo:${a.attemptId}:${n}`);
    const r = await q.attemptPushed({ hive, attemptId: a.attemptId, repo: a.repo, before: n === 1 ? a.baseSha : fakeSha(`demo:${a.attemptId}:${n - 1}`), after, title, message: title });
    say(`${a.agent.name}: pushed ${after.slice(0, 7)} (${r.disposition ?? r.outcome}; train ${r.trainId ?? "?"})`);
  };
  const until = async (attemptId: string, done: (v: AttemptView) => boolean, what: string): Promise<AttemptView> => {
    for (let i = 0; i < (opts.maxTicks ?? 400); i++) {
      const v = await q.getAttempt(attemptId);
      if (v && done(v)) return v;
      await opts.tick();
    }
    throw new Error(`rework demo: timed out waiting for ${what}`);
  };
  const [first, second] = [attempts[0]!, attempts[1]!];
  await push(first, 1, "Add a tip jar");
  await until(first.attemptId, (v) => v.state === "LANDED", "the first attempt to land");
  say(`${first.agent.name}: ${first.attemptId} LANDED`);
  await push(second, 1, "Add a badge");
  const rejected = await until(second.attemptId, (v) => v.state === "REJECTED" && v.rework?.reason === "conflict", "the second winner's conflict slot");
  say(`${second.agent.name}: REJECTED (conflict in ${rejected.train?.conflict?.paths.join(", ") ?? "?"}); rework slot ${rejected.rework!.round} due ${new Date(rejected.rework!.dueAt).toISOString()}`);
  const main = fakeSha(`main:demo:${hive}`);
  const synced = await q.attemptSyncBase({ hive, attemptId: second.attemptId, owner: OWNER, agentId: second.agent.agentId, baseSha: main });
  if (!synced.ok) throw new Error(`rework demo: sync_base refused: ${synced.code} ${synced.message}`);
  say(`${second.agent.name}: sync_base → main@${main.slice(0, 7)}`);
  await push(second, 2, "Add a badge (rebased on main)");
  const landed = await until(second.attemptId, (v) => v.state === "LANDED", "the rebased head to land");
  say(`${second.agent.name}: rebased head ${landed.headSha?.slice(0, 7) ?? "?"} LANDED as the same candidate in race ${landed.raceId ?? "?"}`);
  return log;
}
```

- [ ] **Step 5: The sim route**

`apps/queen/src/sim/worker.ts`, in `fetch`, after the localhost check:

```ts
    const url = new URL(request.url);
    // Rework demo (rework-loop spec §11): POST /sim/rework-demo?hive=<slug> plays two agents to a conflict, a rework and a landing.
    if (url.pathname === "/sim/rework-demo" && request.method === "POST") {
      const hive = url.searchParams.get("hive") ?? "";
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(hive)) return Response.json({ error: "hive=<slug> required" }, { status: 400 });
      const q = env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(hive)) as unknown as DemoQueen;
      const log = await reworkDemo(q, hive, { tick: () => new Promise((r) => setTimeout(r, 1000)), maxTicks: 300 });
      return Response.json({ hive, log });
    }
```

(Reuse the existing `new URL(request.url)` if `fetch` already builds one.) Import `reworkDemo, type DemoQueen` from `./rework-demo`.

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @queenos/queen test -- test/sim-rework.test.ts`
Expected: PASS. If it times out on "the second winner's conflict slot", check that the item title reaches `MergeMember.title` (the first line of `composePrompt(item)`), so the marker is visible to `runMerge`.

- [ ] **Step 7: Try it in `dev:sim` (optional, local only)**

```bash
export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH
pnpm --filter @queenos/queen dev:sim -- --port 8797 &   # note the PID it prints; kill only that PID afterwards
curl -s -X POST "http://localhost:8797/sim/rework-demo?hive=rework-demo" | jq .
kill <that PID>
```

Expected: the JSON `log` ends with "LANDED as the same candidate". Never `pkill`.

- [ ] **Step 8: Package tests, typecheck, full gate**

Run: `pnpm --filter @queenos/queen test && pnpm --filter @queenos/queen typecheck`, then `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`.

- [ ] **Step 9: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add apps/queen/src/sim/sim-v2.ts apps/queen/src/sim/sim-ports.ts apps/queen/src/sim/rework-demo.ts apps/queen/src/sim/worker.ts apps/queen/test/sim-rework.test.ts
git commit -m "$(cat <<'MSG'
feat(queen): sim rework demo ([conflict-once], POST /sim/rework-demo)

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11: Docs (spec §8 guidance)

**Model: Haiku** for the protocol tables and the HANDOFF entry; **Sonnet** for the SKILL.md orchestrator and rework sections (they need judgement). Docs only. **Gate:** if C2 failed, every "rebase ... push --force-with-lease" below becomes "merge queen/main ... push origin HEAD:main". If C1 failed, drop the `sync_base` lines and say "rebase however you can; the Queen gates the push against the item's base".

**Files:**
- Modify: `plugins/queenos/skills/queenos-mcp/SKILL.md` (frontmatter description; §2 Orchestrator; §3 Worker step 6; new `## 3c. The rework loop`; §4 Races)
- Modify: `templates/worker-starter/AGENTS.md` (`## Through MCP`, step 4)
- Modify: `docs/agent-protocol.md` §8 (tools table, verdict kinds, states, `rework`)
- Modify: `docs/superpowers/specs/2026-10-12-queenos-mcp-design.md` (`## Amendments (Oct 13, rework loop)` after the fix-wave amendments)
- Modify: `docs/HANDOFF.md` (milestone entry in §2; the HANDOFF rules stay as they are)

**Interfaces:** none (text). Every tool name, field and state below must match Tasks 1-8 exactly: `sync_base`, `reject`, `rework {reason, dueAt, round}`, kinds `findings | infra | conflict | human`, candidate outcome `REWORK`, race state `REWORKING`, guardrails `reworkWindowMs`, `reworkHoldMs`, `maxReworksPerAttempt`, `maxRaceReopens`.

- [ ] **Step 1: SKILL.md**

Frontmatter `description`: add `sync_base, reject` to the tool list.

Replace `## 2. Orchestrator` with:

```markdown
## 2. Orchestrator

A goal is a work spec, like a ticket: write it for whoever picks it up. Say the outcome, the acceptance criteria and the constraints (files not to touch, behaviour to keep). Its items are the units of work.

`create_goal({hive, title, description, judge?: "auto"|"pick", entryWindowMs?})` returns `{goalId, itemId}`. Give workers the `hive` and `itemId` in their prompt. Only orchestrators may file goals (`FORBIDDEN_ROLE`), and only in an external hive (`HIVE_NOT_EXTERNAL`).

**Judging a "pick" race.** When `get_item` shows the race `PICKING`, compare the candidates (previews, findings, diff size) and either `pick({hive, raceId, attemptId})` or `reject({hive, itemId, target, reason})`. `target` is one `attemptId`, or `"all"`. The reason must be actionable, because the agent fixes against it: say what is wrong and what you expect instead ("the jar overlaps the footer on mobile; keep it inside the card"), not "bad". A rejected candidate gets a rework slot and the race waits for its fix. `reject` all reopens entries for new agents too. Each reject uses one of the race's reopens (3); past that, `reject` all ends the race (`fallback: true`) and the item reopens to any agent.
```

In `## 3. Worker` step 6, replace the `findings` bullet with:

```markdown
   - `kind: "findings"`: read `findings` and `note`, fix, commit, push `main` again before `rework.dueAt` (see 3c).
   - `kind: "conflict"`: your change conflicts with work that landed after your base. Call `sync_base({attemptId})`, run its `syncCommand`, `git -C <dir> rebase queen/main`, resolve keeping both behaviours, run the tests, then `git -C <dir> push --force-with-lease origin HEAD:main` before `rework.dueAt`.
   - `kind: "human"`: a judge rejected it; the finding is their reason. Address it and push again before `rework.dueAt`.
```

Add after `## 3b. Errors`:

```markdown
## 3c. The rework loop

A rejection while the item is still open comes with a **rework slot**, `rework: {reason, dueAt, round}` on `get_attempt` / `wait` / `get_verdict`. Until `dueAt` (30 min by default) you may push a fix as the **same candidate**, even after the race's entry window closed. Your fix rejoins your race; it never becomes a follow-up. `next` in `get_verdict` says what to do. A push closes the slot; pushing again before that head's verdict replaces it in place.

- `sync_base({attemptId})` works while READY (before your first push, to start from a newer `main`) or REJECTED with an open slot. It fetches the hive's current `main` as `queen/main` with a 30 min read-only token, and your next push is gated against that `baseSha`. If its command says "main moved", call it again.
- If `rework` is `null` after a rejection, no slot was left (3 per attempt) or it expired. The item then reopened to any agent: `start_attempt` again for a fresh base.
- `end_attempt` gives the slot up. If yours was the race's last hope, the race ends and the item reopens.
- Infra verdicts never use a slot: `retry_gates`.
```

In `## 4. Races`, append: `` `reject({hive, itemId, target, reason})` sends candidates of a race waiting for a pick back for rework (2. Orchestrator). A race in `REWORKING` waits for its winner's fix after a merge conflict; it takes no new attempts (`ITEM_NOT_ACCEPTING`). ``

- [ ] **Step 2: Template AGENTS.md**

In `## Through MCP`, replace step 4 with:

```markdown
4. `wait({attemptId, until: "verdict"})` until `changed: true`. On REJECTED: `get_verdict` and read `kind` and `rework`. `findings`: fix and push `main` again. `conflict`: `sync_base({attemptId})`, run its `syncCommand`, `git rebase queen/main`, run the tests, `git push --force-with-lease origin HEAD:main`. `human`: address the judge's reason and push again. With a `rework` slot your push before `rework.dueAt` stays the same candidate. `infra` (the gate could not run, not a verdict on your change): call `retry_gates({attemptId})` and wait again; do not push empty commits. If the token is near expiry, `refresh_attempt` and run its `configCommand` first.
```

- [ ] **Step 3: `docs/agent-protocol.md` §8**

- In the **Procedure** paragraph, after "... `findings` means fix and push `main` again;", add: "`conflict` means `sync_base`, rebase onto `queen/main` and push with `--force-with-lease`; `human` means address the judge's reason and push; with a `rework` slot, push before `rework.dueAt` to stay the same candidate;".
- Tools table: add the rows

```markdown
| `sync_base` | Your attempt (READY, or REJECTED with an open rework slot): fetch the hive's current `main` as `queen/main` (30 min read token, inside `syncCommand` only); your next push is gated against it |
| `reject` | Send candidates of a PICKING race back for rework with an actionable reason (`target`: an attemptId or `"all"`) |
```

- Attempt states paragraph, append: "A REJECTED attempt may hold a rework slot `rework: {reason: findings|conflict|human, dueAt, round}` (at most 3 per attempt). Its race candidate reads `REWORK` (pending until the slot's hold ends), and a race whose winner is reworking a merge conflict reads `REWORKING` (no new attempts)."
- Error list: no new codes (`sync_base` and `reject` use the existing ones; spec §9).
- **Verdict kinds** paragraph: add "`conflict`: a merge conflict with work that landed (the findings are the conflicting paths): `sync_base`, rebase, push. `human`: a judge's reject; the finding is their reason."

- [ ] **Step 4: MCP spec amendment**

Append after `## Amendments (Oct 13, fix wave)` in `docs/superpowers/specs/2026-10-12-queenos-mcp-design.md`:

```markdown
## Amendments (Oct 13, rework loop)

Design: `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md`. A rejected attempt fixes and re-pushes as the same candidate within a rework slot. The tool count is now **19** (`sync_base`, `reject`). The verdict kinds are `findings | infra | conflict | human`, and attempt views carry `rework {reason, dueAt, round}`. A race can be `REWORKING`, a candidate `REWORK`. A conflicted winner now reads `verdict: "rejected"`, `kind: "conflict"` (it read `passed`).
```

- [ ] **Step 5: HANDOFF milestone**

In `docs/HANDOFF.md` §2 (State of the system), add a dated bullet at the top of the list:

```markdown
- **2026-10-13: rework loop** (spec `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md`, plan `docs/superpowers/plans/2026-10-13-queenos-rework-loop.md`). A rejected attempt gets a rework slot (findings, conflict, human) and re-pushes as the same candidate. `sync_base` and `reject` (MCP, 19 tools), dashboard Reject / Reject all, races `REWORKING`, migration v19, sim `POST /sim/rework-demo`. Deploy order: Queen, then `queenos-mcp`, then the edge (Task 12).
```

- [ ] **Step 6: Check consistency, full gate, commit**

Run: `/usr/bin/grep -rn "sync_base\|REWORKING\|rework.dueAt" plugins/queenos/skills/queenos-mcp/SKILL.md templates/worker-starter/AGENTS.md docs/agent-protocol.md | head -40`. Read the hits once against Tasks 1-8 names. Then the full gate (docs do not change it, but the gate is the rule). Then:

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add plugins/queenos/skills/queenos-mcp/SKILL.md templates/worker-starter/AGENTS.md docs/agent-protocol.md docs/superpowers/specs/2026-10-12-queenos-mcp-design.md docs/HANDOFF.md
git commit -m "$(cat <<'MSG'
docs: rework loop guidance (goals as work specs, judging, sync_base)

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: Deploy commands and the live test checklist (the USER runs them)

**Model: Haiku** (writes the checklist into HANDOFF; runs nothing that deploys). Production deploys are the user's.

**Files:**
- Modify: `docs/HANDOFF.md` §4 (Deploy state): the pending deploy list and the live checklist below

- [ ] **Step 1: Write the deploy list into HANDOFF §4**

```markdown
**Pending deploy: rework loop (Tasks 1-11).** Order matters (spec §10): the Queen first (migration v19, it produces the new values), then `queenos-mcp` (19 tools), then the edge (the dashboard assets). Older MCP / dashboard builds never see REWORKING / REWORK / the new kinds until the Queen produces them, so deploy all three in one window.

    export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH
    cd ~/repositories/queenos/apps/queen && pnpm run deploy
    cd ~/repositories/queenos/apps/mcp && pnpm run deploy
    cd ~/repositories/queenos/apps/dashboard && pnpm build && cd ../edge && pnpm run deploy
```

(Check `apps/edge/package.json` for how the edge picks up the dashboard build before you write the last line. Use the same sequence HANDOFF §4 already documents for edge deploys, if it differs.)

- [ ] **Step 2: Write the live checklist (spec §11 "Live, after deploy")**

```markdown
**Live checks after the rework-loop deploy** (Herdr workers, hive `demo`, external executors):
1. **Conflict → sync_base → rebase → land.** An orchestrator files two goals editing the same file (`src/features.js`). Two workers each take one. The second winner reads REJECTED `kind: "conflict"` with `rework.dueAt`, calls `sync_base`, runs `syncCommand`, rebases onto `queen/main`, pushes `--force-with-lease`, and lands as the same candidate (same race id, no follow-up item). Check: `get_item` shows one race; the dashboard shows "Reworking · ... due in mm:ss" while it is fixed.
2. **Mid-race fix after entry close.** A goal with `entryWindowMs: 120000` and two workers; one pushes a deliberate lint failure. After the window closes it pushes the fix. The fix rejoins the race (no "(follow-up)" item) and the race decides with both.
3. **Reject all with a reason.** A `judge: "pick"` goal with two passing candidates. Click **Reject all**, type a reason, Send. The race goes back to RACING with entries open; both agents' `get_verdict` read `kind: "human"` with the reason; their fixes come back, and the race picks again.
Record the results (pass / fail, race ids, anything odd) in HANDOFF §3.
```

- [ ] **Step 3: Commit**

```bash
/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"   # must print: scan exit 1
git add docs/HANDOFF.md
git commit -m "$(cat <<'MSG'
docs(handoff): rework loop deploy order and live checklist

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

Then STOP and hand the deploy list and checklist to the user.

---

## Spec coverage (self-review)

| Spec | Where |
|---|---|
| §1 Summary, §3 goals | Tasks 2-9 |
| §2.1 conflicting winner stranded | Task 3 (`winnerRejected`, REWORKING), Task 5 (R13 loads the DECIDED race), Task 6 (end to end) |
| §2.2 agent cannot rebase | Task 7 (`attemptSyncBase`), Task 8 (`sync_base`) |
| §2.3 the verdict lies | Task 5 (`attemptVerdict` / kind), Task 7 (note body), Task 8 (`next`) |
| §2.4 a re-push opens a second race | Task 3 (`pushed` rejoins REWORKING), Task 6 (`reworkRejoin`) |
| §2.5 no grace mid-race | Task 2 (REWORK, holds), Task 3 (rejoin after close), Task 6 |
| §2.6 caps, early expiry | Task 2 (`maxReworksPerAttempt`), Task 4 (`maxRaceReopens`), Task 5 (`expires_at`, refresh, watchdog) |
| §2.7 reject half built | Task 4 (planner), Task 7 (RPC, route), Task 8 (MCP), Task 9 (dashboard) |
| §4 the rule; infra never uses a slot; attempts only | Task 2 (`giveSlot`, `isInfraStopped`), Task 5 (`rework` only for external hives) |
| §5.1 attempt slot, expiry, late push | Tasks 2, 5, 6 |
| §5.2 RACING candidate, holds, LOST at decision, PICKING entry | Task 2; human hold in Task 4 |
| §5.3 REWORKING | Tasks 3, 5, 6 |
| §5.4 human reject while PICKING, reopens | Task 4 |
| §5.5 guardrails | Task 1 (schema, clamps), Task 5 (`decide` passes them) |
| §5.6 fallback, fresh base | Task 3 (`abandonRework`), Task 5 (R6 `releaseBases`), Task 6 (fresh base test) |
| §5.7 lifecycle | Tasks 2-4 (planner transitions), 5-6 (attempt rows) |
| §6.1 `sync_base` flow and command | Task 7 (Queen), Task 8 (MCP); C1-C3 Task 0 |
| §6.2 verdict fix, kinds, `next`, note body, `wait` | Tasks 5, 7, 8 (`wait` already returns on REJECTED; views carry `rework`) |
| §7 reject with reason (external, swarm, contract, dashboard, agent side) | Tasks 4, 7, 8, 9 |
| §8 guidance | Task 8 (descriptions), Task 11 (docs) |
| §9 errors | Task 8 (`sync_base`: CONFLICT, ATTEMPT_EXPIRED, ARTIFACTS_UNAVAILABLE 5 s, UNAVAILABLE, FORBIDDEN_OWNER; `reject`: CONFLICT, INVALID_INPUT, NOT_FOUND, UNAVAILABLE) |
| §10 migration v19, back-compat | Task 1; deploy order Task 12 |
| §11 tests (planner, Queen, MCP, dashboard, sim, live) | Tasks 2-4, 5-7, 8, 9, 10, 12 |
| §12 review focus | dueAt mid-gate (Task 3 + Task 6 "survives the expiry alarm"); hold ends in the alarm (Task 2 `reworkDeadlines`, Task 5 `armWatchdog`); stale `deadlineAt` (Task 4 human hold test, R5); sync racing a landing (Task 8 `test ... = sha` line); two pushes in one slot (Tasks 3, 6); reject-all with a REWORK candidate (cannot occur: Task 2 ends REWORK candidates before PICKING); fallback while the old train tears down (Task 6) |
| §13 open checks | Task 0 (C1-C3), C4 resolved (Global Constraints) |
| §14 future | none (no code) |
