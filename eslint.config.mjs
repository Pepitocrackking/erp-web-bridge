import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "packages/erp-agent/**",
      "infra/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  {
    // El service worker de la PWA corre en el navegador, no en Node: globales de worker.
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // Configs de herramientas en CommonJS (jest.config.js): require() es legitimo.
    files: ["**/*.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  prettier,
);
