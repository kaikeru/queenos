# Drone coding harness: design (2026-10-05)

Follows the hybrid layout in `docs/harness-spike.md` §5. In short, the drone
Workflow is unchanged except for one step. `generate change set` becomes **`agent: build`**, which runs a
`@cloudflare/think` coding agent (`BuilderAgent`, one DO per attempt and model) against a workspace seeded from the train
branch. The step returns a capped **file overlay**. Commit, notes, push, report and audit then run exactly as they do today.

## 1. Step structure (`apps/drones/src/orchestrate.ts`)

```
clock: start → audit: running
[live + DRONE_HARNESS=agent]   agent: build            (AGENT_STEP: timeout 8 min, retries 1)
[live + DRONE_HARNESS=single]  generate change set     (unchanged kill switch)
[scripted]                     generate change set     (unchanged, never touches Think)
clock: generated → clone, commit, note, push → report: build result → audit: passed
```

Body of `agent: build` (`src/agent/run.ts`, `runAgentBuild`):
1. Clone the train branch (hive-kit, depth 1, read token) and read every text file ≤ 256 KiB (minus `.git/` and `node_modules/`) into
   `base: Record<path, content>`.
2. For each `model` in `agentModelsFor(task)`, meaning the Queen's `modelChoice.model` plus its `fallbacks`, de-duplicated, with
   **`TOOL_LOOP_EXCLUDED` (`@cf/qwen/qwen3.8-27b`) removed**, or `MODEL_BUILDER` if nothing is left:
   - `stub = getAgentByName(env.BUILDER, "<instanceId>|<model>")`
   - `r = await stub.build({ base, task, model, idempotencyKey: "<instanceId>:<model>", timeoutMs, skipCache })`
   - `overlay = diff(base, r.files)`, then validate: path guard, caps, `templateFitProblems`.
   - Accept when `r.finish && r.verify?.ok && overlay is non-empty && no fit problems`. Otherwise add `model` to `failedModels`
     with a one-line reason and try the next model.
3. Return `{ changeSet (files + deletes + reasoningSteps + discardedPaths), model, failedModels, usage, trace }`. The result
   is ≤ 512 KiB of files plus ≤ 20 trace lines, well under the 1 MiB step limit.
4. If no model succeeds: throw `AllModelsFailedError` (non-retryable), which leads to `failBuild` and a REJECTED audit as today. An
   `AiGatewayError`/RPC error raised *outside* any model's loop (e.g. the clone) stays retryable.

`DronePorts` gains `agent: AgentPort | null` (`build(name, input) → AgentRunResult`). In prod it is the DO stub. Tests use an
in-memory fake. `runDrone` gains the Workflow `instanceId` (from `event.instanceId`).

## 2. `BuilderAgent` (`src/agent/builder-agent.ts`, `extends Think<Env>`)

| Override | Value |
|---|---|
| `maxSteps` | 16 |
| `workspaceBash` | `false` |
| `getModel()` | the `model` stored at `build()`. A test subclass returns `MockLanguageModelV3`. |
| `getGateway()` | `{ id: AI_GATEWAY_ID, skipCache, metadata: { promptId, trainId, action, role: "builder" } }` |
| `getSystemPrompt()` | `AGENT_SYSTEM_PROMPT` (§5) |
| `getTools()` | `{ verify, finish }`. Think auto-merges read/write/edit/list/find/grep/delete. |
| `beforeTurn()` | `{ stopWhen: [finishAccepted, tokenBudgetExceeded(150k input)] }` |
| `onStepFinish` | accumulates usage and step count into DO SQL (survives eviction) |

**`build(input)` RPC, idempotent:**
1. `seed`: if the `drone_meta` row is missing, write every `base` file into `this.workspace`, store `base` in `drone_base` and the run
   config (model, task fields, skipCache) in `drone_meta`. A re-attach skips this step.
2. `submitMessages([userMessage(task)], { idempotencyKey })`. A retried step gets the existing submission back
   (`accepted: false`) and **re-attaches** instead of starting a second turn.
3. `waitForSubmission(id, { timeoutMs })`. If the wait rejects (object restarted), loop until the deadline. If it times out,
   call `cancelSubmission` and report `timeout`.
