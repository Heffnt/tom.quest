import path from "path";
import { defineConfig } from "vitest/config";

// A TEST READS NO STATE OF THE MACHINE IT RUNS ON (docs/tests.md, "No test
// reads the box's state"). Every test process starts from the shell's
// environment, and on the box that environment says where it is: the box's
// .bashrc exports RUN_HOST=box, so a test that spawned the launcher or the
// session-start hook took the box's branch there and the laptop's branch
// everywhere else. The variables below are the ones that name the machine or
// one of its files, pointed at a directory that does not exist in this
// repository, so the code under test finds no env file, no WikiTom checkout
// and no git configuration of this machine's, the same on the box, on the
// laptop and on CI. A test that wants one of them sets its own.
const NO_MACHINE = path.resolve(__dirname, "test", "fixtures", "no-machine");
const WITHOUT_THE_MACHINE = {
  // worker/runs/config.mjs: the host, and the env file it reads the host,
  // the Convex keys and the state directory from when the variable is unset.
  RUN_HOST: "",
  RUN_ENV_FILE: path.join(NO_MACHINE, "worker.env"),
  // A suite started inside a box run inherits that run's slot on the
  // semaphore, and every semaphore case would pass for the wrong reason.
  TTS_RUN_SLOT_HELD: "",
  // The WikiTom checkout, whose tts/graph.json version the launcher stamps
  // on every run record and whose HEAD scripts/codex-run.mjs reads.
  WIKITOM_DIR: path.join(NO_MACHINE, "WikiTom"),
  // Git's own configuration: ~/.gitconfig, ~/.config/git/{config,ignore,
  // attributes} and /etc/gitconfig. A test that commits names its own author.
  GIT_CONFIG_GLOBAL: path.join(NO_MACHINE, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: path.join(NO_MACHINE, "config"),
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
