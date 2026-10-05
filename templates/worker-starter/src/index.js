// QueenOS worker-starter: a dependency-free router. No build step: every
// src/**/*.js file is uploaded as an ES module, so imports must be relative.
import { features } from "./features/index.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      // Feature guards run on every request (auth, flags, rate limits, ...).
      for (const feature of features) {
        if (typeof feature.guard === "function") await feature.guard(request);
      }

      if (url.pathname === "/" || url.pathname === "") {
        return json({ ok: true, app: "worker-starter", features: features.map((f) => f.slug) });
      }
      if (url.pathname === "/health") return json({ ok: true });

      // A feature may own a top-level route: export const path = "/status".
      const routed = features.find((f) => typeof f.path === "string" && f.path === url.pathname);
      if (routed) return await routed.handle(request);

      const match = /^\/features\/([a-z0-9-]+)\/?$/.exec(url.pathname);
      if (match) {
        const feature = features.find((f) => f.slug === match[1]);
        if (feature) return await feature.handle(request);
      }
      return json({ ok: false, error: "not found", path: url.pathname }, 404);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
};