4. Collect from durable state only: the workspace snapshot, then `finish` args and `verify` outputs from the persisted message
   tool parts (`getMessages()`). The trace comes from those same tool parts, and usage from `drone_meta`.

DO naming uses one object per (Workflow instance, model). A Queen re-dispatch (`-build-2`) or the next fallback model always starts
on a clean transcript and workspace. A Workflow step retry hits the same object and key. Objects aren't deleted (SQLite
DOs are cheap; cleanup can come later with a `deleteAll` alarm).

## 3. Tools (`src/agent/tools.ts`, `src/agent/verify.ts`)

- **Workspace tools** come from Think: `read`, `write`, `edit`, `list`, `find`, `grep`, `delete`. Writes to reserved paths are
  not blocked at the tool level, because Think owns those tools. The `finish` tool and the step-level overlay check reject them instead.
- **`verify({ paths?: string[≤5] })`** snapshots the workspace and runs `verifyWorker(loader, files, ["/", "/health", ...paths])`:
  - Every `src/**/*.js` file becomes a module and the entry point is `.queen/deploy.json` `main`.
  - It runs with `globalOutbound: null` and `cpuMs: 100`.
  - It returns `{ ok, probes: [{path, status, contentType, bodyStart(400)}], problems[], error? }`.
  - `ok` requires all of the following: every probe returns < 500, `/health` returns 200 JSON, and `templateFitProblems(overlay)` is empty (this runs the existing static checks).
  - It records the snapshot hash of the last passing verify.
  - It is capped at 6 calls. If there is no `LOADER` binding it returns `{ ok: true, skipped: true }` (degrades, per spike risk 8).
- **`finish({ summary ≤500, reasoningSteps[1..6], discardedPaths[≤10] })`** is rejected (returns `{ ok:false, error }`, so the loop
  continues) in any of these cases: no change was made; the overlay touches `.git/`, `.queen/`, `package.json` or `wrangler.*`; or the current snapshot hash ≠ the last
  *passing* verify hash ("verify after your last edit"). When it is accepted, the turn stops (`finishAccepted`), so there is no extra step after finish.

## 4. Budgets and failure modes

| Budget | Value | Failure → |
|---|---|---|
| Steps per model | 16 (`maxSteps`) | no finish, so the next model is tried |
| Input tokens per model | 150k cumulative (`stopWhen`) | the same |
| Wall time per model | min(240 s, remaining) via `waitForSubmission` + `cancelSubmission` | the same (reason `timeout`) |
| Wall time, whole agent phase | 7 min from the drone's `clock: start` (replay-stable) | the remaining models are skipped; then `AllModelsFailedError` |
| Step | timeout 8 min, retries 1 (re-attach) | `failBuild("generation")` |
| Queen watchdog | 10 min total | 7 min agent + about 1 min git leaves headroom |
| verify | 6 calls, 100 ms CPU, no network | the tool returns an error and the model must finish without it, so finish is refused |
| Overlay | ≤ 20 files, ≤ 64 KiB each, ≤ 512 KiB total (existing caps) | the model fails |

Additional failure modes:
- **Provider error** (4xx/5xx/3046): the submission ends as `error`, and the next model is tried.
- **DO reset after a deploy**: Think recovers the turn, `waitForSubmission` rejects, and `build()` re-waits. If the RPC itself dies,
  the step retries and re-attaches through the same idempotency key.

REWORK sets `skipCache: true`. In a rework run the gateway cache would only replay the rejected attempt.

## 5. Prompt (`src/agent/prompt.ts`)

The system prompt is the spike's `TOOL_SYSTEM_PROMPT`, extended with:
- The template contract: plain ES modules, relative `.js` imports, no npm, no Node built-ins.
- Edit the code that implements existing behaviour; add a feature module only for new endpoints.
- **Feature modules may `export const path = "/status"`** to own a top-level route.
- Keep `/health` JSON.
- Never touch `.queen/`, `package.json` or wrangler config.
- The work loop: look → edit → verify → finish.

