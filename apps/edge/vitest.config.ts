import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      // The "test" env has only the HiveRegistry DO and vars. VAULT, GENESIS,
      // QUEEN and ASSETS are injected as fakes (app.request(..., env)).
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      main: "./src/index.ts",
      miniflare: {
        // The pool bundles an older workerd than compatibility_date 2026-10-02.
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
});
