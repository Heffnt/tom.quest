import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    clearMocks: true,
    // ".claude/**" keeps agent worktrees (.claude/worktrees/*/) — which contain
    // full repo copies incl. Playwright e2e specs — from being collected here.
    // Two other files fence this same path, in two other syntaxes: the
    // `globalIgnores` list in eslint.config.mjs, and SKIP_DIR (a set of
    // basenames) in scripts/check-session-mirrors.mjs. A change here belongs in
    // all three.
    exclude: ["e2e/**", "**/e2e/**", "node_modules/**", ".next/**", ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
