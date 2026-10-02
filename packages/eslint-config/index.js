import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Base flat config shared by all QueenOS packages. */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**", ".turbo/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
