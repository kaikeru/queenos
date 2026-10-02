# QueenOS Deploy Discovery: Preview → Staging → Canary → Prod (2026-10-02)

Companion to [discovery.md](discovery.md), with the same rules: every claim cites a source, and anything without one is **UNVERIFIED**. Deadline is 2026-10-14. Deploy target: the **user's own Cloudflare account** (account ID plus a scoped token entered in the onboarding wizard).

Citation shorthand (WT, WS and WC are as in discovery.md):
- **WT** = `@cloudflare/workers-types@5.20261002.1/index.d.ts`
- **WS** = wrangler 4.147 `config-schema.json`
- **WC** = wrangler 4.147 `wrangler-dist/cli.js`. It bundles the official `cloudflare@5.2.0` SDK, so its REST paths are first-party evidence of API shape.
- **CF:** = `https://developers.cloudflare.com/` + path. Cited line numbers refer to the page's `index.md` version.
- **SB** = `@cloudflare/sandbox@1.0.0` package README (`npm pack`).
- **npm** = `pnpm view`, run 2026-10-02.

Architecture constraint (user): **the Queen orchestrates only**. It decides, records in SQLite and broadcasts. All I/O moves to executors that report back over DO RPC: **Provisioner** (Workflow: forks and deletes), **Herald** (Workflow: deploys), **Sentinel** (Workflow: health verdicts), **Vault** (DO: secrets), **Genesis** (DO: onboarding chat).

## 1. Deploying user Workers from a Worker/Workflow (no wrangler CLI)

**Version upload (REST).** wrangler itself calls `POST /accounts/{acct}/workers/scripts/{script}/versions?bindings_inherit=strict` (WC:175927-175935).
- **Body:** multipart, one `metadata` JSON part plus one part per module. The part name is the module name and the MIME type comes from the module type (WC:164249-164262).
- **`metadata` fields** (WC:164205-164247):
  - `main_module`, `compatibility_date`, `compatibility_flags`, `migrations`, `limits`, `placement`, `observability`
  - `bindings[]`: `{name, type:"plain_text"|"json"|"secret_text"|"inherit"|"secrets_store_secret"|…}` (WC:163634-163643, 163855-163861)
  - `keep_bindings`: e.g. `["secret_text","secret_key"]` to inherit existing secrets (WC:164192-164203)
  - `annotations`: `{"workers/message","workers/tag","workers/alias"}` (WC:176386-176390)
  - `assets`: `{jwt, config}`
- **Result** carries the version `id` (WC:175940).
- **Deploy it:** `POST …/scripts/{script}/deployments {strategy:"percentage", versions:[{version_id, percentage}], annotations}` (WC:163227-163245).
- **Non-versioned settings:** `tail_consumers`, `logpush` and `observability` go through `PATCH …/scripts/{script}/script-settings` (WC:163246-163257, 175958-175964).
- **Creating the parent script:** `POST /accounts/{acct}/workers/workers {name, subdomain:{enabled, previews_enabled}}` (WC:176775-176786). UNVERIFIED: whether a `versions` POST alone creates a missing script.

**Static assets**, from wrangler's `syncAssets` (WC:162846-162990):
1. Build the manifest `{"/path": {hash, size}}`, where `hash = blake3(base64(contents) + ext).hex.slice(0,32)` (WC:162692-162698, 163117-163120).
   - Limits: 25 MiB per file (WC:160919); 100,000 files per version on Paid (CF:workers/platform/limits l.32-33).
2. Open a session: `POST …/scripts/{script}/assets-upload-session {manifest}` → `{jwt, buckets: hash[][]}`.
3. Upload each bucket: `POST /accounts/{acct}/workers/assets/upload?base64=true` with `Authorization: Bearer <session jwt>`. The multipart field name is the hash and the value is base64. The final response returns the completion `jwt`. If `buckets` is empty, reuse the session jwt.
4. Put `assets:{jwt, config:{html_handling, not_found_handling, run_worker_first}}` in the version metadata.

The Herald needs blake3: `blake3-wasm` (already in node_modules via wrangler) or a pure-JS blake3 (UNVERIFIED on workerd).

**Bundling inside a Worker/Workflow.**
- Workers instantiate only **pre-compiled** Wasm (CF:workers/runtime-apis/webassembly l.25). `esbuild-wasm@0.28.2` (npm, 14.5 MB unpacked) would need a module import passed as `wasmModule`. UNVERIFIED on workerd.
- The bigger problem: a Worker has no `pnpm install` and no filesystem, so real projects with npm deps can't be bundled there.
- `@cloudflare/worker-bundler@0.2.5` exists ("Build and bundle Workers at runtime for Cloudflare Worker Loader binding", npm). Whether it resolves npm deps is UNVERIFIED.
- Worker size limit is 64 MiB (CF:workers/platform/limits l.28).

**Decision/Recommendation:**
- Build in a **Sandbox container** (§5): `pnpm install && pnpm test && wrangler deploy --dry-run --outdir dist`. This yields modules exactly as wrangler would produce them. Put `dist/` and the asset manifest in **R2, keyed by commit SHA**.
- The **Herald uploads over REST** with the token from the Vault. The deploy token **never enters the container**, which runs agent-written code.
- For the day-1 slice, use a "no-build" template (`src/index.js`, no deps) that the Herald uploads straight from the Artifacts tree via `repo.readFile` (discovery §1).

**Open risks:**
- The multipart layout differs between previews (`files` field, WC:176841-176852) and versions (one part per module). UNVERIFIED edge cases.
- That `--dry-run --outdir` output maps 1:1 onto upload modules is UNVERIFIED.
- An asset-hash mismatch with wrangler means a full re-upload on every deploy. This costs time, not correctness.

## 2. Preview per train

