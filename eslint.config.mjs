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
      // A leading underscore is this repo's declaration that a binding is
      // deliberately discarded, and the rule honors it everywhere a name can
      // be bound: variables, function parameters, and caught errors. The
      // motivating case is the secret scrub in worker/session-host/session.mjs,
      // which strips SESSIONS_WORKER_KEY, GH_TOKEN, TTS_WORKER_KEY,
      // TOMQUEST_AGENT_USERNAME, TOMQUEST_AGENT_PASSWORD and TURING_API_KEY
      // out of a child process env by destructuring them into names it never
      // reads. Those bindings are the point, not an oversight.
      //
      // eslint-config-next sets this rule to "warn" with no options, so this
      // entry is the whole option object; typescript-eslint fills the rest
      // (args: "after-used", caughtErrors: "all", vars: "all") from its own
      // defaults. Keep the three patterns identical — an underscore that means
      // "discarded" in one binding position and not another is worse than no
      // convention.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
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
