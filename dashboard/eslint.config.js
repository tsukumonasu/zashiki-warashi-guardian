import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Globals that the pure simulation engine must never touch (Requirement 5.1).
// Time and randomness are passed in; there is no DOM, timer or network access.
const forbiddenGlobals = [
  "window",
  "document",
  "fetch",
  "setTimeout",
  "setInterval",
  "Date",
  "performance",
  "localStorage",
].map((name) => ({
  name,
  message: `src/simulation is pure: do not use ${name}. Pass time and randomness in.`,
}));

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "**/*.js", "!eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/simulation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message: "src/simulation must not import React.",
            },
            {
              group: [
                "**/lib",
                "**/lib/**",
                "**/hooks",
                "**/hooks/**",
                "**/components",
                "**/components/**",
                "src/lib",
                "src/lib/**",
                "src/hooks",
                "src/hooks/**",
                "src/components",
                "src/components/**",
              ],
              message: "src/simulation must not import from src/lib, src/hooks or src/components.",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", ...forbiddenGlobals],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "src/simulation is pure: use the seeded rng in rng.ts.",
        },
      ],
    },
  },
);