| Option | Evidence | Verdict |
|---|---|---|
| **Worker Previews** (`wrangler preview`, new) | **API:** `POST/GET/PATCH/DELETE /accounts/{acct}/workers/workers/{worker}/previews[/{name}]` and `POST …/previews/{id}/deployments` (multipart `metadata` + `files`) (WC:176787-176881). **Deployment body:** `main_module, modules[{name,content_type}], compatibility_date, env{NAME:{type,…}}` (incl. `secret_text`), `assets{jwt,config}`, `annotations{"workers/commit_sha",…}`, `migrations, limits` (WC:177730-177815). **Response:** `preview.urls[]` and `deployment.urls[]` (WC:177904-177906). **URLs:** `<preview>-<worker>.<sub>.workers.dev` (latest) and `<deployment-id>-<worker>…` (pinned) (CF:workers/previews). **Isolation:** each Preview gets its **own DO namespace and containers**. KV/D1/R2 are shared if same id; Workflows shared; service bindings hit prod; no queue consumers or crons (CF:workers/previews/resources). **Limits (Paid):** 500 Previews per Worker, 100 deployments per Preview, oldest auto-deleted (CF:workers/previews). | **Choose.** One Preview per train, `t-<trainId12>`, on the hive's prod Worker. |
| Version Preview URLs / aliases | `annotations["workers/alias"]` (WC:176389). URL `https://<alias><preview_url_suffix>` (WC:176571). Alias: lowercase, ≤ 63 chars with the worker name, newest 1,000 kept. **Not supported** for Workers with DOs, Containers, Sandbox or WfP user Workers. **No Workers Logs, tail or Logpush** (CF:workers/configuration/previews). | Reject. No DO apps, no logs. |
| Workers for Platforms dispatch namespace | $25/mo plan: 20 M requests, 60 M CPU-ms and 1,000 scripts included, then +$0.02 per script (CF:cloudflare-for-platforms/…/platform/pricing). **"Gradual Deployments is not supported yet for user Workers"** (CF:…/platform/limits). Binding is `DispatchNamespace.get(name)` (WT:18121). | Reject. Users would have to buy WfP, and canary becomes impossible. |
| Separate script per train | 500 Workers per Paid account (CF:workers/platform/limits l.30). Cleanup is all on us. | Fallback only. |

**Cleanup:** the Queen emits `deletePreview` when a train is MERGED or EJECTED, mirroring `deleteFork` (planner.ts:441-449). The Herald calls `DELETE …/previews/{name}`. Auto-delete of the oldest Previews is the backstop.

**Decision/Recommendation:** use **Worker Previews in the user's account**.
- Herald `preview` step:
  1. Ensure the parent Worker exists (create on 404; WC:177992-178012).
  2. `createPreview` if needed.
  3. Upload assets.
  4. `createPreviewDeployment`.
  5. Report `urls[0]` to the Queen.
- Gatekeepers then run the charter's smoke/e2e tests against that URL, replacing the scripted runner (test-runner.ts:50-58).

**Open risks:**
- Previews are new: no pricing page and no REST doc page found (UNVERIFIED beyond the wrangler client). Preview-name rules are also UNVERIFIED.
- Apps that use service bindings or Workflows hit prod resources from previews. Genesis must flag this.
- If previews sit behind Access (CF:workers/configuration/routing/workers-dev l.32-34), gatekeepers need an Access service token (UNVERIFIED flow).

## 3. Staging and canary

**Gradual deployments:**
- A deployment holds up to 2 versions with percentages, chosen from the last 100 uploaded versions (CF:workers/versions-and-deployments/gradual-deployments).
- **Per-request routing:** "each request is independently routed" (l.142).
- **Sticky routing (opt-in):** `Cloudflare-Workers-Version-Key: <key>` is hashed against the percentages (CF:…/gradual-deployments/version-affinity). On `*.workers.dev` it must be set by the client or an upstream Worker.
- **Forcing a version:** `Cloudflare-Workers-Version-Overrides: <script>="<version-id>"` (a Dictionary Structured Header) (CF:workers/versions-and-deployments/version-overrides).
  - Applies only if that version is **in the current deployment**, with up to a couple of seconds of lag.
  - Works for external requests and `fetch` service bindings, not for RPC.
- **DOs:** "only one version of each Durable Object can run at a time" (gradual-deployments l.154).

**Rollback:**
- `wrangler rollback` is just `POST …/deployments` with `{old_version: 100}`, retried with `?force=true` when secrets changed (WC:354880-354905, 163227-163230).
- Limited to the last 100 versions. Blocked if a DO class lifecycle changed or a bound R2/KV/queue was deleted. Data is not rolled back (CF:workers/versions-and-deployments/rollbacks).
- WfP user Workers have no gradual deployments (§2).

**Staging layout:** a **separate script** `<app>-staging`. That is all a wrangler env is under the API, since versions and deployments are per script (WC:163229).
- The same R2 bundle is uploaded as a new version to each script.
- **Staging:** deploys at 100%.
- **Prod canary:** `POST deployments {versions:[{new, p},{stable, 100-p}]}`, with p = 1 → 10 → 50 → 100.
- **Smoke tests:** pin the new version with the Overrides header.
- **Per-env secrets:** `secret_text` on each upload, or `keep_bindings` (§1).

**Sites panel URLs:**
- **workers.dev:** `GET /accounts/{acct}/workers/subdomain` → `{subdomain}` → `https://<script>.<subdomain>.workers.dev` (WC:159951-159959). Enable per script with `POST …/scripts/{script}/subdomain {enabled:true}` (WC:113102).
- **Custom domains:** `PUT /accounts/{acct}/workers/domains {hostname, service, zone_id, environment}` (WC:112000-112021). Needs zone permissions (exact set UNVERIFIED).
- **Previews:** URLs come from the Preview responses (§2).
- **Canary:** shares the prod hostname; the panel shows the split.

**Decision/Recommendation:**
- staging = `<app>-staging` at 100%;
- canary = gradual deployment on `<app>`;
- rollback = stable version at 100% (`force=true` on a secrets mismatch).
- The Herald records both version ids at every step.

**Open risks:**
- DO apps can't canary their DO code. Genesis sets `canary: "all-at-once"` when the charter has DO classes.
- Override lag: Sentinel waits about 5 s after each deployment POST.
- Per-request split can flip a user between versions mid-session. Use Version-Key if that matters.

