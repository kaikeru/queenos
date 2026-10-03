/**
 * queenos-genesis: the new-project onboarding backend. Reached only through the
 * edge Worker (never publicly); see app.ts. The Provisioner reports back over
 * the GENESIS DO binding (GenesisNode.reportHiveCreated).
 */
import { env } from "cloudflare:workers";
import { createApp } from "./app";

export { GenesisNode } from "./node";

const app = createApp(() => env);

export default {
  fetch: (req: Request) => app.fetch(req),
} satisfies ExportedHandler<Env>;
