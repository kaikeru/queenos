# Spike: rebuild drones on Cloudflare's agent harness? (2026-10-05)

**Question.** Builder drones are single-shot: the model gets repo context, returns one JSON change set, and gets one
repair turn. It can't read files on demand, make small edits, or check its work. In the first live build,
"change our status page from JSON to HTML" produced a new `/features/<slug>` page instead of changing `/`. Should
drones move to Cloudflare's agent pieces (Think, shell, codemode/Worker Loader, worker-bundler)?

**Answer: yes, as a hybrid.** Keep the drone Workflow as the orchestrator, which leaves the Queen dispatch, the
fixed-timestamp commit/push and the reporting unchanged. Replace the single `generate change set` step with a
**Think agent** (one Durable Object per build attempt) that edits a workspace with tools and checks its work in a
**Dynamic Worker** (Worker Loader). Adopt Worker Loader verify now. Defer worker-bundler and codemode.

**Evidence headline.** 13 of 13 completed runs, across 3 models and 2 harnesses, edited the right file
(`src/index.js`, nothing else). In every one, `/` came back `text/html` 200 and `/health` stayed JSON 200 when
loaded in a sandbox. This held even with the **old** routing rules in the prompt (3/3). The drone looks at the
router before editing, and that alone avoids the `/features/<slug>` mistake. There were 3 failures: 2 Workers AI
timeouts on Qwen 3.8 and 1 Think DO reset caused by a deploy mid-run.

Prototype: `spikes/harness/` (throwaway Worker `queenos-day1-harness`, now deleted; the code was removed from the repo, see commit 459d26a). Raw outputs:
`spikes/harness/results/*.json`.

---

## 1. Packages

Versions are from `pnpm view` on 2026-10-05. Bundle sizes are from `wrangler deploy --dry-run` with compat date
2026-10-02 and no flags; each row is a minimal entry importing only that piece (`spikes/harness/size/*`).

| Package | Version | Main exports | Peer / notable deps | Bundle (raw / gzip) | Node built-ins pulled in |
|---|---|---|---|---|---|
| `ai` + `workers-ai-provider` | 7.0.127 / 4.0.0 | `generateText`, `ToolLoopAgent` (exported as `Experimental_Agent`), `stepCountIs`/`isStepCount`, `hasToolCall`, `tool`; `createWorkersAI({ binding, gateway })` | zod; provider peers `@ai-sdk/*` v4 | 743 KiB / 146 KiB | **none** |
| `@cloudflare/think` | 0.20.0 (experimental) | `Think`, `Workspace`, `Session`; subpaths `/workflows` (`ThinkWorkflow`, `step.prompt`), `/tools/workspace` (`createWorkspaceTools`), `/tools/execute`, `/tools/fetch`, `/extensions` | peers `ai@^7`, `agents >=0.25 <1`, zod, react (optional); deps `just-bash`, `@cloudflare/shell`, `@cloudflare/codemode`, `workers-ai-provider`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `chat` | 7.9 MiB / 1.6 MiB (DO class only) | `node:async_hooks`, `crypto`, `diagnostics_channel`, `os`, `zlib` |
| `agents` | 0.26.0 | `Agent`, `getAgentByName`, `routeAgentRequest`, `agents/workflows` | (pulled in by Think) | included above | (async_hooks) |
| `@cloudflare/shell` | 0.4.3 (experimental) | `Workspace` (SQLite/D1/custom `SqlBackend`, optional R2), `InMemoryFs`, `/git` `createGit(fs)`, `/workers` `stateTools` | isomorphic-git, codemode | 537 KiB / 112 KiB (`createGit`+`InMemoryFs`) | `node:crypto`, `diagnostics_channel`, `util` |
| `@cloudflare/codemode` | 0.5.3 | `DynamicWorkerExecutor`, `resolveProvider`; `/ai`, `/mcp` | peers ai, zod, MCP SDK (optional) | (in Think) | none of its own; its executor loads sandboxes with `nodejs_compat` on |
| `@cloudflare/worker-bundler` | 0.2.5 (experimental) | `createWorker`, `createApp`, `handleAssetRequest` | esbuild-wasm 0.28.1, **typescript 6**, sucrase | 14.2 MiB / 3.8 MiB (incl. `esbuild.wasm`) | none, but it needs a `.wasm` module import (workerd only) |
| `@cloudflare/ci` | 0.2.0 (Apache-2.0) | `CIWorkflow`; `/worker`, `/worker/source-control` | `@cloudflare/sandbox` 0.12.1; README: needs `nodejs_compat` | ships TS source | (sandbox) |

