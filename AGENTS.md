<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# QueenOS Architecture

QueenOS is an autonomous, agentic Git platform built entirely on Cloudflare primitives: Artifacts, Workers, Durable Objects, Workflows, Vectorize, and AI Gateway.

**Stack:** pnpm, Turborepo, TypeScript, Hono, Vite/Vitest with @cloudflare/vitest-pool-workers.

## Workspace layout

- **apps/dashboard** — React + Vite SPA
- **apps/queen** — Hono Worker + QueenNode Durable Object (SQLite-backed, WebSocket hibernation). `pnpm --filter @queenos/queen dev:sim` runs it in sim mode: fake executors (provisioner, herald, drones, gatekeepers) that auto-advance, no Cloudflare credentials needed
- **apps/edge** — `queenos-edge` Worker: front door (Access JWT, dashboard assets, `/api/*` and `/hives/*` routing, `/git/*` git-token auth forwarding to the `GIT` service binding)
- **apps/git** — `queenos-git` Worker: the agent-native git proxy (smart-HTTP front door over Artifacts; pre-receive rules, per-push fork, `remote:` verdict lines, notes)
- **apps/gatekeepers** — Worker handling Artifacts push events
- **apps/drones** — Cloudflare Workflows; live builds run a `@cloudflare/think` coding agent (BuilderAgent DO) with Dynamic Worker verify (docs/harness-design.md)
- **packages/hive-kit** — Worker-safe git (isomorphic-git + in-memory fs), AI Gateway client and Cognitive Ledger helpers shared by drones and gatekeepers (@queenos/hive-kit)
- **packages/queen-types** — shared Zod schemas and TS interfaces (@queenos/queen-types)
- **packages/tsconfig, packages/eslint-config** — shared configs

## Core architectural rules

- This is QueenOS, an OS for agents, not a GitHub clone.
- All packages must import shared types from `@queenos/queen-types`.
- Never use Node.js built-ins. We deploy to Cloudflare V8 isolates.
  - Dependency exception: `@cloudflare/think` / `agents` (the drones' BuilderAgent) import `node:*` modules and rely on the `nodejs_compat` that compat date 2026-10-02 implies. Our own code still never imports Node built-ins.
- The Queen DO manages state via SQLite and broadcasts via WebSockets.
- Drones are ephemeral. They fork Artifacts repos programmatically.

## Commands

- `pnpm install` — install dependencies
- `pnpm dev` — start dev server (Turborepo)
- `pnpm build` — build all packages
- `pnpm test` — run tests
- `pnpm typecheck` — typecheck all packages
- `pnpm --filter @queenos/queen test` — edge tests only
- Full gate: `pnpm turbo run build typecheck lint test --force --continue`

## Agent conventions & protocols

- **Agent trailer:** Commits written by agents must declare `Queen-Origin: agent:<name>` (e.g. `Queen-Origin: agent:antigravity` or `Queen-Origin: agent:claude-code`). See `docs/agent-protocol.md`.
- **Token scan before commit:** Check clean with `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` (exit code 1 = clean).
- **Verification:** Run package-specific tests + `tsc -p test`, and verify with the full gate before pushing.

<!-- repo-graph:start -->
## repo-graph — structural map (use it before grepping)

This project ships a repo-graph map of its own code — entities, relationships,
and cross-stack flows — exposed as six MCP tools. It answers where / what-uses /
how-does-X-reach-Y / what-breaks-if-I-change-this without reading many files.

FIRST, make sure the tools are loaded. If you do NOT see `repo-graph` tools
(`mcp__repo-graph__*`) in your available tools, they may be deferred — search
your tool list and load them before you start, instead of falling back to grep.

Then, for any structural question, use the graph before grepping across files:
- `orient` — first call on the repo: counts, entry points, and a `blind spots`
  note telling you which languages/edges the graph under-links (grep those).
- `find <text>` — turn a symbol, keyword, stacktrace, failing test, or diff into
  the ranked nodes that matter. Every row carries `path:line`.
- `impact <node>` — blast radius: what a change affects / depends on, ranked,
  located, with likely-dead code flagged `⊘`. This is where the graph wins.
- `trace <feature>` — a feature end to end across the stack (or `trace A B` for
  the path between two nodes), with each hop's mechanism labelled.
- `read <node>` — a node's exact source (comma-separate several to read a ranked
  set in one call).
- `refresh` — rebuild after a big refactor (routine edits are auto-picked-up).

Trust the graph's results — don't re-verify every node with grep, except where
`orient`'s blind-spots note says extraction is partial. Only a trivial
single-file lookup is faster with grep; anything structural starts here.

If this project has no `.glia/graph/` directory and the tools aren't connected,
ignore this section.
<!-- repo-graph:end -->

<!-- ast-grep:start -->
You are operating in an environment where ast-grep is installed. For any code search that requires understanding of syntax or code structure, you should default to using ast-grep --lang [language] -p '<pattern>'. Adjust the --lang flag as needed for the specific programming language. Avoid using text-only search tools unless a plain-text search is explicitly requested.
<!-- ast-grep:end -->