## 4. Health signals and SLOs

| Source | Per-version? | Latency | Notes |
|---|---|---|---|
| **Tail Worker** | Yes. `TraceItem.scriptVersion{id,tag}` (WT:3272), plus `outcome` (:3278), `cpuTime`/`wallTime` (:3281-3282), `exceptions`, `response.status` (WT:3319-3321) | **Seconds.** Runs after each producer invocation (CF:workers/observability/logs/tail-workers) | Paid plans, billed by CPU. Attach via `tail_consumers` (WS:1337), a script-setting (WC:175960). Assume it must be in the **user's** account (cross-account UNVERIFIED). |
| Workers Observability query API | Version key UNVERIFIED (expect `$workers.scriptVersion.id`; list keys via `…/telemetry/keys`) | Near real time (UNVERIFIED) | `POST /accounts/{acct}/workers/observability/telemetry/query {queryId, timeframe{from,to}, view:"calculations", parameters{filters,calculations,groupBys}}` (WC:112577-112600; CF API ref). Retention 7 d (CF:workers/observability/query-builder l.135). |
| GraphQL `workersInvocationsAdaptive` | `scriptVersion` dimension **UNVERIFIED**. The tutorial lists `scriptName, status, datetime` and metrics `requests, errors, subrequests, cpuTimeP50/P99` | "slight delay in aggregation" for the last few minutes (CF:workers/observability/metrics-and-analytics l.40) | Quota 300 queries per 5 min (CF:analytics/graphql-api/limits l.36). Needs Account Analytics Read. |
| Logpush `ScriptVersion` | Yes (gradual-deployments l.160-183) | Minutes, batch | Too heavy for 12 days. Skip. |

**Design:**
- At onboarding, the Herald installs a tiny **`queenos-sentinel-tail`** Worker in the user's account. Every 10 s it aggregates, per `(script, versionId)`:
  - requests, 5xx, `outcome != "ok"` and exception fingerprints;
  - p50/p99 `wallTime` and `cpuTime`.
- It POSTs those aggregates, HMAC-signed with a per-hive key injected as `secret_text`, to `/sentinel/ingest`. A **SentinelLedger DO per release** stores them.
- The **Sentinel Workflow** (one instance per window):
  1. sleeps for the window;
  2. reads the ledger;
  3. probes the charter `smoke[]` paths pinned to the new version, plus N unpinned requests that exercise the split;
  4. reports `{verdict:"promote"|"hold"|"rollback", reason, summary≤500}` to the Queen.
- The Queen never sees raw metrics.

**SLO checks** (defaults, overridable in the charter):
1. **Smoke:** every pinned smoke request returns its expected status. Any failure → rollback.
2. **Sample floor:** ≥ 300 new-version requests and ≥ 5 min per step. By the rule of three, 0 errors in n requests bounds the error rate at about 3/n (95%), so n = 300 → ≤ 1%. On low-traffic apps, Sentinel generates the load.
3. **Error rate:** `err_new ≤ max(1.5 × err_stable, err_stable + 0.5 pp)`, counting 5xx and `outcome ∈ {exception, exceededCpu, exceededMemory}`.
4. **New exceptions:** a fingerprint unseen in stable that occurs ≥ 3 times → rollback.
5. **Latency:** `p99 wall_new ≤ 1.3 × p99 wall_stable + 50 ms` and `p99 cpu_new ≤ 1.5 × stable`.
6. **Promotion:** staging applies checks 1-5 against the previous staging version. Promotion needs 2 consecutive passing windows. Three windows of "hold" → rollback.

**Decision/Recommendation:** Tail Worker plus synthetic probes are primary. The Observability query API is a once-per-window cross-check. GraphQL only after it is verified.

**Open risks:**
- Same-account requirement for tail consumers, tail on Previews, and `scriptVersion` population under a split are all UNVERIFIED.
- The Tail Worker's CPU lands on the user's bill.

## 5. Real builds and tests: Sandbox / Containers

**SDK 1.0 changed shape.** "A sandbox is a Durable Object and the Container it starts". `@cloudflare/sandbox` now provides only:
- `Files`: stream files in and out, with Linux errnos.
- `S3Mount`: R2/S3 mount; the Worker signs requests, so credentials never enter the container.
- `DirectoryBackup`: a directory to and from R2.

Commands run through `this.ctx.container` (SB). The SDK needs `nodejs_compat`, which our compat date already implies (discovery §2).

**Container API** (WT:3960-4045):
- `start({image, enableInternet, env, instance:"lite"|"standard-1..4"|{…}, directorySnapshots})`
- `exec(cmd[], {cwd, env, stderr:"combined"})` → `ExecProcess.output()` → `{stdout, stderr, exitCode}`
- `snapshotContainer()`, `setInactivityTimeout()`
- `interceptOutboundHttp(s)(addr, binding)`, `interceptAllOutboundHttp(binding)`
- `getTcpPort(port)`

**Limits and pricing:**
- Instance sizes: lite = 1/16 vCPU, 256 MiB, 2 GB. standard-2 = 1 vCPU, 6 GiB, 12 GB. standard-4 = 4 vCPU, 12 GiB, 20 GB. Account caps: 1,500 vCPU and 50 GB of images (CF:containers/platform-details/limits).
- Cold start is "often … 1-3 second range" (CF:containers/faq l.85).
- Pricing: requires Workers Paid and bills per 10 ms active. Included per month: 25 GiB-h, 375 vCPU-min and 200 GB-h. Then $0.000020 per vCPU-s and $0.0000025 per GiB-s (CF:containers/pricing). A 3-minute `pnpm install && pnpm test` on standard-2 is about 180 vCPU-s, roughly $0.004.
- DO "scheduling policy … is in public beta" (CF:sandbox).

