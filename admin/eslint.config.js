import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  { ignores: ["dist/"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "eqeqeq": ["error", "always", { null: "ignore" }],
      // The standard "load, then setState" effect is intentional here; the
      // plugin's newer experimental checks flag it as a cascading render.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  { files: ["vite.config.js"], languageOptions: { globals: globals.node } },
];
