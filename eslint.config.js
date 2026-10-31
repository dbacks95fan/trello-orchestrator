// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: ESLint flat config: the recommended JavaScript and typescript-eslint rule sets.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", setTimeout: "readonly", URL: "readonly" },
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly" } },
    // CommonJS test fixtures can only load modules with require(); the rule targets TypeScript/ESM sources.
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      // Leading underscores mark values intentionally discarded during destructuring.
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
);
