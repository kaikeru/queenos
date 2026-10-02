/**
 * queenos-gatekeepers: hosts the GatekeeperWorkflow, started by Artifacts'
 * `cf.artifacts.repo.pushed` event trigger (wrangler `triggers.events`).
 * There is no push HTTP route: events are not delivered over HTTP.
 */
import { Hono } from "hono";
import { readConfig } from "./config";

export { GatekeeperWorkflow } from "./workflow";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  try {
    const cfg = readConfig(c.env);
    return c.json({ ok: true, service: "gatekeepers", testMode: cfg.testMode, scribeMode: cfg.scribeMode });
  } catch (e) {
    return c.json({ ok: false, service: "gatekeepers", error: (e as Error).message }, 500);
  }
});

export default app;