**`nodejs_compat`.** Our compat date 2026-10-02 turns `nodejs_compat` (+v2) on by default (docs/discovery.md §2),
so "nodejs_compat off" isn't actually an option for us. I checked what would break if it were. With compat date
2025-06-01 and no flags, `ai` + `workers-ai-provider` builds cleanly. Think fails the build ("Build failed with 3
errors" on `node:async_hooks`, `node:crypto`, `node:os`). `createWorkspaceTools` brings in `node:zlib` through
`just-bash`. So adopting Think makes us depend on the date-implied flag. Our own code still imports no `node:*`,
which keeps the CLAUDE.md rule intact. The drones Worker already relies on the same implied flag for
isomorphic-git's `Buffer`.

**Combined spike Worker** (loop + Think + bundler + shell git): 22.6 MiB raw / **5.45 MiB gzip**, startup 114 ms.
That deploys on Workers Paid. Without worker-bundler, the drones Worker would grow by about 1.7 MiB gzip.

## 2. Think

- **Coding tools out of the box: yes.** Every turn gets `read` (line-numbered), `write`, `edit` (find/replace
  with fuzzy matching), `list`, `find` (glob), `grep`, `delete`, and `bash`. The `bash` tool is `just-bash`: a
  sandboxed bash over workspace files with network off, at most 1,000 files and 1 MB per file. It's not a real
  shell; there's no `node`/`npm`. The workspace is `@cloudflare/shell`'s `Workspace` on the DO's SQLite. The same
  tools are exported for any backend: `createWorkspaceTools(workspaceLike)`. The prototype runs them over a
  60-line `Map` (`spikes/harness/src/workspace.ts`) with no DO at all.
- **Chat-only? No.** There are three one-shot entry points:
  1. `saveMessages([...])` runs one turn (up to `maxSteps` tool rounds) and resolves `{status}`. The prototype
     uses this over DO RPC. Cloudflare's own `@cloudflare/ci` self-healing example does exactly the same thing:
     a Workflow `step.do("heal", { retries: 0, timeout: "5 hours" })` calls `getAgentByName(env.HEALER,
     instanceId).heal()`, and `heal()` calls `this.saveMessages(...)` on a `Think` subclass whose
     `getModel()` returns `'@cf/moonshotai/kimi-k2.7-code'`.
  2. `submitMessages(msgs, { idempotencyKey })` + `waitForSubmission(id, { timeoutMs })` give durable acceptance
     that is safe to retry. This is the right shape for a retried Workflow step.
  3. `ThinkWorkflow` + `step.prompt(name, { prompt, output: zodSchema })` is a typed result through a forced
     `think_final_answer` tool, delivered as a Workflow event. **It doesn't fit us as-is:** the Workflow must be
     started by the agent (`this.runWorkflow()`) to carry agent identity, but our Workflows are started by the
     Queen.
- **Workers AI catalog models + tool calling: yes.** `getModel()` can return a plain `@cf/...` string; Think
  resolves it through its bundled `workers-ai-provider` and the `AI` binding. `getGateway()` returned
  `{ id: "queenos" }` and the calls went through the gateway. `onStepFinish` exposes per-step `usage`,
  `toolCalls` and `finishReason`. `TurnConfig` (from `beforeTurn`) can override `model`, `maxSteps`,
  `activeTools` and `stopWhen` per turn. That last one is where Queen fallbacks and a `hasToolCall("finish")`
  stop condition plug in. Without that stop condition, Think made one extra no-tool step after `finish` in every
  run (visible below).
- **Which catalog models do tool calling reliably** (this spike, this task):
  - `kimi-k2.7-code`: 7/7 completed runs good. Think's own docs also list it as verified for streaming forced
    tool calls.
  - `glm-5.3-flash`: 3/3.
  - `deepseek-v4-flash-0731`: 3/3, with occasional parallel tool calls.
  - `qwen3.8-27b`: **0/2**. Both runs failed with `3046: Request timeout` from Workers AI after 138–166 s.
  - Not tested: `deepseek-v4-pro`, `glm-5.3` (slow reasoner), and the light tier.

  Think's docs warn that some models (e.g. `llama-3.3-70b-fp8-fast`) ignore forced `toolChoice` while
  streaming, which matters for `step.prompt` only.

## 3. Worker Loader / Dynamic Workers

- **Available on account <account-id> Yes.** `"worker_loaders": [{ "binding": "LOADER" }]` deployed without
  opt-in errors and worked. (The worker-bundler README still calls the binding "closed beta". Pricing and GA
  limits are UNVERIFIED.)
- **Verify the generated Worker before pushing: yes, and it's very cheap.** `src/verify.ts` passes every
  `src/**/*.js` file as an ES module named by its repo path, `mainModule` from `.queen/deploy.json`, plus
  `globalOutbound: null` (no network) and `limits: { cpuMs: 100 }` to `loader.load(...)`, then calls
  `getEntrypoint().fetch()`. Relative imports (`./features/index.js`) resolve with no rewriting.
  - Unmodified `demo` (11 files): `/` returned `application/json` 200 and `/health` 200, with
    **load + first fetch = 12 ms** and the second fetch at 0 ms.
  - After the agent's edit: 12–16 ms. Across all runs, the agent itself called `verify` 1–2 times.
  - The no-build template needs no bundling, so this is just module upload.
- codemode (`DynamicWorkerExecutor`) isn't needed for this: it's for running *model-written orchestration
  code*. Direct `loader.load` is simpler and is what codemode does internally (it forces `nodejs_compat` and
  compat date 2025-06-01 on its sandboxes, while ours uses the repo's own `deploy.json` date).

## 4. worker-bundler

It works, inside a Worker, against the real npm registry. The probe was a 3-line Hono app with
`{"dependencies":{"hono":"^4.0.0"}}`, passed to `createWorker`, which fetched `hono` from npm, bundled it with
esbuild-wasm, and produced one `bundle.js` of **56,029 bytes**. Loading it into a Dynamic Worker returned
`<h1>hi from hono</h1>` 200 and `{"ok":true}` 200.

| Run | `createWorker` | Load + 2 fetches | Whole HTTP request |
|---|---|---|---|
| 1 | 76 ms | 187 ms | 2.06 s |
| 2 | 70 ms | 49 ms | 2.16 s |

The whole-request time is mostly isolate start for a 14 MiB Worker. The 70–76 ms bundle times look warm; I
didn't isolate npm fetch time.

The cost is **3.8 MiB gzip** of bundle (TypeScript 6 + esbuild.wasm) and it's experimental. It isn't needed
while the template is no-build. If templates gain npm deps, it belongs in a dedicated "bundler" Worker (service
binding), not in drones. The Herald would need it too, so it can deploy what the drone verified.

## 5. Integration shape

| | (a) AI SDK loop, a `step.do` per turn | (b) Think DO per task | **(c) Hybrid (recommended)** |
|---|---|---|---|
| Durability | Each turn checkpointed by Workflows; replay skips finished turns | DO SQLite: workspace and transcript survive eviction; Think chat recovery continues a turn interrupted by deploys or eviction | Workflow durable at the step level (agent run, commit, push, report); DO durable inside the run |
| Step limits | State per turn measured at **0.8–28.9 KB**, far under 1 MiB, but it grows with the transcript; about 20 extra steps per build | One step; result is the change set (already capped at 512 KiB) | Same as (b) |
| Retries / idempotency | Natural per turn; the gateway cache even replays identical turns (run kimi-2 below) | Needs `submitMessages({ idempotencyKey })` so a retried step re-attaches instead of starting a second turn | DO named `${trainId}/${action}/a${attempt}`, idempotency key = Workflow instance + step; commit/push unchanged (fixed timestamp, `Queen-Drone` trailer) |
| Model fallbacks | Our code | `beforeTurn` → `{ model }`, or a fresh submission per model | Per model: one submission with `getModel()` = that model; on error or no-`finish`, the next fallback |
| Tool trace → ledger | Our code | `onStepFinish` + `getMessages()` tool parts | Same as (b) |
| Code we own | Loop, state folding, nudges, stop logic (~150 lines, `src/loop.ts`) | Subclass with about 4 overrides (`src/think-agent.ts`) | Subclass + one Workflow step |
| Cloudflare-native | `ai` + Workers AI + Think's tool factories | Think + Agents + shell Workspace | Most of all three |
| Observed latency | 42–125 s | 54–121 s | Same as (b) |

Why (c) and not pure (a): (a) works too, and the prototype proves it. But it re-implements, worse, what Think
already provides: a durable workspace, transcript recovery, tool merging, `activeTools`, skills, and later
sub-agents (e.g. a reviewer agent as an `agentTool`). It's also the pattern Cloudflare ships in `@cloudflare/ci`.
Why not pure (b): the Workflow already gives us durable git side effects with replay-stable SHAs, and the Queen's
dispatch, retry and audit contract is built on it. Only the "think" part moves.

### Concrete design for `apps/drones`

**New files**
- `src/agent/builder-agent.ts` holds `export class BuilderAgent extends Think<Env>`:
  - **Config:** `maxSteps = 20`, `workspaceBash = false` (keeps the surface small; turn on later).
  - **`getModel()`:** reads `this.state.model`.
  - **`getGateway()`:** returns `{ id: env.AI_GATEWAY_ID, metadata: { promptId, trainId, action, role: "builder" } }`.
  - **`getSystemPrompt()`:** returns `TOOL_SYSTEM_PROMPT` (from `spikes/harness/src/prompt.ts`; the legacy
    "never edit src/index.js" rule is dropped).
  - **`getTools()`:** returns `{ verify, finish }`; the workspace tools are auto-merged.
  - **`beforeTurn()`:** returns `{ activeTools: [...], stopWhen: hasToolCall("finish") }`.
  - **`onStepFinish`:** appends to a bounded trace.
  - **`build(input)`** (RPC method): seeds the workspace, calls `submitMessages(..., { idempotencyKey })` then
    `waitForSubmission`, and returns `{ files, deleted, trace, usage, finish, verify }`.
- `src/agent/tools.ts` holds:
  - `verify`, from `spikes/harness/src/verify.ts`;
  - `finish`, with input `{ summary, reasoningSteps (≤6), discardedPaths }`;
  - a path guard that rejects writes under `.git/`, `.queen/`, `package.json` and wrangler config (`assertRepoPath`
    + `RESERVED_PREFIXES`).
- `src/agent/seed.ts` reads the train branch tree with hive-kit `cloneRepo` (already in drones; no need for
  shell's git and its mkdir bug) into the Workspace.
- `wrangler.jsonc` additions:
  - `durable_objects.bindings` entry `{ "name": "BUILDER", "class_name": "BuilderAgent" }`;
  - `migrations: [{ "tag": "v1", "new_sqlite_classes": ["BuilderAgent"] }]`;
  - `worker_loaders: [{ "binding": "LOADER" }]`.
- Deps, pinned exact: `@cloudflare/think@0.20.0`, `agents@0.26.0`, `ai@7.0.127`, `workers-ai-provider@4.0.0`.

**Step structure in `orchestrate.ts`.** `runBuild` keeps its shape. `generate change set` becomes
`agent: build` (timeout 10 min, retries 2):
```
for model of modelsFor(task, config):          // Queen modelChoice + fallbacks, unchanged
  stub = getAgentByName(env.BUILDER, `${task.trainId}/${task.action}/${model}`)
  r = await stub.build({ task, baseRef, model, idempotencyKey: `${instanceId}:build:${model}` })
  if r.finish && r.verify.ok && templateFitProblems(r.changeSet).length === 0 → return r
  failedModels.push(model)
throw AllModelsFailedError (non-retryable)
```
Then the existing steps run unchanged: `clock: generated`, `clone, commit, note, push`, report, audit. The agent
returns full file contents in the existing `ChangeSet` shape (≤20 files, ≤64 KiB each), so `commitAndPush`,
`withMergedRegistry` and the gatekeepers' LLM reviewer don't change. Deletions need a `deletes: string[]` field
(today's ChangeSet can't express them; hive-kit `FileChange` already supports `{ delete: true }`).

**Budgets**

| Budget | Value |
|---|---|
| Turns / steps | `maxSteps` 20 (runs used 4–11) |
| Output per model call | 12k tokens |
| Wall time per model | 240 s, enforced by `waitForSubmission({ timeoutMs })` then `cancelSubmission` |
| Wall time per build | 8 min overall |
| Input tokens | Expect **12–44k per build vs ~1.4k single-shot** (the transcript is re-sent every turn); 1.2–3.1k output |
| `verify` calls | ≤5 per build, `cpuMs: 100` and no network per load |
| Change set | ≤20 files, ≤512 KiB total (unchanged caps) |

**Cognitive Ledger mapping (`buildGitNotesPayload`)**

| Ledger field | Source |
|---|---|
| `model` | The model that finished |
| `reasoningSteps` | `finish.reasoningSteps`, followed by condensed trace lines such as `t3 read /src/index.js`, `t5 edit /src/index.js (+52 −1)`, `t6 verify / → 200 text/html; /health → 200 json` (cap 20 total, 2,000 chars each, per `MAX_REASONING_STEPS`) |
| `discardedPaths` | `finish.discardedPaths` plus failed models |
| `executionTimeMs` | Unchanged |

Usage totals go to the Queen in `reportBuildResult`, and later into router stats.

**What carries over from today.** `modelsFor`, `AllModelsFailedError`, `toStepError`, `templateFitProblems`
(as a final gate after `finish`), the scripted mode (bypasses the agent entirely), and the commit/push
idempotency.

## 6. Run log (task: "Change our status page at / from JSON to a nice HTML page…; keep /health returning JSON")

Clone of `demo` @ `41f5d5ef`: 0.5–2.1 s. "Right file" means only `src/index.js` changed. "Verify" is the final
sandbox fetch: `/` → `text/html` 200 and `/health` → JSON 200. Tokens are input / output.

| # | Harness | Model | Result | Right file | Verify | Turns/steps | Total | Tokens |
|---|---|---|---|---|---|---|---|---|
| 1 | loop | kimi-k2.7-code | finish | yes | ok | 11 | 76.5 s | 32.5k / 1.7k |
| 2 | loop | kimi-k2.7-code | finish (gateway **cache hits**) | yes | ok | 11 | 17.2 s | (same) |
| 3 | loop, no cache | kimi-k2.7-code | finish | yes | ok | 5 | 57.0 s | 11.7k / 1.3k |
| 4 | loop | deepseek-v4-flash | finish | yes | ok | 6 | 83.9 s | 18.8k / 1.2k |
| 5 | loop, no cache | deepseek-v4-flash | finish | yes | ok | 10 | 124.7 s | 44.0k / 3.1k |
| 6 | loop | glm-5.3-flash | finish (2 verify calls) | yes | ok | 8 | 58.4 s | 26.7k / 1.8k |
| 7–8 | loop, no cache | qwen3.8-27b | **FAIL** `3046: Request timeout` | n/a | n/a | n/a | 166 s / 138 s | n/a |
| 9 | loop, **legacy rules** | kimi-k2.7-code | finish | yes | ok | 5 | 43.3 s | 11.5k / 1.3k |
| 10 | loop, **legacy rules** | kimi-k2.7-code | finish | yes | ok | 5 | 54.0 s | 12.3k / 1.7k |
| 11 | loop, **legacy rules** | deepseek-v4-flash | finish | yes | ok | 8 | 42.3 s | 34.6k / 2.3k |
| 12 | think | kimi-k2.7-code | **FAIL** "Durable Object reset because its code was updated" (started seconds after a deploy) | n/a | n/a | n/a | 200 s | n/a |
| 13 | think, no cache | kimi-k2.7-code | completed | yes | ok | 8 (7 + 1 after finish) | 121.0 s | 27.1k / 2.4k |
| 14 | think | glm-5.3-flash | completed | yes | ok | 8 | 62.8 s | 30.2k / 1.8k |
| 15 | think | kimi-k2.7-code | completed | yes | ok | 5 | 54.0 s | 12.4k / 1.3k |
| 16 | think\* | glm-5.3-flash | completed | yes | ok | 8 | 74.6 s | 29.9k / 2.1k |

\* The `legacyRules` flag isn't wired into the Think harness, so #16 is a plain Think run.

Typical trajectory: `list /` → `read /src/index.js` (+ registry and a feature module) → `edit` (add an `html()`
helper) → `edit` (swap the `/` branch) → `verify` → `finish`. Run 11's model said it outright: *"The request is
explicitly about the `/` route in `src/index.js`, so editing it is required."* One long model call (the edit
holding the whole HTML page) dominates every run (18–69 s). The diffs are in each result's `changed[].diff`.

## 7. Risks

1. **Experimental, 0.x packages.** Think 0.20, shell 0.4, worker-bundler 0.2 and agents 0.26 are all
   experimental; Think, codemode, worker-bundler and agents all published new versions on 2026-10-02. Pin exact versions and add a smoke test that runs `BuilderAgent` against a fake
   model.
2. **Shell bug.** `@cloudflare/shell` 0.4.3 `createGit` over `InMemoryFs` fails to clone
   (`ENOENT … mkdir '/repo/.git/hooks'`): its fs adapter doesn't map mkdir errors to `ENOENT`, so isomorphic-git's
   mkdirp can't create parents. Workaround: force recursive mkdir (`spikes/harness/src/repo.ts`). Production
   should keep hive-kit git. Worth reporting upstream.
3. **Deploys interrupt in-flight agents** (run 12). Think's chat recovery should resume inside the DO, but the
   RPC caller saw an error. Use `submitMessages` with an idempotency key + `waitForSubmission` so a retried step
   re-attaches, and avoid deploying drones mid-train during the demo.
4. **Token cost and latency.** Input tokens rise about 10–30× vs single-shot. Wall time is 42–125 s vs 11–42 s
   for most single-shot models. That's inside step budgets, but the Queen's `avgBuildMs` routing will see it.
   The reviewer gate stays as a second line of defense.
5. **Model reliability.** Qwen 3.8 timed out twice. Restrict the tool-loop roster to kimi-k2.7-code, glm-5.3-flash
   and deepseek-v4-flash (plus deepseek-v4-pro, untested) until the bake-off is redone with tools. GLM-5.3 (long
   reasoning) is risky under per-turn budgets.
6. **Gateway caching.** Identical turns are served from cache (run 2: 0.13–0.67 s per turn). That helps
   deterministic replays but hides real latency in evaluations and makes "retry the same model" repeat itself.
   Set `skipCache` for REWORK attempts.
7. **Bundle size and `nodejs_compat` coupling.** Think adds about 1.6 MiB gzip and needs the implied
   nodejs_compat (it can't build without it). This is fine on Workers Paid; it's an explicit dependency on the
   2026-08-04+ compat-date default.
8. **Worker Loader status.** It worked here, but it's described as closed beta in package docs. GA limits and
   pricing are UNVERIFIED. Verify must degrade to "skipped", not "failed", if the binding is missing.
9. **Sandbox fidelity.** The Dynamic Worker verify runs the code with no bindings and no network. It proves the
   routes respond, not that production bindings work. The Herald + Sentinel remain the deploy truth.

## 8. Time to productionize (target 2026-10-12)

About **3 focused days**, which leaves 2 days of slack before 10-14.

| Day | Work |
|---|---|
| 1 (10-06) | `BuilderAgent` + tools + seed, DO/migration/loader bindings, path guard; unit tests with a fake `LanguageModel` (the mock model from `ai/test`) in vitest-pool-workers |
| 2 (10-07) | Wire into `orchestrate.ts` (`agent: build` step, idempotency, model fallback loop, budgets), `deletes` in ChangeSet/commit, ledger trace mapping, usage reporting; keep `DRONE_HARNESS=single-shot|agent` as a kill switch |
| 3 (10-08) | Live runs on a scratch hive (5+ prompts incl. "change existing route", "add feature", REWORK), redo the bake-off for tool calling, update `MODEL_CATALOG` roles, dashboard shows the tool trace |
| Later | worker-bundler (when templates take npm deps; separate Worker, Herald support); codemode/`bash` tool; Think sub-agents (reviewer as an `agentTool`) |

## 9. Reproduce

```bash
cd spikes/harness
pnpm install --ignore-workspace          # standalone; not in pnpm-workspace.yaml
export PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH   # wrangler 4.147 needs Node >= 22
pnpm typecheck && pnpm exec wrangler types --include-runtime=false
export SPIKE_KEY=$(openssl rand -hex 16) && pnpm run deploy    # creates queenos-day1-harness
U=https://queenos-day1-harness.<subdomain>.workers.dev
curl -H "x-spike-key: $SPIKE_KEY" $U/tree                       # demo tree (read-only) + sandbox verify
curl -H "x-spike-key: $SPIKE_KEY" -H 'content-type: application/json' \
  -d '{"harness":"loop","model":"@cf/moonshotai/kimi-k2.7-code","skipCache":true}' $U/run > r.json
#   harness: "loop" | "think"; optional "legacyRules": true (loop only), "maxTurns", "task"
python3 summarize.py r.json
curl -H "x-spike-key: $SPIKE_KEY" $U/bundle                     # worker-bundler probe
pnpm run delete                                                  # ALWAYS delete afterwards
```

Files:
- `src/loop.ts`: option (a)
- `src/think-agent.ts`: option (b)
- `src/tools.ts`: tools
- `src/workspace.ts`: the Map `WorkspaceLike`
- `src/verify.ts`: Worker Loader verify
- `src/repo.ts`: read-only Artifacts clone through shell git
- `src/bundle-probe.ts`: worker-bundler probe
- `size/`: per-package bundle-size entries

**Cleanup done:** `wrangler delete` succeeded. The URL returns 404 (error 1042), the script is absent from the
account's script list, and no `queenos-day1-harness` DO namespace remains. No other resources were created; the
`demo` repo was only read (read token, depth-1 clone, never pushed).
