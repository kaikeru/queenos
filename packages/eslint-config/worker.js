import tseslint from "typescript-eslint";
import base from "./index.js";

const banned = ["fs", "crypto", "path", "child_process"];

/** Config for Cloudflare Worker packages: no Node built-ins (edge-compatible only). */
export default tseslint.config(...base, {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: banned.map((name) => ({
          name,
          message: `Node built-in "${name}" is not available in Workers V8 isolates. Use Web APIs instead.`,
        })),
        patterns: [
          {
            group: ["node:*", ...banned.map((n) => `${n}/*`)],
            message: "Node built-ins are not edge-compatible. Use Web APIs instead.",
          },
        ],
      },
    ],
  },
});
