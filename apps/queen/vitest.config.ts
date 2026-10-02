import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The ARTIFACTS binding only exists remotely; never open a remote proxy
      // session (needs Cloudflare credentials) when running tests.
      remoteBindings: false,
      // The "test" env omits the cross-script DRONES Workflow: the pool has no
      // dev registry to reach another script. Tests inject a recording
      // DroneDispatcher (and a fake ForkProvisioner) via test/worker.ts.
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      main: "./test/worker.ts",
      miniflare: {
        // The pool bundles an older workerd than wrangler's compatibility_date
        // (2026-10-02); clamp to the newest date the bundled binary supports.
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
});
