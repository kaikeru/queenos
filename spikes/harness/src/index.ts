/**
 * queenos-day1-harness: throwaway spike Worker (see docs/harness-spike.md).
 *   POST /run    { harness: "loop" | "think", model, task?, maxTurns? }
 *   GET  /tree   load the demo repo tree (read-only) and verify it as-is
 *   GET  /bundle worker-bundler probe (hono)
 * Every route needs `x-spike-key: <SPIKE_KEY>`.
 */
import { loadRepoTree } from "./repo";
import { runToolLoop } from "./loop";
import { verifyWorker } from "./verify";
import { changedFiles } from "./diff";

export { SpikeThink } from "./think-agent";

const DEFAULT_TASK = "Change our status page at / from JSON to a nice HTML page that is easy for a human to read; keep /health returning JSON";
const REPO = "demo";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-spike-key") !== env.SPIKE_KEY) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/tree") {
        const tree = await loadRepoTree(env.ARTIFACTS, REPO);
        const v = await verifyWorker(env.LOADER, tree.files);
        return Response.json({ head: tree.head, loadMs: tree.ms, files: Object.keys(tree.files), sizes: Object.fromEntries(Object.entries(tree.files).map(([p, c]) => [p, c.length])), verify: v, index: tree.files["src/index.js"] });
      }
      if (url.pathname === "/bundle") {
        const { probeBundler } = await import("./bundle-probe");
        return Response.json(await probeBundler(env));
      }
      if (url.pathname === "/run" && request.method === "POST") {
        const body = (await request.json()) as { harness?: string; model?: string; task?: string; maxTurns?: number; skipCache?: boolean; legacyRules?: boolean };
        const model = body.model ?? "@cf/moonshotai/kimi-k2.7-code";
        const task = body.task ?? DEFAULT_TASK;
        const t0 = Date.now();
        const tree = await loadRepoTree(env.ARTIFACTS, REPO);
        let out: Record<string, unknown>;
        let files: Record<string, string>;
        if (body.harness === "think") {
          const stub = env.SPIKE_THINK.get(env.SPIKE_THINK.idFromName(`run-${crypto.randomUUID()}`));
          const r = (await stub.runTask({ model, files: tree.files, task, skipCache: body.skipCache })) as unknown as { files: Record<string, string> } & Record<string, unknown>;
          files = r.files;
          out = { ...r, files: undefined };
        } else {
          const r = await runToolLoop({ env, model, task, base: tree.files, maxTurns: body.maxTurns, skipCache: body.skipCache, legacyRules: body.legacyRules });
          files = r.files;
          out = { ...r, files: undefined };
        }
        const finalVerify = await verifyWorker(env.LOADER, files);
        return Response.json({
          harness: (body.harness ?? "loop") + (body.legacyRules ? "+legacyRules" : ""),
          model,
          head: tree.head,
          cloneMs: tree.ms,
          totalMs: Date.now() - t0,
          changed: changedFiles(tree.files, files),
          finalVerify,
          ...out,
        });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String((e as Error)?.stack ?? e).slice(0, 2000) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
