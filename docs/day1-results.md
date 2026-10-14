# QueenOS Day-1 verification results (2026-10-02, real account)

Account `<account-id>`, workers.dev `<subdomain>`, wrangler 4.147.0, compat date 2026-10-02. All probes ran from throwaway Workers (`queenos-day1-artifacts`, `queenos-day1-do`, `queenos-day1-wf`), using hive-kit's built `dist` (`initRepo`/`cloneRepo`/`GitRepo.push`/`pushNotes`/`addNote`) for git. Everything created was deleted afterwards, except the Artifacts namespace `queenos`. The token was never logged.

Timings are single-run wall clock from inside a Worker unless stated.

## Results

| # | Check | Result | Evidence | Implication for the design |
|---|---|---|---|---|
| 1 | **Push `refs/notes/queen`** | **ACCEPTED.** `GitRepo.addNote` then `pushNotes({force:true})` succeeded in 281 ms. The receive-pack advert and the upload-pack advert both list `refs/notes/queen`, and `refs/notes/queen` is also present in forks (even with `defaultBranchOnly:true`). | Advert: `refs/heads/main`, `refs/notes/queen`; HEAD `symref=HEAD:refs/heads/main`; receive-pack caps `report-status delete-refs ofs-delta side-band-64k` (v1, as documented). | The git-notes Cognitive Ledger works as designed. Keep the `.queen/ledger/<sha>.json` fallback only as a safety net. Forks inherit the notes ref, so a train fork starts with the hive's ledger without an extra fetch. |
| 1b | Read the notes via the binding | **No.** `repo.log({ref:"refs/notes/queen"})` returned `[]` and `repo.readFile({ref:"refs/notes/queen", path:<sha>})` returned `null`, with no error. | `/readnote` probe. | Notes can be read only via git (`fetchRef`/clone). Do not use the binding's read API for notes. |
| 2 | **`create()` + initial push** | `create()` 2650 ms (first call; includes namespace warm-up), initial push 524 ms. The result has keys `id,name,description,defaultBranch,remote,token`. | `defaultBranch:"main"`. | Fine. Creating a hive is a multi-second operation, so do it in a Workflow step. |
| 3 | **`info()` and remote format** | `remote` is `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`, with no token embedded. `info()` returns `{id,name,description,defaultBranch,createdAt,updatedAt,lastPushAt,source,readOnly,remote}`. `get()+info()` takes 30-80 ms. `lastPushAt` stayed `null` after pushes, so don't rely on it. A fork's `source` is `"artifacts:queenos/<base>"`. | Probe output. | Matches the discovery doc and hive-kit. Token shape is **`art_v2_<x>_<40hex>?expires=<unix>`**, not `art_v1_...` as discovery.md says. `stripTokenExpiry` still works (it strips only `?expires=`), but make sure nothing matches on an `art_v1_` prefix. `createToken` returns `{id, plaintext, scope, expiresAt (ISO string, not unix)}`. |
| 4 | **`log({ref:"main",limit:1})`** | Works, 30 ms. It returns `[{hash, treeHash, message, author{name,email}, committer, parents[], authoredAt, committedAt}]` with unix-second times. | Probe output. | Use it to resolve the tip SHA of a branch. |
| 5 | **`fork()` latency** | `fork()` blocks until the fork is ready. 7 samples (5 sequential plus the race and chain runs): 2886, 1934, 1832, 1911, 1955, 2200, 2318 ms, so **p50 about 1.95 s, max 2.9 s**. A fork of a fork (chain) took 2318 ms. Immediately after `fork()` returns, `get()` is ready (34-68 ms). Forking a 12 MB repo gave 4534, 2775 and 2219 ms. | `/fork`, `/chain`, `/forkof`. | The 2-3 s latency is acceptable inside a Workflow step; avoid it on a request path. Fork-in-drone is viable. It adds roughly 2 s per train and is independent of repo size at this scale. |
| 5b | **`FORK_IN_PROGRESS`** | Observed. A `get()` issued while a concurrent `fork()` of that name was running threw `ArtifactsError code=FORK_IN_PROGRESS numericCode=10303`, with the message "Retry after 5 seconds"; it took 987 ms to throw. A retry then succeeded. A duplicate `fork()` of an existing name threw `ALREADY_EXISTS` (10201). | `/forkrace`. | Retry `get()` on `FORK_IN_PROGRESS`, which only matters if one step forks and another gets. `fork()` itself resolves only when ready, so a single awaiting step needs no retry. A retried fork step must treat `ALREADY_EXISTS` as success (or check `get()` first). |
| 6 | **Zero-copy forks** | **Inconclusive, but consistent with zero-copy or copy-on-write.** `info()` has no size or object-count field, and `fork()` returns no `objects` field (the REST doc type's `objects` is absent on the binding). Fork time did not grow with repo size (tiny repo about 2 s; 12 MB random blob about 2.2-4.5 s). Forks share commit SHAs with the base. `defaultBranchOnly:true` forks still carry `refs/notes/queen`. The base repo was deletable while forks existed, and the forks stayed independent. | Probes. Storage billing was not observable through the API. | No evidence that forks multiply storage. Billing is still unverified (check the dashboard storage after Oct 14). Don't over-fork anyway. A large-repo latency run (more than 100 MB) is still unmeasured. |
| 7 | **`delete()`** | Returns `true`. Takes 0.9-3.0 s. Deleting a base that has forks worked. | 14 repos deleted. | Delete trains with a Workflow step and treat a `false` result as already gone. |
| 8 | **`cf.artifacts.repo.pushed` event delivery** | Delivered to a Workflow via `triggers.events`. Push-complete to event `queued` is 1.1-1.6 s. `queued` to first step start is 0.3-4 s. In total, **about 2-5.5 s from `git push` returning to the first step**. Each ref update that changed a ref produces one event. Pushes fired for the main branch, a non-default branch (`refs/heads/feat`), the **notes ref** (`refs/notes/queen`), and **pushes to forks and to plain repos**. | See the payload below. | The gatekeeper must filter by `ref`, ignoring `refs/notes/*` and non-main refs, or the notes push re-triggers the gate. `commits` is `[]` for a notes push. A new branch's `commits` list includes the shared history (`before` is all zeros). Dedupe on `(repoName, after)`. |
| 8b | **Event `event.payload` shape** | `event.payload` is the **envelope WITHOUT `metadata`**. It has `id`, `type`, `source:{namespace, repoName}`, and `payload:{ref, before, after, commits[], totalCommitsCount, commitsTruncated}`. A commit has `{id, message, messageTruncated, timestamp, author{name,email}, committer, parents[]}`. Note: `source.type` is **absent** and `metadata` is **absent**. The workflow `event` also has `timestamp` (ISO, = queue time), `instanceId`, and `workflowName`. | Compare with `apps/gatekeepers/src/event.ts`. | **`PushedEnvelopeSchema` parses it as written**, because `source.type` and `metadata` are optional there. `parsePushEvent` should be fine with `event.payload`. Resolve the UNVERIFIED note in event.ts: the Workflow's `event.payload` IS the envelope. The `id` field is a useful idempotency key. |
| 8c | **Trigger filter syntax** | `filter:{namespace, repo_name}` is accepted at deploy and works with an **exact** `repo_name` and with namespace only. A glob (`repo_name:"queenos-day1-f*"`) is **accepted at deploy but never matched** (no events for a matching fork or for the hive, 45 s after deploy). Redeploying a trigger takes more than 8 s to take effect (two pushes made 8 s after a redeploy produced no event). | Probe series. | **Use `filter:{namespace:"queenos"}` only** and filter repo names in the Workflow (`<hive>-train-*`). Do not rely on prefix filters. Allow about 30-45 s after a deploy before expecting events. |
| 9 | **Cross-script DO RPC from a Workflow** | **Works.** `queenos-day1-wf` (Workflow with a DO binding `script_name:"queenos-day1-do"`) called `stub.ping()` successfully in 6 of 6 runs, about 100-300 ms after the previous step. A DO error keeps its message: `Error: "BAD_THING: detail here"`, with `remote:true`. | `step.do` output. | The `CODE: detail` prefix convention survives RPC (the error name is plain `Error`, so match on the message prefix). The Workflows-to-Queen DO RPC path is viable. |
| 9b | **Circular deploy** | **Binding to a script that does not exist is rejected**: `Cannot create binding for class in script 'queenos-day1-do' that does not exist. [code: 10061]`. Once the target exists, the dependent deploys fine. A reverse binding (DO Worker to a Workflow with `script_name` on the other) also deploys once the other script exists. | `wrangler deploy` output. | **Deploy order matters. Deploy the Worker that owns the DO (queen) first, with no outbound bindings to the Workers that depend on it, then drones/gatekeepers. If queen needs bindings to them, redeploy queen afterwards.** The Provisioner or deploy script must encode this order. First deploy of a cycle needs two passes. |
| 10 | **Workflow start latency** | `create()` returned in 274-552 ms. From before `create()` until the first step ran, 6 samples: 4786, 2491, 3833, 526, 440, 1268 ms, so **p50 about 1.9 s, range 0.4-4.8 s**. The RPC step ran 0.1-0.3 s after the first step. | `/start` probe. | Plan for about 2 s of startup (up to 5 s) before drone work begins. This is fine for the fork-in-drone decision. Don't use Workflows for sub-second interactive paths. |
| 11 | **Vectorize** | `create` (768, cosine) 1.0 s, `upsert` 1.7 s (accepted, returns a `mutationId`), delete OK. **Queries returned 0 matches for 2-3 minutes after upsert**, then returned `{id:"v1", score:1.0, metadata:{hive,kind}}`. `info.vectorCount` stayed 0 throughout. Re-creating an index with the same name right after deleting it returned `index deleted` (40027) on the first upsert; wait a bit or use a new name. | REST `/vectorize/v2/indexes`. | The failure-memory RAG is eventually consistent, with minutes of lag. Never read your own write in the same gate run; the gate must not depend on the just-written failure. Don't reuse a deleted index name immediately. |
| 12 | **AI Gateway** | The account has **no gateways**; `GET /ai-gateway/gateways` returned `[]`. A gateway named `queenos` does **not** exist. | REST list. | Needed before any LLM call: create gateway `queenos` (authenticated, BYOK Anthropic key in provider keys) and set the `CF_AIG_TOKEN` secret. This was not created and no LLM was called. Item 6 of the runbook is still open. |

## `cf.artifacts.repo.pushed` payload (captured, SHAs real, repo deleted)

```json
{
  "id": "b8052a37-3d34-484c-8b71-b58dc507dd80",
  "type": "cf.artifacts.repo.pushed",
  "source": { "namespace": "queenos", "repoName": "queenos-day1-hive" },
  "payload": {
    "ref": "refs/heads/main",
    "before": "0000000000000000000000000000000000000000",
    "after": "ec4a513fe9b9501c5a45c41b2325df9da450cab4",
    "commits": [{
      "id": "ec4a513fe9b9501c5a45c41b2325df9da450cab4",
      "message": "initial", "messageTruncated": false,
      "timestamp": "2026-09-21T14:13:20.000Z",
      "author": { "name": "QueenOS Drone", "email": "drone@queenos.dev" },
      "committer": { "name": "QueenOS Drone", "email": "drone@queenos.dev" },
      "parents": []
    }],
    "totalCommitsCount": 1,
    "commitsTruncated": false
  }
}
```

The same shape arrives as `WorkflowEvent.payload`, alongside `timestamp`, `instanceId` and `workflowName`. A notes push has `ref:"refs/notes/queen"`, `before` all zeros, `commits:[]` and `totalCommitsCount:0`.

## Other observations

- The first requests to a freshly deployed workers.dev Worker returned `error code: 1042` for about 10 s. Retry.
- Hive-kit's `GitRepo` worked unchanged against Artifacts (init, commit, push, clone `depth:1`, notes push). A 12 MB random blob push took 8.7 s.
- `wrangler delete` of a Worker does **not** delete its Workflows; they had to be removed via `DELETE /accounts/{id}/workflows/{name}`. The Provisioner's teardown needs this for any per-train Workflow.
- Account-owned token verification: `/accounts/{id}/tokens/verify` works; the token covers Workers, Artifacts (via binding), Vectorize, Workflows and AI Gateway read.
- Not verified: Access, custom domains, containers, tail Workers, gradual deployments (deploy-discovery §(d) items 1-8 and 10-11); the preview API; the AI Gateway BYOK call (no gateway exists).

## Account needs before go-live

- AI Gateway `queenos` (not present). The Access app and DNS records were not created.
- Artifacts namespace `queenos` exists (created by the binding; kept).
