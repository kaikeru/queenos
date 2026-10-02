# QueenOS Architecture

QueenOS is an autonomous, agentic Git platform built entirely on Cloudflare primitives: Artifacts, Workers, Durable Objects, Workflows, Vectorize, and AI Gateway.

**Stack:** pnpm, Turborepo, TypeScript, Hono, Vite/Vitest with @cloudflare/vitest-pool-workers.

## Workspace layout

- **apps/dashboard** — React + Vite SPA
- **apps/queen** — Hono Worker + QueenNode Durable Object (SQLite-backed, WebSocket hibernation). `pnpm --filter @queenos/queen dev:sim` runs it in sim mode: fake Artifacts and auto-advancing fake drones, no Cloudflare credentials needed
- **apps/gatekeepers** — Worker handling Artifacts push events
- **apps/drones** — Cloudflare Workflows
- **packages/hive-kit** — Worker-safe git (isomorphic-git + in-memory fs), AI Gateway client and Cognitive Ledger helpers shared by drones and gatekeepers (@queenos/hive-kit)
- **packages/queen-types** — shared Zod schemas and TS interfaces (@queenos/queen-types)
- **packages/tsconfig, packages/eslint-config** — shared configs

## Core architectural rules

- This is QueenOS, an OS for agents, not a GitHub clone.
- All packages must import shared types from `@queenos/queen-types`.
- Never use Node.js built-ins. We deploy to Cloudflare V8 isolates.
- The Queen DO manages state via SQLite and broadcasts via WebSockets.
- Drones are ephemeral. They fork Artifacts repos programmatically.

## Commands

- `pnpm install` — install dependencies
- `pnpm dev` — start dev server (Turborepo)
- `pnpm build` — build all packages
- `pnpm test` — run tests
- `pnpm typecheck` — typecheck all packages
- `pnpm --filter @queenos/queen test` — edge tests only
