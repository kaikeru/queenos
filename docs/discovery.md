# QueenOS Discovery: Platform Unknowns (2026-10-02)

Hackathon deadline is 2026-10-14. **Artifacts billing also starts on 2026-10-14** ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/): "Cloudflare will begin billing for Artifacts operations and storage on October 14, 2026"; Workers Paid only. After that date, operations cost $0.15 per 1k beyond 10k/month and storage $0.50/GB-mo beyond 1 GB).

Citation shorthand:
- **WT** = `node_modules/.pnpm/@cloudflare+workers-types@5.20261002.1/node_modules/@cloudflare/workers-types/index.d.ts`
- **WS** = `node_modules/.pnpm/wrangler@4.147.0_@cloudflare+workers-types@5.20261002.1/node_modules/wrangler/config-schema.json`
- **WC** = the same wrangler package, `wrangler-dist/cli.js`
- **CF:** = `https://developers.cloudflare.com/` + path

Anything not backed by a source is marked UNVERIFIED. "Spike" means I ran it locally in workerd (wrangler 4.147 `dev`, compat date 2026-10-02) from a scratch project outside the repo.

---

## 1. Artifacts API binding (`env.ARTIFACTS`)

**Config** (WS:1489-1518): `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "queenos", "remote"?: true }]`. The binding is not inherited by named envs. Use `remote: true` in `wrangler dev` to reach real Artifacts (UNVERIFIED whether a local simulator exists). The docs require wrangler >= 4.145.0 for types ([CF:artifacts/api/workers-binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)).

**Namespace-level surface** (WT:12712-12781), quoted:
```ts
interface Artifacts {
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult>; // :12721
  get(name: string): Promise<ArtifactsRepo>;                                                  // :12738  throws NOT_FOUND | CREATE_/IMPORT_/FORK_IN_PROGRESS
  import(params: { source: { url: string; branch?: string; depth?: number };
                   target: { name: string; opts?: { description?: string; readOnly?: boolean } } }): Promise<ArtifactsCreateRepoResult>; // :12752
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;          // :12770  limit 1-200, default 50
  delete(name: string): Promise<boolean>;                                                     // :12780  "Delete a repository and all associated tokens"; false if not found
}
```
**Repo handle** (WT:12574-12671). It is a `Disposable` RPC stub, so use `using repo = await env.ARTIFACTS.get(name)`:
```ts
interface ArtifactsRepo extends Disposable {
  createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsCreateTokenResult>; // :12581 ttl default 86400, 60..31536000
  listTokens(): Promise<ArtifactsTokenListResult>;                                         // :12586
  revokeToken(tokenOrId: string): Promise<boolean>;                                        // :12593
  info(): Promise<ArtifactsRepoInfo>;                                                      // :12600
  readBlob(hash: string): Promise<Blob | null>;                                            // :12609
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;                            // :12618
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;                       // :12627
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;                     // :12638
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]>; // :12649 first-parent, newest first, ref default HEAD, limit<=1000
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<ArtifactsCreateRepoResult>; // :12663 defaultBranchOnly default TRUE
}
```
**Related types** (WT:12441-12565):
- `ArtifactsRepoInfo {id, name, description, defaultBranch, createdAt, updatedAt, lastPushAt, source /* "artifacts:ns/repo" if fork */, readOnly, remote}`
- `ArtifactsCreateRepoResult {id, name, description, defaultBranch, remote, token}`. The token is plaintext and returned only at creation.
- `ArtifactsCreateTokenResult {id, plaintext, scope, expiresAt}`
- `ArtifactsTreeEntry {name, mode, hash, type: "tree"|"blob"|"symlink"|"gitlink"|"exec"}`
- `ArtifactsCommitMetadata {hash, treeHash, message, author{name,email}, committer{name,email}, parents[], authoredAt, committedAt}` (Unix seconds)
- `ArtifactsError {name:"ArtifactsError", code: ArtifactsErrorCode, numericCode}` (WT:12678-12704). Codes: ALREADY_EXISTS, NOT_FOUND, CREATE/IMPORT/FORK_IN_PROGRESS, INVALID_INPUT, INVALID_REPO_NAME, INVALID_TTL, INVALID_URL, REMOTE_AUTH_REQUIRED, UPSTREAM_UNAVAILABLE, MEMORY_LIMIT, INTERNAL_ERROR.

