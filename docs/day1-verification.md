# Day-1 verification runbook

Run this once with real Cloudflare credentials (Workers Paid, Artifacts enabled) to resolve the items marked UNVERIFIED in [discovery.md](discovery.md). For each: run the command, then record the result in the table at the bottom. Artifacts billing begins 2026-10-14, so do this before then.

Prereqs: wrangler 4.145+, `export CF_ACCOUNT_ID=<id>`, `export CF_API_TOKEN=<token with Artifacts + Workers edit>`, Node 22+. Use a scratch hive name: `export HIVE=verify-$(date +%s)`.

The Artifacts binding is only reachable from a Worker, so most checks run through a throwaway Worker (`scratch/`, outside this repo):

```bash
mkdir -p /tmp/qos-scratch && cd /tmp/qos-scratch
cat > wrangler.jsonc <<'JSON'
{ "name": "qos-scratch", "main": "index.ts", "compatibility_date": "2026-10-02",
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "queenos", "remote": true }] }
JSON
```

Each probe below is a branch of `index.ts` selected by `?probe=<name>`; run `wrangler dev` (remote bindings) and `curl "localhost:8787/?probe=<name>"`, or `wrangler deploy` and curl the workers.dev URL.

## 1. Artifacts accepts a push of `refs/notes/queen`

Probe `notes`: create a repo, push a commit to `main`, then push a note ref.

```ts
import git from "isomorphic-git"; import http from "isomorphic-git/http/web";
import { createFs } from "@queenos/hive-kit"; // or any memfs
// 1. const r = await env.ARTIFACTS.create(HIVE); const remote = r.remote; const token = r.token;
// 2. clone/commit/push main (use packages/hive-kit/src/git.ts helpers).
// 3. git.addNote({ fs, dir, ref: "refs/notes/queen", oid: <commitSha>, note: JSON.stringify({test:1}), author });
// 4. await git.push({ fs, http, dir, url: remote, remote: "origin", ref: "refs/notes/queen",
//      remoteRef: "refs/notes/queen", onAuth: () => ({ username: "x", password: token }) });
```

Independent check from a shell (any git client):

```bash
git clone https://x:$TOKEN@<remote-host>/<repo>.git t && cd t
git notes --ref=queen add -m '{"test":1}' HEAD
git push origin refs/notes/queen:refs/notes/queen
git ls-remote origin 'refs/notes/*'
```

Record: push accepted or the exact error text; whether `ls-remote` lists `refs/notes/queen`. If refused, the ledger falls back to `.queen/ledger/<sha>.json` (already implemented in hive-kit); record that the fallback is the default.

## 2. `fork()` latency, cost, zero-copy

Probe `fork`: time 5 forks of the same repo and delete them.

```ts
const base = await env.ARTIFACTS.get(HIVE);
const times: number[] = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now(); const f = await base.fork(`${HIVE}-f${i}`); times.push(Date.now() - t0);
  console.log(await (await env.ARTIFACTS.get(`${HIVE}-f${i}`)).info());   // objects/size fields
}
// chained: fork the fork. Then delete all: await env.ARTIFACTS.delete(name)
```

For zero-copy, compare `info()` size/object counts of base vs fork, then check the account's Artifacts storage and operation counts before and after (dashboard > Artifacts, or `curl -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/artifacts/...` **(endpoint unverified; use the dashboard if it 404s)**).

Record: median and p95 fork ms (plain and chained), whether fork storage counts against quota, ops billed per fork/delete.

## 3. Actual `cf.artifacts.repo.pushed` payload

Deploy a Worker with a Workflow that logs its payload, subscribed to the event (use the same `triggers.events` shape as gatekeepers):

```jsonc
{ "workflows": [{ "name": "probe-wf", "binding": "PROBE", "class_name": "Probe" }],
  "triggers": { "events": [{ "source": "artifacts", "type": "cf.artifacts.repo.pushed",
     "targets": [{ "type": "workflow", "workflow_name": "probe-wf" }] }] } }  // shape per discovery.md section 1; adjust to the wrangler error
```

