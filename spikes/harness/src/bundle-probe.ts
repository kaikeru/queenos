/** worker-bundler probe: bundle a tiny Hono app (npm dep fetched from the registry inside the Worker), run it in a Dynamic Worker. */
import { createWorker } from "@cloudflare/worker-bundler";

export async function probeBundler(env: Env) {
  const t0 = Date.now();
  try {
    const built = await createWorker({
      files: {
        "src/index.js": `import { Hono } from "hono";\nconst app = new Hono();\napp.get("/", (c) => c.html("<h1>hi from hono</h1>"));\napp.get("/health", (c) => c.json({ ok: true }));\nexport default app;\n`,
        "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
      },
    });
    const bundleMs = Date.now() - t0;
    const sizes = Object.fromEntries(Object.entries(built.modules).map(([k, v]) => [k, typeof v === "string" ? v.length : JSON.stringify(v).length]));
    const w = env.LOADER.load({ compatibilityDate: "2026-10-02", mainModule: built.mainModule, modules: built.modules as never, globalOutbound: null });
    const s = Date.now();
    const r1 = await w.getEntrypoint().fetch("https://x.invalid/");
    const r2 = await w.getEntrypoint().fetch("https://x.invalid/health");
    return { ok: true, bundleMs, runMs: Date.now() - s, mainModule: built.mainModule, sizes, root: [r1.status, await r1.text()], health: [r2.status, await r2.text()] };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e as Error)?.stack ?? e).slice(0, 1500) };
  }
}
