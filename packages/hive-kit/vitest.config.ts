import { defineConfig } from "vitest/config";

// Plain Node: isomorphic-git + MemFS need no Workers runtime, and the code under
// test imports no Node built-ins (the Workers-specific bits are exercised in
// apps/drones under vitest-pool-workers).
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