```ts
export class Probe extends WorkflowEntrypoint { async run(ev, step) { await step.do("log", async () => console.log(JSON.stringify(ev))); } }
```

```bash
wrangler deploy && wrangler tail qos-scratch --format json &
# push a commit to a repo (probe 1), then:
wrangler workflows instances list probe-wf && wrangler workflows instances describe probe-wf latest
```

Record: the full JSON payload (paste it into `apps/gatekeepers` fixtures); field names for repo name, ref, before/after SHA; whether pushes to forks and to non-default refs (notes) also fire; delivery delay; whether `filter.repo_name` supports prefix/glob (needed for `<hive>-train-*`).

## 4. Cross-script DO RPC from Workflows

Deploy `apps/queen` (needs `QUEEN_INTERNAL_TOKEN` secret to exist only for HTTP), then drones, then call through the real path:

```bash
wrangler deploy --env="" --cwd apps/queen && wrangler deploy --env="" --cwd apps/drones
curl -s -X POST https://queen.<sub>.workers.dev/hives/$HIVE/prompts -H 'content-type: application/json' \
  -d "{\"namespace\":\"$HIVE\",\"promptText\":\"add a hello.txt\"}"
wrangler tail queenos-drones --format json    # look for RPC errors on env.QUEEN
curl -s https://queen.<sub>.workers.dev/hives/$HIVE/snapshot | jq '.promptRuns,.trains'
```

Also record the deploy order question: does `wrangler deploy` of `queen` succeed before `queenos-drones` exists, and vice versa?

Record: whether the Workflow step reached the Queen's `reportBuildResult`/`appendAudit` over RPC (snapshot shows the train advancing to TESTING with a `headSha`); any `Could not resolve service`/binding errors; whether RPC errors keep the `CODE: detail` prefix; deploy order that works.

## 5. `info().remote` format

Probe `info`:

```ts
const repo = await env.ARTIFACTS.get(HIVE);
console.log(JSON.stringify(await repo.info(), null, 2));
const { remote, token } = await env.ARTIFACTS.create(`${HIVE}-b`);   // creation result
```

Record: exact `remote` string (scheme, host, path, `.git` suffix?); whether a token is embedded or must come separately via `createToken()`; token TTL/scopes; the `username` isomorphic-git needs in `onAuth`. Compare with what `packages/hive-kit/src/git.ts` and `apps/drones` assume and fix any mismatch.

## 6. AI Gateway via the Workers AI binding

No tokens. Deploy a throwaway Worker with an `ai` binding that calls
`env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [...] }, { gateway: { id: "queenos" } })`, curl it, then check
`GET /accounts/$CF_ACCOUNT_ID/ai-gateway/gateways/queenos/logs?per_page=5` for the request. Delete the Worker afterwards.
Optionally store the Anthropic key in the dashboard (AI Gateway > `queenos` > Provider Keys, alias `default`); otherwise third-party models bill Unified Billing credits.

Record: the raw output shape for `@cf/...` and for `anthropic/...` (`choices[0].message.content` vs `response`); that the request shows in the gateway logs; whether `claude-opus-5-5` rejects `temperature` (drones omit it). Then run a drone in live mode (`DRONE_LLM_MODE=live`) once end to end.

## Results

| # | Item | Result | Date | Notes / follow-up |
|---|---|---|---|---|
| 1 | Notes push to `refs/notes/queen` | | | |
| 2 | Fork latency (median / p95), zero-copy, billing | | | |
| 3 | `repo.pushed` payload + filter syntax | | | |
| 4 | Cross-script DO RPC + deploy order | | | |
| 5 | `info().remote` format | | | |
| 6 | AI Gateway BYOK, `cf-aig-authorization` only | | | |
