# Drone harness build: brief

**Owner:** the `harness` agent (Herdr pane). **Coordinator:** the main QueenOS session.
**Goal (user):** "This is useless unless we have agents that can write code, so the risks are worth it."
Replace the single-shot drone generator with a real coding agent that reads code, edits it, verifies the result, and only then commits.
**Due:** end-to-end on the live `demo` hive by **Oct 8**. The hackathon deadline is Oct 14.

## Read first
- `CLAUDE.md` (the rules: the Queen orchestrates only; shared types come from `@queenos/queen-types`; no Node built-ins *in our code*)
- `docs/harness-spike.md` (**the decision memo; follow its integration design**) and `spikes/harness/` (working prototype plus raw results)
- `apps/drones/**` (current Workflow: `workflow.ts`, `orchestrate.ts`, `build.ts`, `generate.ts`, `repo-context.ts`, `change-set.ts`, `prompt.ts`, `land.ts`)
- `packages/hive-kit/src/{git.ts,ai-gateway.ts,ledger.ts}`, `packages/queen-types/src/{drone.ts,models.ts,ledger.ts,train.ts}`
- `apps/queen/src/models/router.ts` (how `modelChoice` + fallbacks are chosen), `docs/model-bakeoff.md`
- `templates/worker-starter/**`, `apps/gatekeepers/src/review.ts` (the new LLM reviewer judges intent after you push)

## Decision (already made)
**Hybrid, per the spike.** The drone Workflow stays: dispatch, the Queen's `modelChoice`, fixed-timestamp commits, the `Queen-Drone` trailer, git notes, `reportBuildResult`, audit and watchdog are unchanged. Only the **"generate change set"** step is replaced by a **`@cloudflare/think` coding agent** (one Durable Object per build attempt) with:
- Think's built-in workspace tools: read, edit, list, find, grep.
- `verify`: our tool. It loads the edited Worker (all `src/**/*.js` + `.queen/deploy.json` main) into a **Dynamic Worker** via the Worker Loader binding, with `globalOutbound: null`. It fetches `/` and `/health` (and any route the task mentions) and returns status, content-type and a body snippet. It also runs the existing template-fit checks. The agent must call `verify` and see it pass before `finish`.
- `finish(summary, reasoningSteps[], discardedPaths[])`: our tool; ends the loop.
- Model: the Queen's `modelChoice.model`, through `workers-ai-provider` and AI Gateway `queenos`. On loop failure (no finish, verify never passes, provider errors), fall back to `modelChoice.fallbacks` in order. **Exclude `@cf/qwen/qwen3.8-27b`** from tool-loop use (3046 timeouts in the spike). Tell the coordinator, who owns the catalog and router, how you handle it.
- Defer `worker-bundler` and `codemode`.

## Requirements
1. **Durability and idempotency:**
   - Submit to the Think DO with an idempotency key = the drone instance id + attempt, so a retried Workflow step re-attaches instead of restarting. The spike saw "Durable Object reset because its code was updated" right after a deploy.
   - The Workflow step returns only the final file overlay (changed/added/deleted files), within caps, plus the trace summary, ≤ 1 MiB.
   - Budgets: max turns (~16), a wall-time cap that fits the step timeout and the Queen's watchdog (`COMMAND_TIMEOUT_MS` 10 min), and a token budget.
2. **Workspace:** seed it from the train fork at `baseRef` (Artifacts binding `readTree`/`readFile`, or the hive-kit clone; the spike notes `@cloudflare/shell` 0.4.3 has an in-memory `mkdir` bug). Commit and push through hive-kit as today; the registry merge stays.
3. **Ledger:** the git note's `reasoningSteps` = a compact tool trace (tool, path, short outcome) plus the agent's own reasoning summary. `discardedPaths` comes from the agent. `model` = the model that finished.
4. **BuildResult:** `model`, `failedModels`, `buildMs` as today (the Queen's router learns from them).
5. **Prompt:** a concrete system prompt for the no-build Worker template. Edit existing code when the request changes existing behavior; keep `/health`; plain ES modules, relative imports, no npm. On REWORK, include the Scribe/reviewer feedback prominently.
6. **Template routing:** let a feature module declare a top-level route (e.g. `export const path = "/status"`) in `templates/worker-starter`, keeping backward compatibility. Update the provisioner's generated templates (`apps/provisioner/scripts/gen-templates.mjs`) and its tests.
7. **Config:**
   - Pin exact versions of `@cloudflare/think`, `agents`, `ai`, `workers-ai-provider` (+ any `@cloudflare/*` used).
   - Add `worker_loaders` and the Think DO binding + migration to `apps/drones/wrangler.jsonc`.
   - Think needs `nodejs_compat`, which compat date 2026-10-02 already implies. Document it in CLAUDE.md as a dependency exception: "our code never imports Node built-ins".
   - `scripted` mode stays the test default and must not touch Think.
8. **Tests:** unit-test the tools (`verify` against a fake loader; template-fit), fallback ordering, idempotent re-attach, the overlay → commit path, ledger mapping, and budget exhaustion → failure report. Keep all repo tests green: `pnpm turbo run build typecheck lint test --force` (40 tasks today).
9. **Live proof:**
   - After deploy (coordinate: ask the coordinator to deploy, or run `./scripts/deploy.sh` if it's safe), the user submits on `demo`: "Change our status page at / from JSON to a nice HTML page; keep /health".
   - Expected: the agent edits `src/index.js`; `verify` passes; the reviewer APPROVES; it lands; a staging release follows.

## Process
1. **Design first:** write `docs/harness-design.md` (step structure, tool specs, DO lifecycle and idempotency, budgets, failure modes, ledger mapping, config, test plan). Keep it short. Then report to the coordinator and continue to implementation without waiting.
2. Implement in small, verifiable increments, using subagents if you want. Don't touch `apps/queen` or `packages/queen-types` without telling the coordinator; they're shared contracts. `apps/drones`, `packages/hive-kit` (AI/git helpers), `templates/` and `apps/provisioner` (templates only) are yours.
3. **Before deploying, never push to the `demo` hive repo by hand.** Only real drone runs via the Queen may.
4. Don't commit secrets. `CLOUDFLARE_API_TOKEN` is in the environment; never print it.
5. Commit in logical steps with clear messages, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push (there's no remote).
