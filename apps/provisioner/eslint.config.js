import worker from "@queenos/eslint-config/worker";
// scripts/ run under Node at build time; templates.generated.ts is generated.
export default [{ ignores: ["scripts/**", "src/templates.generated.ts"] }, ...worker];
