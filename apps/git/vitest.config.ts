import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // ARTIFACTS only exists remotely; never open a remote proxy session.
      remoteBindings: false,
      // The "test" env has vars only: no ARTIFACTS and no cross-script QUEEN DO (no dev registry in
      // the pool). Tests call handleGit() with a fake Artifacts binding, a fake Queen and a fake
      // upstream fetch (test/fakes.ts).
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      main: "./src/index.ts",
      miniflare: {
        // The pool bundles an older workerd than compatibility_date 2026-10-02;
        // clamp to the newest date the bundled binary supports (as apps/queen does).
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
});
