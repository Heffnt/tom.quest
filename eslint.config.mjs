import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next, made path-agnostic with a leading
    // `**/` so nested copies (e.g. inside a stale .claude worktree) are ignored
    // too — an unanchored `.next/**` only matches the top-level dir, so ESLint
    // would otherwise scan build artifacts under nested gitignored worktrees.
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    "**/convex/_generated/**",
    // Stale local git worktrees are gitignored dev artifacts — never lint them.
    ".claude/**",
  ]),
]);

export default eslintConfig;
