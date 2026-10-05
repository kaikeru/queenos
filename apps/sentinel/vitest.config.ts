import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // No remote bindings; never open a remote proxy session.
      remoteBindings: false,
      // The "test" env has the Workflow but no
      // cross-script QUEEN DO (no dev registry in the pool). test/worker.ts
      // swaps in fake ports through SentinelWorkflow.createPorts().
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      main: "./test/worker.ts",
      miniflare: {
        // The pool bundles an older workerd than compatibility_date 2026-10-02;
        // clamp to the newest date the bundled binary supports (as apps/queen does).
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
});