**Driving it from a Workflow:**
- A container-enabled `Foundry` DO lives in a new `apps/foundry` Worker. Its RPC: `build({repo, sha, cmds}) → {exitCode, logTail≤64KiB, bundleKey?}`.
- Inside, it:
  1. clones `repo@sha`. The Artifacts token is minted in-step and passed via exec `env`; or `interceptOutboundHttps` adds the auth header so the token never enters the container (UNVERIFIED).
  2. runs the charter's `install`/`test`/`build`.
  3. writes `dist/` to R2 keyed by SHA.
- Callers: gatekeepers' `SandboxTestRunner` (test-runner.ts:50-58) and the Herald, via a DO binding. It is one RPC inside one `step.do` with a 15-minute timeout.
- Artifacts leave via R2, never step results (≤ 1 MiB; CF:workflows/reference/limits l.31).
- Warm `node_modules` with `snapshotContainer`, keyed by lockfile hash.

**Decision/Recommendation:**
- Containers via our own DO plus `Files`.
- Network: route egress through `interceptAllOutboundHttp` to an allowlist Worker (npm registry and the Artifacts host), not broad `enableInternet`.
- Test and build once per train at the head SHA. Reuse the bundle for preview, staging and prod.

**Open risks:**
- Image build/push needs Docker plus `wrangler containers`.
- Cold start with a large pnpm store.
- `interceptOutboundHttps` TLS semantics are UNVERIFIED.
- Public-beta scheduling.
- **This is the biggest schedule risk. The no-build template is the demo fallback.**

## 6. Secrets

**Cloudflare Secrets Store: not viable per hive.**
- It is in open beta (CF:secrets-store).
- Limits: **1 store and 100 secrets per account**. Values ≤ 65,536 bytes are "no longer … accessed via API or on the dashboard" (CF:secrets-store/manage-secrets l.17-23).
- Access is **binding-only, declared at deploy time**: `secrets_store_secrets:[{binding, store_id, secret_name}]` (WS:1457-1484) → `env.X.get(): Promise<string>` (WT:16629-16635). Binding requires Secrets Store Edit or the Deployer role, plus the `workers` scope (CF:secrets-store/access-control l.59-78).
- So **a Worker cannot read an undeclared secret at runtime**.
- It does suit the *user's* app secrets in *their* account: the Herald can emit `secrets_store_secret` bindings (WC:163855-163861).

**Vault DO: recommended.**
- **Encryption:** envelope scheme with a random 256-bit DEK per secret, AES-GCM (96-bit IV), and AAD `hive|ref|version`. The DEK is wrapped by the KEK with AES-KW. All are supported in Workers (CF:workers/runtime-apis/web-crypto l.322-336).
- **KEK:** the Worker secret `VAULT_KEK`, on the vault Worker only.
- **Storage:** SQLite rows `{ref, kekVersion, wrappedDek, iv, ct, createdAt, lastUsed}`.
- **Isolation by binding topology.** DO RPC carries no caller identity, so only scripts that bind the class (WS `durable_objects.bindings[].script_name`) can call it:
  - Only `apps/vault` (Access-gated `POST /vault/:hive/secrets`) and `apps/herald` bind `VAULT`.
  - The Queen does not bind it, so it **cannot** read values. It stores only `secret://cloudflare/prod`.
- **Herald rules:**
  - call `vault.reveal(hive, ref)` inside the step that uses it;
  - never return or log the value, or put it in `NonRetryableError` text;
  - redact `Bearer …` in all errors.
- **Risks:**
  - KEK compromise exposes everything. Version the KEK so it can be rotated.
  - Plaintext lives in Herald memory during the call.
  - Workers Logs/traces may capture error text (what traces record is UNVERIFIED).
  - Add per-hive allow checks inside the Vault as defence in depth.

**Cloudflare credentials:**
- **Creating tokens via API** needs an initial token with "Account API Tokens Edit", or the "Create additional tokens" template (CF:fundamentals/api/how-to/create-via-api). Endpoints: `POST /accounts/{acct}/tokens` and `/user/tokens` (WC:80017, 110501). That is a worse ask than the scoped token itself.
- **Deep link exists:**
  - account token: `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<urlenc JSON>&name=QueenOS%20Deploy`
  - user token: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=…&accountId=*&zoneId=all&name=…`
  - permissions: `[{"key":"workers_scripts","type":"edit"},{"key":"account_analytics","type":"read"}]` (CF:fundamentals/api/how-to/account-owned-token-template l.74-202), plus `workers_routes` edit only for custom domains. The Observability-read key is UNVERIFIED.
- **Validation:**
  1. `GET /accounts/{acct}/tokens/verify` (account token; WC:80109), else `GET /user/tokens/verify` (WC:110570).
  2. `GET /accounts/{acct}/workers/subdomain` checks read access and the account match (WC:159951).
  3. **Write probe:** `POST /accounts/{acct}/workers/workers {name:<app>}`, which is needed anyway (WC:176775). 409 means OK; 403 means Workers Scripts Edit is missing.
- **OIDC/federation for the Cloudflare API: none found.** Cloudflare does offer **OAuth clients**:
  - scopes such as `workers-platform.write`;
  - endpoints `https://dash.cloudflare.com/oauth2/{auth,token,revoke}` and `/.well-known/jwks.json`;
  - available on all plans (CF:fundamentals/oauth/create-an-oauth-client, …/integrate-with-cloudflare).
  - This is the post-hackathon "Connect Cloudflare" button. Exact scopes and refresh lifetime are UNVERIFIED.
- **AWS later: feasible.**
  - A public Worker serves `/.well-known/openid-configuration` and `/jwks.json`.
  - QueenOS signs an RS256 JWT with RSASSA-PKCS1-v1_5 (web-crypto l.322) using a private key held in the Vault. Claims: `iss`, `sub=hive:<id>:env:<env>`, `aud=sts.amazonaws.com`, `exp ≤ 1h`.
  - The Herald calls STS `AssumeRoleWithWebIdentity` (unsigned query API) via `fetch`.
  - IAM OIDC provider setup and thumbprints: AWS docs (`docs.aws.amazon.com/IAM/…/id_roles_providers_create_oidc.html`). Details UNVERIFIED.

