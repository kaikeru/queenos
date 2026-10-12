import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 20_000 },
  plugins: [
    cloudflareTest({
      // ARTIFACTS only exists remotely; never open a remote proxy session.
      remoteBindings: false,
      // The "test" env has the two own DOs only; test/worker.ts swaps in fake Queen / Registry / Artifacts ports.
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      main: "./test/worker.ts",
      miniflare: {
        // The pool bundles an older workerd than compatibility_date 2026-10-02; clamp (as apps/drones does).
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
});
