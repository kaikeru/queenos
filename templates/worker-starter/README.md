# worker-starter

The no-build template QueenOS deploys in P1 (see `docs/deploy-discovery.md` §1, §2). There is no bundler and no `node_modules`: the Herald uploads the files straight from the Artifacts tree.

## Convention

- `.queen/deploy.json` is `{ "main": "src/index.js", "compatibility_date": "2026-10-02" }`.
  - `main` is the entry module and must be one of the uploaded files.
  - `compatibility_date` is passed through to the Worker.
- Every `src/**/*.js` file is uploaded as an ES module named by its repo path (for example `src/features/index.js`). Imports must be relative and include the `.js` extension. No npm packages.
- Caps (enforced by the Herald): 100 modules, 256 KiB per module, 1 MiB in total.

## Features

`src/index.js` is a tiny router: `/`, `/health` and `/features/<slug>`.

Each feature is a module in `src/features/` that exports:

- `slug` (string, `[a-z0-9-]+`) and `handle(request)` returning a `Response`.
- optionally `guard(request)`, run on every request before routing. If it throws, the router answers HTTP 500.

`src/features/index.js` is the registry: one `import * as fN from "./<module>.js"` per feature and an exported `features` array. The builder drone regenerates it (merging with the existing imports) each time it adds a feature.
