import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The first request in a file pays workerd + module cold start; under a full
  // parallel `turbo run test` that alone can exceed vitest's 5 s default.
  test: { testTimeout: 20_000 },
  plugins: [
    cloudflareTest({
      // Never open a remote proxy session (needs Cloudflare credentials).
      remoteBindings: false,
      // The "test" env omits the cross-script Workflows (DRONES, PROVISIONER,
      // HERALD): the pool has no dev registry to reach another script. Tests
      // inject recording dispatchers via test/worker.ts.
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