**Decision/Recommendation:**
- `apps/vault` Vault DO with a dedicated wizard form (never the chat).
- The user creates the token from the deep link; we verify it and run the write probe.
- User app secrets go in as `secret_text` per upload, from the Vault.
- OAuth and AWS OIDC come later.

**Open risks:**
- Account vs user token verify endpoints differ, so try both.
- The Vault is our own crypto: keep it small, and test it with known-answer vectors.

## 7. Genesis

**Agents SDK** (`agents@0.26.0`, npm, modified 2026-10-02):
- Exports `./ai-chat-agent`, `./chat`, `./client`, `./ai-react`.
- Peers: `ai ^6||^7`, `zod ^4` (we use ^4.6.5, so compatible), `react ^19`. Deps include `esbuild`, `@rolldown/plugin-babel` and babel decorators.
- Edge-native, but it routes LLM calls through the Vercel AI SDK rather than our AI Gateway client (hive-kit `ai-gateway.ts`), and adds its own `routeAgentRequest` and WS protocol next to Hono.

**Recommendation:** our own `GenesisNode` DO, about 300 lines:
- the Queen's hibernating-WS pattern;
- SQLite message log;
- hive-kit AIG client with an `emit_charter` tool, validated by a new `HiveCharterSchema` (Zod, in queen-types);
- on accept, hand the charter to the Registry and go idle.

Revisit `AIChatAgent` (resumable streams) after the deadline.

**Charter (`.queen/charter.yaml`), names only:**
- `name`, `stack`
- `targets:[{type:cloudflare, account:secret-ref, workers:{prod:<app>, staging:<app>-staging}, domains?}]`
- `build:{install,test,build,outdir}`
- `smoke:[{path,expect}]`
- `policy:{canary:[1,10,50,100], window:"5m", slo:{…}}`
- `secrets:[{name, ref:"secret://…", env:[staging,prod]}]`

**Bootstrap (Provisioner `createHive`, not Genesis or the Queen):**
1. `ARTIFACTS.create(hive, {setDefaultBranch:"main"})` → `{remote, token}` (WT:12721; discovery §1). `ALREADY_EXISTS` means resume.
2. Push the initial commit (charter plus scaffold) with isomorphic-git, using the drone commit path (discovery §2).

**Decision/Recommendation:** own DO plus hive-kit for Genesis; Provisioner `createHive` for the repo.

**Open risks:** LLM charters may name unsupported stacks. Gate them to a template allowlist (no-build JS, Hono + wrangler).

## 8. Access, domain and site URLs (`queenos.kaikeru.com`, team `kaikeru`)

