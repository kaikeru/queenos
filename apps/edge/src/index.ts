/**
 * queenos-edge: the single public front door (queenos.kaikeru.com, behind
 * Cloudflare Access). Verifies the Access JWT, hosts the project registry,
 * serves the dashboard, and forwards to Vault, Genesis and the Queen.
 */
import { createApp, type Bindings } from "./app";

export { HiveRegistry } from "./registry";

const app = createApp();

export default {
  fetch: (req, env, ctx) => app.fetch(req, env as unknown as Bindings, ctx),
} satisfies ExportedHandler<Env>;
