/**
 * Behavioral verify: load the edited no-build Worker (every src/**\/*.js as an ES module) into a
 * Dynamic Worker via the Worker Loader binding, outbound network blocked, and fetch a few paths.
 */
export interface ProbeResult {
  path: string;
  status: number;
  contentType: string | null;
  bodyStart: string;
  ms: number;
}
export interface VerifyResult {
  ok: boolean;
  loadMs: number;
  probes: ProbeResult[];
  error?: string;
}

let counter = 0;

export async function verifyWorker(loader: WorkerLoader, files: Record<string, string>, paths = ["/", "/health"]): Promise<VerifyResult> {
  const t0 = Date.now();
  let deploy: { main?: string; compatibility_date?: string } = {};
  try {
    deploy = JSON.parse(files[".queen/deploy.json"] ?? "{}");
  } catch {}
  const main = deploy.main ?? "src/index.js";
  const modules: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) if (/^src\/.*\.js$/.test(p)) modules[p] = c;
  if (!modules[main]) return { ok: false, loadMs: 0, probes: [], error: `entry ${main} missing` };
  try {
    // load() (not get()) = fresh isolate per verify; no caching across edits.
    const worker = loader.load({
      compatibilityDate: deploy.compatibility_date ?? "2026-10-02",
      mainModule: main,
      modules,
      globalOutbound: null,
      limits: { cpuMs: 100 },
    });
    const ep = worker.getEntrypoint();
    const probes: ProbeResult[] = [];
    for (const path of paths) {
      const s = Date.now();
      const res = await ep.fetch(new Request(`https://preview.queenos.invalid${path}`, { headers: { accept: "text/html,application/json" } }));
      const body = await res.text();
      probes.push({ path, status: res.status, contentType: res.headers.get("content-type"), bodyStart: body.slice(0, 400), ms: Date.now() - s });
    }
    return { ok: probes.every((p) => p.status < 500), loadMs: Date.now() - t0, probes };
  } catch (e) {
    return { ok: false, loadMs: Date.now() - t0, probes: [], error: String((e as Error)?.message ?? e).slice(0, 500) };
  } finally {
    counter++;
  }
}