**One origin, one Access app.** `queenos.kaikeru.com` serves both the dashboard and the API from **one Worker** (the Queen's edge Worker).
- The dashboard is Workers Static Assets: `assets:{directory:"../dashboard/dist", not_found_handling:"single-page-application", run_worker_first:["/hives/*","/registry/*","/vault/*","/genesis/*","/internal/*"]}` (WS:4206-4245: `not_found_handling` enum, `run_worker_first` string[]).
- Same-origin `wss://queenos.kaikeru.com/hives/:ns/room` means no CORS and no cross-site cookies.
- Vault and Genesis are reached through **fetch service bindings** to their Workers (write-only Vault HTTP API, never the Vault DO). Access identity is **not propagated** over service bindings or RPC (CF:workers/configuration/cloudflare-access l.245). The edge therefore forwards the verified email in a header that only it can set.
- **Reject a separate `api.` host.** It brings CORS plus a cookie on a second hostname. Access *can* protect several domains in one app (CF:cloudflare-one/…/authorization-cookie l.28-32), but one origin is simpler.

**WebSockets.** "Worker-level Access policies do not currently support WebSocket connections … will fail with a `403`". The fix is to "protect it with a **hostname-based** Access application instead" (CF:workers/configuration/cloudflare-access l.85-89).
- So: create a **self-hosted app on the hostname**, not the Workers "protect this Worker" toggle.
- The browser sends the app-domain `CF_Authorization` cookie on the same-origin `wss` upgrade, as standard cookie behaviour on the handshake GET. That Access validates it on the upgrade is implied by l.89 but **UNVERIFIED**. Day-1 test.
- The app cookie lives on the protected domain, and a separate global session cookie lives on `kaikeru.cloudflareaccess.com` (authorization-cookie l.23-26).

**Defense in depth (edge Worker, Web Crypto only).**
- Read `Cf-Access-Jwt-Assertion`; prefer it over the cookie, which "is not guaranteed to be passed" (validating-json l.17-19).
- Fetch the JWKS from `https://kaikeru.cloudflareaccess.com/cdn-cgi/access/certs`. Cache it about 10 min by `kid`; the endpoint lists the current and the previous key (l.23-29).
- Verify RS256 with `crypto.subtle.importKey("jwk", …, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"})` (header `alg:"RS256"`, `kid`; application-token l.33-34, l.146).
- Checks:
  - `aud` includes `ACCESS_AUD`;
  - `iss === "https://kaikeru.cloudflareaccess.com"`;
  - `exp`/`nbf`/`iat` with 60 s skew;
  - `type === "app"`.
- **Users:** `email` must end with `@${ACCESS_EMAIL_DOMAIN}` (default `kaikeru.com`). This is a second layer behind the Access policy.
- **Service tokens:** `sub === ""` and `common_name` (= `CF-Access-Client-Id`) is in `ACCESS_SERVICE_CLIENT_IDS` (application-token l.51-60 user claims, l.120-142 service-token claims).
- Vars: `ACCESS_TEAM_DOMAIN=https://kaikeru.cloudflareaccess.com`, `ACCESS_AUD=<tag>`, `ACCESS_EMAIL_DOMAIN=kaikeru.com`, `ACCESS_SERVICE_CLIENT_IDS=""`.
- `ctx.access` (WT:502, 613-616) is documented for authenticated *direct* invocations (l.205-209). Treat it as a convenience, not the check.
- Local dev uses the `access.dev` mock (WS:347).
- ⚠ Checked 2026-10-02: `https://kaikeru.cloudflareaccess.com/cdn-cgi/access/certs` returned an **Access error page**, not a JWKS. Confirm the team name and that Zero Trust is initialized.

**Machine callers.**
- Drones, gatekeepers, Provisioner, Herald and Sentinel reach the Queen over **DO RPC**, and Access does not sit on RPC (no hostname; l.245).
- Artifacts `triggers.events` → Workflow and Workflow → DO calls are internal (discovery §1). Unaffected.
- Remaining HTTP machine routes (`/internal/*`, `/audit`, `/scribe`): **keep the bearer `QUEEN_INTERNAL_TOKEN`**, and also let them pass Access with a **service token** (`CF-Access-Client-Id/Secret` headers; CF:cloudflare-one/…/service-tokens l.159-166) via a "Service Auth" policy. Callers are ops scripts only, so two secrets are acceptable. Drop the routes later.
- `/sentinel/ingest` (from the user's account tail Worker) lives on the **herald Worker's own host**, outside Access, authenticated by HMAC.
- **Set `workers_dev:false` and `preview_urls:false`** (WS:67-78; workers_dev defaults to true) on queen, vault and genesis. Otherwise `*.workers.dev` bypasses the Access app.

**Project site URLs** (Custom Domains need the zone in the deploy account, CF:workers/configuration/routing/custom-domains l.42, so these names apply only to hives deployed into the kaikeru account; other users get workers.dev or their own zone).
- **Universal SSL** covers only the apex and first-level names. `x.queenos.kaikeru.com` "will not serve a valid certificate" without ACM/Total TLS or a custom cert (CF:ssl/edge-certificates/universal-ssl/limitations l.27-31).
- **However**, creating a Worker **Custom Domain** "generate[s] an Advanced Certificate … includ[ing] multi-level subdomains … no separate Advanced Certificate Manager subscription is required" (custom-domains l.171-173). The certs are **not** deleted with the domain (l.179), so the Herald must clean them up. Custom Domains do **not** support wildcards (l.138). The account limit is 100 custom domains per zone (CF:workers/platform/limits).
- **Prod:** `<project>.queenos.kaikeru.com` as a Custom Domain on `<project>` (Herald `PUT /workers/domains`, §3).
- **Staging:** `<project>-staging.queenos.kaikeru.com` on `<project>-staging`.
- **Canary:** the prod hostname.
- **Previews:** default to **workers.dev Preview URLs** (`t-<id>-<project>.<sub>.workers.dev`), which need no certificates.
  - Optional custom preview host: `<project>-preview.kaikeru.com` (a first-level name) with `previews_enabled:true, enabled:false`. That yields `t-<id>.<project>-preview.kaikeru.com`.
  - Cloudflare "creates a wildcard DNS record and SSL certificate", but "for deeper hostnames, you may need ACM" (CF:workers/previews/custom-domains). Whether second-level preview wildcards are free is **UNVERIFIED**.
  - Avoid `*.queenos.kaikeru.com` previews, which would be third-level.
- **WfP** would need a wildcard route `*.queenos.kaikeru.com/*` to a dispatcher, plus a wildcard cert at second level, so ACM/Total TLS. That is one more reason to reject it (§2).
- Project sites are **outside** the QueenOS Access app, whose hostname is exact. To protect previews only, put a separate Access app (or the Worker-level "previews only" option, l.83) on the preview host. Gatekeepers then need a service token, and app WebSockets will 403 under Worker-level Access (l.87).

**One-time setup (user):**
1. **Zero Trust:** confirm team `kaikeru` (team domain `kaikeru.cloudflareaccess.com`) and an identity provider. One-time PIN is fine. (UNVERIFIED: the certs URL currently errors.)
2. **Access app:** Access → Applications → Add → **Self-hosted**, domain `queenos.kaikeru.com`, all paths, session 24 h.
   - Policy "kaikeru staff": Allow, Include → *Emails ending in* `@kaikeru.com`.
   - Policy "ops machines": **Service Auth**, Include → Service Token `queenos-ops`. Create that token first and store its secret in a password manager.
3. **AUD tag:** copy it from the app's settings ("Application Audience (AUD) Tag", validating-json l.94-102) into `ACCESS_AUD` in `apps/queen/wrangler.jsonc` vars.
4. **Custom Domain for the edge Worker:** `routes:[{pattern:"queenos.kaikeru.com", custom_domain:true}]`, then `wrangler deploy`. DNS and cert are created automatically (custom-domains l.19, l.54). There must be **no existing CNAME** at that name (l.42).
5. Add `workers_dev:false`, `preview_urls:false` and the four `ACCESS_*` vars. Deploy, then open the site, sign in and confirm `/hives/demo/room` connects.
6. **Project custom domains** (later): the hive's deploy token needs zone permission on `kaikeru.com` (`workers_routes` edit; full set for `/workers/domains` UNVERIFIED).

**Decision/Recommendation:** single host `queenos.kaikeru.com`, a hostname-based self-hosted Access app, and RS256 JWT checks plus the email-domain check in the edge Worker. Bearer plus service token for `/internal/*`. Project prod and staging on per-host Custom Domains under `queenos.kaikeru.com`; previews on workers.dev.

**Open risks:**
- WebSocket upgrade through hostname Access is UNVERIFIED.
- The team certs URL errors today.
- Advanced-cert issuance time and quotas for many project hosts are UNVERIFIED.

## (a) Proposed architecture

**Components (where each lives):**
- **`apps/queen`**
  - `QueenNode`: trains, releases, environments and deployments in **one** SQLite DB. Pure planners in `src/train/planner.ts` and the new `src/release/planner.ts`.
  - `HiveRegistry` DO (`idFromName("registry")`): projects and wizard state, **no secrets**.
  - Hono routes behind Access.
- **`apps/drones`**
  - Drone Workflow (unchanged).
  - **Provisioner** Workflow: `fork`, `delete`, `createHive`.
  - **Reverter** role. isomorphic-git 1.42.6 exports `cherryPick`, `merge` and `walk` but **no `revert`** (`index.js:18229`). The drone writes the culprit's parent blobs for the paths it touched. If a later train touched the same paths, it falls back to LLM rework.
- **`apps/herald`** (new)
  - **Herald** Workflow: `preview | deletePreview | staging | canaryStep | rollback | installTail`.
  - **Sentinel** Workflow, plus the `/sentinel/ingest` route and the `SentinelLedger` DO.
  - Supporting package `packages/deploy-kit`: REST client for §1-3, blake3, multipart builders, fakeable ports.
- **`apps/vault`** (new): `Vault` DO plus the Access-gated write API. Bound only by vault and herald.
- **`apps/genesis`** (new): `GenesisNode` DO.
- **`apps/foundry`** (new): container `Foundry` DO plus its image. Used by gatekeepers (tests) and the Herald (bundle → R2 `bundles/<hive>/<sha>/`).
- **`apps/gatekeepers`**: `SandboxTestRunner` → Foundry, then smoke tests against the train's Preview URL.

**Merge-train flow:**
1. The planner emits `provisionFork`. The DO dispatches the Provisioner (`<trainId>-fork`), which calls back `forkReady` over RPC.
2. The builder drone builds and pushes.
3. The Queen dispatches the Herald `preview` (`<trainId>-preview`). The Herald takes the Foundry bundle, deploys it, and calls back `previewReady{url, versionId}`.
4. Gatekeepers test the URL and report a verdict.
5. The lander lands. `deletePreview` and `deleteFork` follow.

**Release-train flow:**
1. Landed trains accumulate into a release `R = {baseProdSha, trains[t1..tk] with landedSha}`.
2. The Herald deploys R's head to staging, and the Sentinel validates it.
3. **On staging failure:** the planner bisects over the `landedSha` boundaries (stage the midpoint SHA; log₂k Herald + Sentinel rounds). The Reverter reverts the culprit, a rework prompt is queued, and the release is re-cut.
4. **On pass:** the release waits in `AWAITING_TAP`. The human taps (Access identity recorded), and the Queen issues `canaryStep 1%`.
5. Sentinel verdicts drive the 10/50/100 steps or a rollback. A canary rollback also triggers a staging bisect.

**Queen refactor (orchestrator only):**
- Replace the inline `ArtifactsForkProvisioner` (queen-node.ts:104, 390-407) with a `ProvisionerDispatcher` that uses deterministic instance ids. The existing planner inputs `forkReady`/`forkDeleted` become the RPC callbacks.
- **Hazard:** fork chaining is serial (planner.ts:348-400). Each link now pays a Workflow start plus a callback. That latency is unmeasured (UNVERIFIED). The creation limit (100/s per Workflow, CF:workflows/reference/limits l.38) is not binding. **Mitigation if slow:** let the builder drone perform its own fork as its first step.
- **No cross-DO transaction is needed:**
  - the Vault holds only values;
  - Registry → Queen `initHive(charter)` is idempotent;
  - Sentinel ledgers are advisory;
  - all Queen → executor commands stay persisted intents, replayed by the reconcile alarm (queen-node.ts:212-215, 418-423).

**SQLite sketch (QueenNode):**
```sql
environments(hive, env CHECK(env IN('preview','staging','canary','prod')), script, url, stable_version, candidate_version,
             split_pct INT, health, health_summary, updated_at, PRIMARY KEY(hive, env, script));
deployments(id PK, hive, env, kind /*preview|staging|canary_step|rollback|delete*/, train_id, release_id, sha, version_id,
            versions_json /*[{id,pct}]*/, url, status /*PENDING|DISPATCHED|LIVE|FAILED|DELETED*/, verdict, summary /*≤500*/, created_at, updated_at);
releases(id PK, hive, base_prod_sha, head_sha, train_ids_json, phase /*COLLECTING|STAGING|BISECTING|AWAITING_TAP|CANARY|SHIPPED|ROLLED_BACK*/,
         canary_pct INT, bisect_lo, bisect_hi, culprit_train, tapped_by, tapped_at, created_at);
```

**New WS messages:**
- `{type:"environment.updated", environment}`
- `{type:"deployment.updated", deployment}`
- `{type:"release.updated", release}`
- `{type:"sentinel.verdict", releaseId, env, verdict, summary, metrics:{n, errRate, p99Ms}}` (compact numbers from the verdict only)

**Herald → Queen RPC:** `deploymentResult({deploymentId, ok, versionId?, urls?, summary})`.

**Wizard (`HiveRegistry`, resumable):**
1. `DRAFT`
2. `CHARTER_READY`: Genesis accepted the charter.
3. `DEPLOY_CONNECTED`: Vault ref stored; verify and write probe passed.
4. `HIVE_CREATING` → `HIVE_CREATED`: Provisioner `createHive`.
5. `FIRST_FLIGHT`: prompt #1 "scaffold" submitted; waits for `previewReady`.
6. `ACTIVE`

Each step stores `{step, attempt, lastError}`, and reopening the wizard resumes there. UI: a Projects home (Registry list) and a Sites panel driven by `environments`.

**Auth:** Cloudflare Access on the one origin `queenos.kaikeru.com`, plus JWT checks in the edge Worker. See §8.
- Audit rows and `releases.tapped_by` take `email` from the verified JWT.

## (b) Phased plan (today 10-02 → due 10-14)

| Phase | Dates | Slice | Done when |
|---|---|---|---|
| P0 | 10-03 | Day-1 verification (d) on a real account | Table filled |
| **P1: smallest demo** | 10-03 → 10-05 | Queen refactor (Provisioner). Herald `preview` for the **no-build template**: Artifacts tree → Worker Preview via REST → URL on the train card. Gatekeeper smoke `GET url → 200`. Token kept as a wrangler secret for now. | A train card shows a live URL; a `[fail]` train fails on a real 500 |
| P2 | 10-05 → 10-07 | §8 setup: Access app plus `queenos.kaikeru.com` one-origin edge (assets + `/hives/*` + WS) with JWT/email checks and `workers_dev:false`. Registry and Projects home, wizard, Vault (form → DO), token verify, write probe and deep link, minimal Genesis → charter → `createHive` → first flight | A signed-in @kaikeru.com user takes a new hive from chat to preview URL with no CLI; anonymous requests and workers.dev get 403/404 |
| P3 | 10-07 → 10-10 | Release planner (pure, tested), staging script, tap-to-ship, canary steps, rollback. Sentinel (synthetic + tail) with SLO checks. Sites panel (prod/staging Custom Domains under `queenos.kaikeru.com`). | 1→10→50→100 promotion and an auto-rollback demo |
| P4 | 10-10 → 10-12 | Foundry (Containers): real `pnpm install/test/build` → R2 bundle; gatekeepers on real tests | A Hono project with deps passes the ladder |
| P5 | 10-12 → 10-13 | Bisect plus Reverter drone, demo video, docs | A bad train is found and reverted automatically |
| buffer | 10-14 | Artifacts billing starts today (discovery.md l.3) | Ship |

If P4 slips, demo P1-P3 on the no-build template.

## (c) Summary

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Deploy without wrangler | `POST …/scripts/{s}/versions` multipart + `POST …/deployments`; assets: session → `assets/upload` → jwt | Verified (WC) |
| 1 | Bundle in a Worker | No for real projects (pre-compiled Wasm only, no npm). Bundle in a container. | Docs + inference |
| 2 | Preview per train | **Worker Previews** API: isolated DO per Preview, 500/Worker on Paid, `urls[]` returned | Verified (WC + docs); pricing UNVERIFIED |
| 2 | WfP / version aliases | WfP: $25/mo and no gradual. Aliases: no DO/Containers, no logs | Verified (docs) |
| 3 | Canary | 2-version percentage deployment; per-request split; Version-Key for affinity; Version-Overrides to pin; rollback = 100% old (`force` if secrets changed) | Verified (docs + WC) |
| 3 | Staging | Separate `<app>-staging` script | Recommendation |
| 4 | Health | Tail Worker (per-version, seconds) + synthetic probes; Observability API cross-check; GraphQL `scriptVersion` | Tail verified (WT); rest UNVERIFIED |
| 5 | Builds/tests | DO + `ctx.container` + `@cloudflare/sandbox` Files; 1-3 s cold start; about $0.004 per 3-min run | Verified (WT, SB, docs) |
| 6 | Secrets Store | 1 store and 100 secrets per account, binding-only, no runtime lookup → not multi-tenant | Verified (docs) |
| 6 | Vault DO | AES-GCM + AES-KW envelope; only herald and vault bind it | Design |
| 6 | Tokens | Template deep link, verify endpoints, write probe; OAuth clients later; no OIDC federation | Verified (docs + WC) |
| 7 | Genesis | Own DO + hive-kit; agents@0.26 viable but heavy | npm + design |
| 8 | Auth | One origin `queenos.kaikeru.com`, hostname-based self-hosted Access app (Worker-level Access breaks WS), RS256 JWT + `aud`/`iss` + `@kaikeru.com` checks in the edge | Docs verified; WS through Access UNVERIFIED |
| 8 | Site URLs | Prod/staging = per-host Custom Domains (free multi-level cert); previews = workers.dev; avoid wildcard (ACM) | Verified (docs); second-level preview wildcard UNVERIFIED |

## (d) Day-1 verification addendum (real account; fold into docs/day1-verification.md)

1. **Preview API by hand.** Run `POST /workers/workers {name}`, then `POST …/previews {name:"t-abc"}`, then `POST …/previews/t-abc/deployments` (multipart `metadata{main_module, compatibility_date, env}` + `files`).
   - Record the `urls`, the name rules, error codes 10025/10222 (WC:177798) and time to first 200.
   - Also try a Worker with a DO class, and `DELETE`.
2. **Version upload via raw `fetch` from a Worker:** one module, a `secret_text` binding and `keep_bindings`. Confirm the part naming, and whether `versions` creates a missing script.
3. **Assets session from a Worker:** our blake3 hashes must match (a second upload returns empty `buckets`).
4. **Gradual deployment:**
   - deploy at 10/90 and count the split over 1,000 requests;
   - check that the Version-Overrides pin works on workers.dev, and measure its lag;
   - roll back with and without changed secrets.
5. **Tail Worker:** attach it via script-settings. Confirm `scriptVersion.id` under a split, measure delivery latency, and try it on a Preview.
6. **Observability and GraphQL:** look for the version key via `telemetry/keys`. Introspect GraphQL `workersInvocationsAdaptive` for `scriptVersion`, and measure data lag.
7. **Tokens:** the account-token deep link opens pre-filled; each token type passes the right verify endpoint; the write probe returns 403 without Workers Scripts Edit.
8. **Containers:**
   - minimal Foundry: `git clone` from Artifacts, then `pnpm install && pnpm test`, cold vs snapshot-warm;
   - `interceptOutboundHttps` header injection;
   - writing a 5 MB bundle to R2.
9. **Provisioner latency:** Workflow `create()` → first step → DO RPC callback, median of 20 runs. This decides the fork-in-drone mitigation.
10. **Access:**
   - `https://kaikeru.cloudflareaccess.com/cdn-cgi/access/certs` returns a JWKS (it errored on 10-02);
   - `wss://queenos.kaikeru.com/hives/demo/room` upgrades through the hostname app with only the cookie;
   - the JWT carries `email`/`aud`/`iss` as documented; a non-@kaikeru.com JWT and a service-token JWT behave as designed;
   - `*.workers.dev` for queen is disabled;
   - `ctx.access` is present or absent under hostname Access.
11. **Custom Domain** `demo.queenos.kaikeru.com`: certificate issuance time, the `PUT /workers/domains` permission set, and cert cleanup on delete. Also a preview host `demo-preview.kaikeru.com`: does `t-x.demo-preview.kaikeru.com` get a cert without ACM?
