import path from "path";
import { defineConfig } from "vitest/config";

// THE SUITE READS NOTHING OUTSIDE THE REPOSITORY (docs/tests.md). Every test
// process starts from the shell's environment, so a variable that names one of
// the machine's files would make a test's answer depend on the machine. These
// point into a directory that does not exist in this repository, the same on
// the box, on the laptop and on CI; a test that wants one of them sets its own.
// REAL_WIKITOM_DIR is deliberately absent: it is the opt-in for the real-vault
// cases in shared/__tests__/skills.test.mjs, so it passes through from the
// shell, and it is unset on every ordinary run.
const NO_MACHINE = path.resolve(__dirname, "test", "fixtures", "no-machine");
const WITHOUT_THE_MACHINE = {
  // Git's own configuration: ~/.gitconfig, ~/.config/git/{config,ignore,
  // attributes} and /etc/gitconfig. The check-agents-md tests run real
  // git; a test that commits names its own author.
  GIT_CONFIG_GLOBAL: path.join(NO_MACHINE, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: path.join(NO_MACHINE, "config"),
  // The WikiTom checkout scripts/check-private-paths.mjs falls back to
  // /root/wikitom (or the laptop's path) when this is unset.
  WIKITOM_DIR: path.join(NO_MACHINE, "WikiTom"),
};

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    clearMocks: true,
    env: WITHOUT_THE_MACHINE,
    // ".claude/**" keeps agent worktrees (.claude/worktrees/*/) — which contain
    // full repo copies incl. Playwright e2e specs — from being collected here.
    exclude: ["e2e/**", "**/e2e/**", "node_modules/**", ".next/**", ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
