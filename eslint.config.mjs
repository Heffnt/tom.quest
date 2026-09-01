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
  // A leading underscore means "bound deliberately, never read" — the shape a
  // destructure-with-rest needs when its whole purpose is to DROP names: see
  // worker/session-host/session.mjs, which peels the worker's secrets off an
  // env object so the rest can go to a child process. The name is written to
  // be unused, so a warning about it is noise that hides real findings.
  //
  // This block carries no `files` key, so it applies to every linted file —
  // both the .ts/.tsx that eslint-config-next's TypeScript preset governs and
  // the plain .mjs under worker/. Only the @typescript-eslint rule is set
  // because that preset is what reports these names today; the base
  // `no-unused-vars` is off repo-wide under that preset, so setting it too
  // would turn on a second, duplicate report of every name.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
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
