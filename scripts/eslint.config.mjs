export default [
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores: ["node_modules/**", "coverage/**"],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-constant-binary-expression": "error",
      "no-debugger": "error",
      "no-dupe-keys": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unreachable": "error",
      "valid-typeof": "error",
    },
  },
];