The user message contains `<request>`, `<hive_memory>` (ragContext) and, on REWORK, a **first-position**
`<rework_feedback>` block with the Scribe/reviewer summary, plus "the previous attempt was rejected for this reason; fix it". It contains no
repo dump, because the agent reads files itself.

## 6. Template routing (`templates/worker-starter`)

The router keeps `/` and `/health` built in. Then a feature with `typeof f.path === "string"` and `f.path === url.pathname` is served. Then
`/features/<slug>` as before, so existing hives and modules keep working. `templateFitProblems` accepts an optional `path` export
and rejects one that does not start with `/` or that collides with `/health`. Run `apps/provisioner/scripts/gen-templates.mjs` to regenerate,
and update the provisioner tests that pin template content. The README documents `path`.

## 7. Ledger and BuildResult mapping

| Field | Source |
|---|---|
| `model` | the model whose run was accepted |
| `reasoningSteps` | `finish.reasoningSteps`, then trace lines (`read src/index.js`, `edit src/index.js`, `verify / 200 text/html; /health 200 json`, …), capped at 20 × 2,000 chars |
| `discardedPaths` | `finish.discardedPaths` + `model <id>: <reason>` for each failed model (cap 50) |
| `executionTimeMs` | unchanged |
| BuildResult | `model`, `failedModels` (≤5), `buildMs` = agent ms + push ms (unchanged contract, so the router learns as today) |

The usage totals are logged and kept in the step result. Reporting them to the Queen would need a `BuildResult` field
(queen-types). That is proposed to the coordinator, not done here.

## 8. Config

- **Deps, pinned exact in `apps/drones`:** `@cloudflare/think@0.20.0`, `agents@0.26.0`, `ai@7.0.127`, `workers-ai-provider@4.0.0`.
- **`wrangler.jsonc`:** add DO binding `BUILDER` → `BuilderAgent`, `migrations: [{ tag: "v1", new_sqlite_classes: ["BuilderAgent"] }]`,
  `worker_loaders: [{ binding: "LOADER" }]`, var `DRONE_HARNESS: "agent"`. The test env gets the same DO binding and migration (for the
  fake-model smoke test) and keeps `DRONE_LLM_MODE: scripted`.
- **`CLAUDE.md`:** add a dependency exception. Think/agents need the `nodejs_compat` that compat date 2026-10-02 implies. *Our code never
  imports Node built-ins.*
- **Coordinator (catalog/router):** the drone filters `TOOL_LOOP_EXCLUDED` itself. The suggested follow-up is a catalog field
  (`toolLoop: false` on Qwen) so the router stops picking it for builder/rework. Until then, a Queen choice of Qwen falls through to its
  fallbacks.

## 9. Test plan (vitest-pool-workers, `apps/drones/test`)

| Test file | Covers |
|---|---|
| `agent-verify.test.ts` | `verifyWorker` against a fake loader: modules and main come from deploy.json, 5xx → not ok, `/health` non-JSON → not ok, missing loader → skipped, load throws → error |
| `agent-tools.test.ts` | `finish` refusals (no change, reserved path, stale verify) and acceptance; verify call cap |
| `agent-overlay.test.ts` | the base/final diff (add, modify, delete), caps, and the reserved-path guard |
| `agent-run.test.ts` | with a fake `AgentPort`: fallback order, Qwen exclusion, failure reasons in `failedModels`, the budget deadline skipping models, `AllModelsFailedError`, re-attach (the same idempotency key on a retried step gives one submission) |
| `agent-ledger.test.ts` | trace → reasoningSteps/discardedPaths caps |
| `orchestrate.test.ts` (extended) | agent mode end to end with fake ports: the overlay including a delete is committed, `BuildResult.model/failedModels`, and a budget exhaustion is reported as a failure; scripted mode never calls the agent port |
| `builder-agent.test.ts` | a real `BuilderAgent` DO driven by `MockLanguageModelV3` (read → edit → verify → finish), the idempotent re-attach on a second `build()`, and no-finish → `finish: null` |
| template tests | router `path` exports (via the fake loader + verify), plus the provisioner template tests |

Green bar: `pnpm turbo run build typecheck lint test --force --continue`.