**What does NOT exist on the binding:** no branch, ref or tag create/update/delete; no `resolveRef`; no write, commit or notes API; no merge. The [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) states: "The Artifacts binding creates and manages repos, but it cannot read or write files inside them — for that, you need Git". The REST API is also read-only for content: log, commit, tree, blob and file only ([CF:artifacts/api/rest-api](https://developers.cloudflare.com/artifacts/api/rest-api/) §Repo content).

**Answers**
- **Fork main → `train-X`:** forks are repo-level, not branch-level. Use `using base = await env.ARTIFACTS.get("hive"); const f = await base.fork("hive-train-X", { defaultBranchOnly: true });`. You get a new repo with its own `remote` and `token`. A *branch* `train-X` inside the same repo can only be created by a git push (isomorphic-git, §2). The [best-practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/) page advises: "Do not use one shared repo as a queue for many autonomous agents", and recommends one repo per agent, session or fork target ([CF:artifacts/concepts/repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/) l.82). **Use repo-per-train forks.**
- **Fork is async-ish:** `get()` throws `FORK_IN_PROGRESS` while forking (WT:12736), and `list()` items carry `status: "ready"|"importing"|"forking"` (workers-binding doc). The TS type for list items (`Omit<ArtifactsRepoInfo,"remote">`) lacks `status`, which is a doc/type mismatch. Retry `get()` with backoff, for example inside a `step.do` with retries.
- **Delete:** `await env.ARTIFACTS.delete("hive-train-X")` returns a `boolean`.
- **Commit SHA of a ref:** there is no direct method. Use `(await repo.log({ ref: "main", limit: 1 }))[0]?.hash` (WT:12649; returns `[]` if the ref is unresolvable). An alternative over git is `git.listServerRefs` / `getRemoteInfo2` with isomorphic-git. UNVERIFIED: whether `log`/`readFile` accept non-branch refs such as `refs/notes/queen`. If they do, `repo.readFile({ref:"refs/notes/queen", path: commitSha})` reads a note with no git client (beware notes fanout dirs `ab/cdef…` once there are many notes).
- **Zero-copy forks:** **UNVERIFIED.** No doc page says zero-copy or copy-on-write. The docs say only "A fork creates a new repo that starts from an existing repo's history, then diverges independently" ([how-artifacts-works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)). The REST `ForkRepoResult extends CreateRepoResult { objects: number }` (rest-api §Fork) hints that objects are copied and counted. Pricing counts storage across all repos. Assume each fork costs one operation plus a full copy of storage, and keep base repos small (limit is 1 GB/repo, 32 MB/blob, 2,000 req/10 s per namespace control plane and per repo for git ([limits](https://developers.cloudflare.com/artifacts/platform/limits/))).
- **Remote URL / auth:** `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. Tokens look like `art_v1_<40hex>?expires=<unix>`. Git auth is `Authorization: Bearer <full token>`, or Basic with any username and password = token with the `?expires=` suffix stripped. Push uses receive-pack **v1 only**, and fetch supports v1 and v2 including shallow ([git-protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)).

**Events: yes.** WS:4138-4150 enumerates `cf.artifacts.repo.{created,deleted,forked,imported,pushed,cloned,fetched,token.created,token.revoked}`. There are two delivery paths:
1. **Worker trigger → Workflow only** (WS:124-145, 4093-4137). The validation is strict in WC:23556-23610: `targets` must be a non-empty array of `{type:"workflow", workflow_name}`, filter keys are only `namespace` and `repo_name`, and WC:160743-160750 errors unless the target Workflow is defined *by the same Worker*:
   ```jsonc
   "workflows": [{ "name": "gatekeeper", "binding": "GATEKEEPER", "class_name": "Gatekeeper" }],
   "triggers": { "events": [{ "type": "cf.artifacts.repo.pushed",
       "filter": { "namespace": "queenos" },               // omit repo_name → every repo in namespace
       "targets": [{ "type": "workflow", "workflow_name": "gatekeeper" }] }] }
   ```
   ⚠ The docs ([build-and-deploy-on-push](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/) l.236-248) show a *different* shape (`"target": {scriptName, workflowName}`, `filter.repoName`), which **wrangler 4.147 rejects**. Follow the installed schema. Handler: `class Gatekeeper extends WorkflowEntrypoint<Env, PushedEvent> { async run(event: WorkflowEvent<PushedEvent>, step) {…} }` (WT:16484, 16598). UNVERIFIED: that `event.payload` is exactly the event envelope below. Log it on first deploy.
2. **Queues event subscription**: `wrangler queues subscription create <queue> --source artifacts --events …` ([queues/event-subscriptions/manage](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/)). Account-level source is `artifacts` (created/deleted/forked/imported). **`pushed`/`cloned`/`fetched`/`token.*` are repo-level (`artifacts.repo` source, needs namespace + repo_name)** ([event-subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) l.27, l.161). That makes Queues awkward for many ephemeral fork repos. The source-specific CLI flags are UNVERIFIED.

`pushed` envelope (event-subscriptions l.169-209): `{type, source:{type:"artifacts.repo", namespace, repoName}, payload:{ref, before, after, commits:[{id,message,messageTruncated,timestamp,author,committer,parents}], totalCommitsCount, commitsTruncated}, metadata:{accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp}}`. It carries `before`/`after` SHAs, so there's no need to resolve the ref.

**Decision/Recommendation**
- Use one repo per train via `fork()` (`hive` → `hive-train-<id>`). Promotion = drone pushes the train's tip to `hive` `main` (isomorphic-git). Clean up with `delete()`.
- Resolve SHAs with `log({ref, limit:1})`. Treat `FORK_IN_PROGRESS` as retryable.
- `apps/gatekeepers` must become a **Workflow-owning Worker** triggered by `cf.artifacts.repo.pushed` with `filter.namespace="queenos"`. Its current `POST /events/push` HTTP route will never receive events. Update `PushEventSchema` in `@queenos/queen-types` to the envelope above.

**Open risks**
- Fork cost and latency are unmeasured. Spike `fork()` → `get()` timing and the `objects` count on day 1.
- The doc-vs-schema mismatch on `triggers.events` may change. Event delivery semantics (at-least-once? ordering?) are UNVERIFIED, so make the gatekeeper idempotent on `(repoName, after)`.
- Pushes made by our own drones will also fire `pushed`. Filter by ref or author to avoid loops.

---

## 2. Git writes and git-notes from a Worker or Workflow

**(a) isomorphic-git (npm `isomorphic-git@1.42.6`, published 2026-10-01; `pnpm view`).**
- **Officially documented by Cloudflare** for Artifacts ([CF:artifacts/examples/isomorphic-git](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)): `import git from "isomorphic-git"; import http from "isomorphic-git/http/web";` (fetch-based) plus an in-memory `MemoryFS` that implements `promises.{readFile,writeFile,unlink,readdir,mkdir,rmdir,stat,lstat}`. Auth is `onAuth: () => ({ username: "x", password: token.split("?expires=")[0] })`.
- **Notes API exists**: `addNote({fs, dir, ref='refs/notes/commits', oid, note, force, author, committer})` (package `index.js:6739`), plus `readNote`, `listNotes` and `removeNote`. **Push of a notes ref is supported by the code path**: `_push` keeps a `remoteRef` that starts with `refs/` verbatim (`index.js` around l.14630). UNVERIFIED against Artifacts' receive-pack.
- **Buffer:** isomorphic-git's ESM build uses the bare global `Buffer` (`index.js:710`). **Compat date ≥ 2026-08-04 enables `nodejs_compat` + `_v2` by default** ([CF:workers/configuration/compatibility-flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) l.65, l.83). Our date 2026-10-02 therefore already exposes `Buffer`/`process` globals, and "avoid nodejs_compat" is moot. Spike confirmed `typeof Buffer === "function"` with no flags. Transitive `require('buffer')` (safe-buffer/sha.js) resolves to the userland npm `buffer` package. No flag is needed, and our code still never imports `node:*`.
- **Spike result (workerd local):** init → writeFile → add → commit → `addNote(ref:"refs/notes/queen")` → `readNote` → `resolveRef` all succeeded in about 10 ms. Bundle via `wrangler deploy --dry-run`: **564.67 KiB / 114.77 KiB gzip**, far under the 10 MB (Paid) script limit. Gotcha: give fs errors a `.code` (`ENOENT`, `EEXIST`), as the Cloudflare `MemoryFS` helper throws plain `Error`s without `.code`. I used `Object.assign(new Error(..), {code})`.
- **Limits:** 128 MB isolate memory ([CF:workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)). The whole working tree plus pack lives in the JS heap. Workflow step CPU is 30 s by default and configurable to 5 min, wall time unlimited ([CF:workflows/reference/limits](https://developers.cloudflare.com/workflows/reference/limits/)). pako (zlib) and sha1 in JS are CPU-heavy on large packs. Use `clone({singleBranch:true, depth:1})`; Artifacts supports shallow over v1 (git-protocol doc). Keep repos small (tens of MB).

**(b) Native write API:** **none.** The binding and REST API are read-only for content (§1). **ArtifactFS** is a Go FUSE daemon (`go install github.com/cloudflare/artifact-fs/cmd/artifact-fs`) for sandboxes and VMs, not a Worker API ([CF:artifacts/guides/artifact-fs](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)).

**(c) Sandbox / Containers with real git:** `@cloudflare/sandbox@1.0.0` (`pnpm view`, modified 2026-09-30). There's an official template, `cloudflare/sandbox-sdk/examples/git-repo-per-sandbox`, that injects `ARTIFACTS_GIT_REMOTE` ([CF:artifacts/examples/sandbox-sdk-artifacts](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)). It needs Containers, a Dockerfile, a DO binding and cold starts, so it's a heavier operational surface. It's the right tool if drones must *run* code (tests, builds). The `@cloudflare/ci` runner pattern in build-and-deploy-on-push shows this.

**Workflows constraints that affect drones:** step result ≤ **1 MiB**, event payload ≤ 1 MiB, instance state ≤ 1 GB, ≤ 10,000 steps, ≤ 10,000 subrequests per instance by default (workflows limits l.29-44). Default retry is `{limit:5, delay:10000, backoff:"exponential"}, timeout "10 minutes"` ([sleeping-and-retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) l.60-73). `NonRetryableError` comes from `cloudflare:workflows`. Memory is **not** carried between steps, and the step body re-runs on retry. Therefore **never return file contents or packs from `step.do`**. Do clone → edit → commit → note → push inside **one** step and return only SHAs. The git remote is the durable state.

**Decision/Recommendation (Oct 14):** use **isomorphic-git + in-memory fs inside a Workflow step**, with one train fork per drone group and one notes ref per repo (`refs/notes/queen`). Single writer per fork avoids notes non-fast-forward races. Make commits deterministic: pass `author.timestamp`/`committer.timestamp` derived from step input, so a retried step produces the same SHA and the push becomes a no-op. Keep Sandbox as fallback only for "run tests" drones.
```ts
import git from "isomorphic-git"; import http from "isomorphic-git/http/web";
import { MemFS } from "./memfs"; // in-memory fs whose errors carry .code
export async function droneCommit(env: Env, repoName: string, files: Record<string,string>, msg: string, note: object, ts: number) {
  using repo = await env.ARTIFACTS.get(repoName);
  const { plaintext } = await repo.createToken("write", 900);
  const { remote } = await repo.info();
  const onAuth = () => ({ username: "x", password: plaintext.split("?expires=")[0] });
  const fs = new MemFS(), dir = "/w", author = { name: "drone", email: "drone@queenos", timestamp: ts, timezoneOffset: 0 };
  await git.clone({ fs, http, dir, url: remote, ref: "main", singleBranch: true, depth: 1, onAuth });
  for (const [p, c] of Object.entries(files)) { await fs.promises.writeFile(`${dir}/${p}`, c); await git.add({ fs, dir, filepath: p }); }
  const oid = await git.commit({ fs, dir, message: msg, author, committer: author });
  await git.addNote({ fs, dir, ref: "refs/notes/queen", oid, note: JSON.stringify(note), author, committer: author, force: true });
  await git.push({ fs, http, dir, url: remote, ref: "main", onAuth });
  await git.push({ fs, http, dir, url: remote, ref: "refs/notes/queen", remoteRef: "refs/notes/queen", onAuth, force: true });
  return { oid };                                          // ≤1 MiB step result: SHAs only
}
// in DroneWorkflow.run: const { oid } = await step.do("commit", { retries:{limit:3, delay:"5 seconds", backoff:"exponential"}, timeout:"5 minutes" }, () => droneCommit(...));
```
Note that `mkdir` must be recursive in `writeFile` for nested paths. The Cloudflare helper does this.

**Open risks**
- UNVERIFIED: Artifacts receive-pack accepting `refs/notes/*`. Spike against a real repo on day 1. If it's rejected, fall back to a `queen-notes` branch holding `notes/<sha>.json`, or store notes in Queen SQLite only.
- `force:true` on the notes push overwrites concurrent writers, so this is safe only under single-writer-per-repo. Shallow clone does not fetch existing notes. To append to notes, `git.fetch({ref:"refs/notes/queen"})` first (UNVERIFIED that isomorphic-git fetches non-heads refs cleanly).
- Memory and CPU on repos above ~50 MB are unmeasured. Set `limits.cpu_ms` on the drones Worker if needed.

---

## 3. AI Gateway BYOK

> **Superseded (2026-10-02):** QueenOS now calls models through the Workers `ai` binding (`env.AI.run(model, …, { gateway: { id: "queenos" } })`). It is pre-authenticated, so there is no `cf-aig-authorization` token, and BYOK uses the `default` alias. The section below is kept as history.


**URLs** (provider-native passthrough):
- Anthropic: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages` ([CF:ai-gateway/usage/providers/anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/))
- OpenAI: `…/{gateway_id}/openai/chat/completions` and `…/openai/responses` ([providers/openai](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/) l.31-35)
- Unified: `…/{gateway_id}/compat/chat/completions` with `"model": "anthropic/…"` / `"openai/…"` ([usage/chat-completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/) l.720-740). It is marked **deprecated for standard chat**, in favour of `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions` (REST, standard `Authorization: Bearer <CF token>`, l.19). It's still required for dynamic routes.

**Headers with stored keys** ([configuration/bring-your-own-keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)): BYOK requires an **authenticated gateway**. Send `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` and **omit** `x-api-key`/`Authorization`. "AI Gateway substitutes the stored provider key only when the provider authorization header is absent… Placeholder values cause a provider authentication error." Use `cf-aig-byok-alias: <alias>` for non-default keys. Anthropic still needs `anthropic-version: 2023-06-01`. Note that AIG tokens are account-scoped and can't be limited to one gateway ([configuration/authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) l.14-16).

**Binding alternative.** Config is `"ai": { "binding": "AI" }` (WS:1091-1112; also `remote?`, `staging?`). `env.AI.gateway(id): AiGateway` (WT:12202) has `getUrl(provider?)`, `run(universalReq)`, `getLog` and `patchLog` (WT:12389-12401). `env.AI.run("anthropic/<model>", {messages}, {gateway:{id}})` is **pre-authenticated** (no `cf-aig-authorization`; authentication doc l.48-49) and uses only the BYOK `default` alias, falling through to Unified Billing otherwise ([usage/worker-binding-methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)). `getUrl()` only builds the URL, and a plain `fetch` to it is still an ordinary HTTP call that needs `cf-aig-authorization` (inference from the docs; UNVERIFIED). UNVERIFIED: whether `AI.run` for third-party models passes through Anthropic-native fields (tools, `system`, caching) unchanged.

**Helper sketch (no SDK):**
```ts
type Prov = "anthropic" | "openai";
export async function llm(env: { CF_ACCOUNT_ID: string; AIG_ID: string; AIG_TOKEN: string }, p: Prov, body: unknown, meta?: Record<string, string>) {
  const base = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AIG_ID}`;
  const url = p === "anthropic" ? `${base}/anthropic/v1/messages` : `${base}/openai/chat/completions`;
  const h: Record<string, string> = { "content-type": "application/json", "cf-aig-authorization": `Bearer ${env.AIG_TOKEN}` };
  if (p === "anthropic") h["anthropic-version"] = "2023-06-01";
  if (meta) h["cf-aig-metadata"] = JSON.stringify(meta);          // header listed in WT:12357
  const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AIG ${p} ${r.status}: ${await r.text()}`);
  return r.json();
}
```
**Decision/Recommendation:** use provider-native fetch with BYOK and `cf-aig-authorization` (secret `AIG_TOKEN`). It keeps the Anthropic Messages API intact (tools and so on) and works identically from Workers, DOs and Workflows. Treat the `env.AI.run` binding path as a stretch option (no token secret, but the schema translation is unverified). Wrap LLM calls in `step.do` with retries, and throw `NonRetryableError` on 401/400.

**Open risks:** pass the token through `wrangler secret`. The Unified Billing fallthrough on the binding path could silently bill credits if the BYOK `default` alias is missing. The compat endpoint is deprecated.

---

## 4. WebSocket hibernation correctness (QueenNode DO)

**Rules (sources):**
- On wake, "the Durable Object is re-initialized and its `constructor` runs… Minimize work in the constructor" ([CF:durable-objects/best-practices/websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) l.54, l.68). Schema init must be idempotent and cheap. `setTimeout`/`setInterval` and alarms prevent hibernation (l.342).
- `ws.serializeAttachment(v)` / `deserializeAttachment()` (WT:3802-3803): structured-clone, **≤ 16,384 bytes**, survives hibernation, lost on close (l.348-368).
- `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res))` (WT:706, 815): replies without waking; req and res ≤ 2,048 chars each. `getWebSocketAutoResponseTimestamp(ws)` (WT:708) gives liveness ([CF:durable-objects/api/state](https://developers.cloudflare.com/durable-objects/api/state/) l.183-219).
- `ctx.acceptWebSocket(ws, tags?)`: ≤ 10 tags, each ≤ 256 chars. `getWebSockets(tag?)` and `getTags(ws)` (WT:704-711). **Max 32,768 hibernatable sockets per DO**, with CPU and memory practically lower (state doc l.152-157). `getWebSockets` may return sockets in `CLOSING` (l.171).
- Close: compat ≥ **2026-04-07** enables `web_socket_auto_reply_to_close`. The runtime completes the handshake, and "calling close() is safe but no longer required" (compat l.420-429; websockets doc l.100-101; [base API](https://developers.cloudflare.com/durable-objects/api/base/) l.215). Since **2026-03-03**, `close()` throws `SyntaxError` if reason > 123 UTF-8 bytes (compat l.502-508). RFC 6455 §7.4.1 forbids sending **1005, 1006, 1015** in a close frame. The WHATWG `close()` accepts only 1000 or 3000-4999, and whether workerd throws for 1001-1014 is UNVERIFIED. The 1005 bug came from echoing the client's "no status" code.
- Limits: received message ≤ **32 MiB**. CPU is 30 s per message by default and resets per message ([CF:durable-objects/platform/limits](https://developers.cloudflare.com/durable-objects/platform/limits/) l.30-31). The DO handler always receives binary as `ArrayBuffer` (compat l.409). `durable_object_io_tasks_prevent_eviction` is default from 2026-10-01 (compat l.140-146).

**Audit of `apps/queen/src/queen-node.ts`, concrete fixes (not applied):**
1. **l.10-19:** drop `void ctx.blockConcurrencyWhile(...)`. `sql.exec` is synchronous, so run `CREATE TABLE IF NOT EXISTS` directly in the constructor. A floating `void` promise hides errors. Move toward a `PRAGMA user_version`-guarded migration list so later schema changes stay cheap on every wake.
2. **Constructor:** add `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` so dashboard and drone heartbeats never wake the DO. The client must send the exact string `ping`.
3. **l.28 `fetch`:** accept with tags derived from the query or auth, e.g. `acceptWebSocket(server, ["role:dashboard"])` / `["role:drone", "train:<id>"]`. Call `server.serializeAttachment({ id, role, trainId, connectedAt })` (≤ 16 KiB). Reject with 503 when `ctx.getWebSockets().length` exceeds a sane cap (e.g. 5,000), well below 32,768.
4. **l.54-56 broadcast:** wrap each `socket.send(frame)` in `try/catch` and skip `readyState !== WebSocket.OPEN`. Today a single CLOSING or dead socket throws and aborts the loop, so later clients miss the frame (the throw-on-send behavior is UNVERIFIED but the docs allow CLOSING sockets in the list). Use `getWebSockets("role:dashboard")` / `train:<id>` for targeted fan-out instead of everyone.
5. **l.47-52:** the SQLite insert before send is correct (output gate holds sends until the write is durable). Return the inserted `id` (`RETURNING id`) and include it in the frame for client dedupe and replay. Cap `payload` size before insert.
6. **l.59-62 `webSocketClose`:** with compat 2026-10-02, delete the `ws.close(...)` echo, or at minimum wrap it in try/catch and only send `1000`. The current map still forwards 1015 and other invalid codes, and echoes client `reason` (fine at ≤ 123 bytes). Use `ws.deserializeAttachment()` here to mark presence offline and broadcast a `drone.left` event.
7. **l.64-66 `webSocketError`:** wrap `ws.close(1011, …)` in try/catch, since the socket is often already closed. Log the error argument (signature is `(ws, error: unknown)`).
8. **l.33:** binary frames decode fine. Add explicit `size` guards (e.g. reject > 1 MiB with close 1009 inside try/catch) so a 32 MiB frame can't burn CPU.
9. **Tests:** cover wake-from-hibernation behaviour with `@cloudflare/vitest-pool-workers`, i.e. constructor re-entry and attachment survival.

**Decision/Recommendation:** apply fixes 1-7 before building features on the Queen. Set a protocol rule: dashboard sends literal `"ping"` every 30 s, and server events carry a monotonic `id`.

**Open risks:** whether workerd `close()` throws for 1001-1014 is UNVERIFIED. Auto-response is per-DO and must be re-set in the constructor (cheap, idempotent). A single global `idFromName("queen")` DO is a throughput ceiling; consider one DO per train later.

---

## Compatibility flags and config notes
- `compatibility_date: "2026-10-02"` implies: nodejs_compat (+v2) **on by default** (≥ 2026-08-04, no opt-out flag found, UNVERIFIED); WebSocket auto-reply-to-close (≥ 2026-04-07); close-reason 123-byte limit (≥ 2026-03-03); standard `binaryType="blob"` for non-DO sockets (≥ 2026-03-17); DO I/O prevents eviction (≥ 2026-10-01). **Do not add `nodejs_compat`**; it's redundant and ignored (compat l.83). The CLAUDE.md "no Node built-ins" rule still applies to *our* imports.
- `apps/drones/wrangler.jsonc` needs an `artifacts` binding and the `AIG_*` secrets. `apps/gatekeepers/wrangler.jsonc` needs `workflows` plus `triggers.events` (§1) and an `artifacts` binding.

## Summary

| # | Unknown | Answer | Confidence |
|---|---|---|---|
| 1 | Binding surface | `create/get/import/list/delete` + repo `createToken/listTokens/revokeToken/info/readBlob/readTree/readCommit/readFile/log/fork`. No ref, branch or write APIs | Verified (WT) |
| 1 | Fork / delete / SHA | `(await get(base)).fork("hive-train-X")` / `delete(name)` / `log({ref,limit:1})[0].hash` | Verified (WT) |
| 1 | Zero-copy forks | Not documented; `objects` count hints at copying | UNVERIFIED |
| 1 | Push events | `triggers.events` → **Workflow only**, schema `targets[{type:"workflow",workflow_name}]`, `filter.repo_name` (docs differ); or Queues subscription (repo-level only) | Verified (WS/WC) + docs |
| 2 | Git writes / notes | isomorphic-git + memfs in one `step.do`; notes via `addNote` + push `refs/notes/queen`; 115 KiB gz; works in workerd | Spike-verified locally; Artifacts notes push UNVERIFIED |
| 2 | Native write API | None (binding and REST read-only; ArtifactFS = FUSE CLI) | Verified (docs) |
| 2 | Workflows | step result ≤ 1 MiB, CPU 30 s → 5 min, default 5 retries exp; return SHAs only, deterministic timestamps | Verified (docs) |
| 3 | AIG URL | `gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic/v1/messages`, `/openai/chat/completions`, `/compat/chat/completions` (deprecated) | Verified (docs) |
| 3 | BYOK headers | `cf-aig-authorization: Bearer`; omit provider key; `cf-aig-byok-alias` optional | Verified (docs) |
| 3 | Binding | `"ai":{"binding":"AI"}`; `env.AI.run` pre-authed, default alias only; `gateway(id).getUrl()` | Verified; Anthropic passthrough fidelity UNVERIFIED |
| 4 | Hibernation | cheap idempotent ctor, attachments ≤ 16 KiB, auto-response, tags ≤ 10, 32,768 sockets, auto close-reply since 2026-04-07 | Verified (docs) |
| 4 | queen-node fixes | 9 fixes: no floating bCW, auto ping/pong, tags+attachments, try/catch broadcast, drop close echo, guard error/close | Audit |
| - | Compat | Date 2026-10-02 already enables nodejs_compat; add no flags | Verified (docs + spike) |
| - | Billing | Artifacts billing begins 2026-10-14 (deadline day) | Verified (docs) |
