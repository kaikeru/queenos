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
