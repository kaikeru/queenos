import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Never open a remote proxy session (needs Cloudflare credentials).
      remoteBindings: false,
      // The "test" env has the VaultNode DO and a fixed test KEK. test/worker.ts
      // swaps in a fake Cloudflare API fetch through VaultNode.cloudflareFetch().
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
