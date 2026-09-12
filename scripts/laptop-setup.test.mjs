import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/laptop-setup.mjs");

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function run({ home, wikiTom, tomQuest }) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      WIKITOM_DIR: wikiTom,
      TOM_QUEST_DIR: tomQuest,
      TTS_SKIP_RUNS_TASK: "1",
      // The skills half of setup writes to `$CLAUDE_CONFIG_DIR/skills` when
      // that is set and to `$TTS_SKILLS_DIRS` when THAT is. Both are cleared
      // here, and HOME is the fake one above, so a test cannot reach the real
      // laptop's skills directory however this machine happens to be set up.
      CLAUDE_CONFIG_DIR: "",
      TTS_SKILLS_DIRS: "",
      CMT_DIR: "",
    },
  });
}

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

/** A WikiTom the catalog can be published out of. The `### Repos` block is
 * where a `repo-` skill's description comes from, and AGENTS.md is its body. */
function wikiTomFixture(dir) {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(path.join(dir, "AGENTS.md"), "# WikiTom\n\nThe vault.\n");
  write(
    path.join(dir, "model-of-tom", "agent-rules.md"),
    "# Agent rules\n\n## Map\n\n### Repos\n- WikiTom: the vault.\n\n## How you work\n\n- Read this.\n",
  );
  write(path.join(dir, "model-of-tom", "writing.md"), "# Writing\n\n## Sentences\n\nUse short sentences.\n");
  write(path.join(dir, "model-of-tom", "intent.md"), "# Intent\n\n## Directions\n\n- Ship.\n");
  write(path.join(dir, "model-of-tom", "priorities.md"), "# Priorities\n\n## What becomes a todo\n\n- Dated things.\n");
  write(path.join(dir, "model-of-tom", "schedule.md"), "# Schedule\n\n## Week\n\n- Monday — practice.\n");
  write(
    path.join(dir, "model-of-tom", "areas", "admin.md"),
    "---\ncategories: [admin, email]\nupdated: 2026-09-09\n---\n\n## Current state\n\n- Present.\n",
  );
  execFileSync("git", ["-C", dir, ...IDENTITY, "add", "-A"]);
  execFileSync("git", ["-C", dir, ...IDENTITY, "commit", "-q", "-m", "fixture"]);
  return dir;
}

function claudeRulesImport(wikiTom) {
  return `@${path.join(wikiTom, "model-of-tom", "agent-rules.md").replaceAll("\\", "/")}`;
}

describe("laptop setup", () => {
  it("installs its imports and hooks without disturbing local configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-"));
    const home = path.join(root, "home");
    const wikiTom = path.join(root, "WikiTom");
    const tomQuest = path.join(root, "tom.quest");
    const claudeDir = path.join(home, ".claude");
    const codexDir = path.join(home, ".codex");
    const rulesImport = claudeRulesImport(wikiTom);
    const command = `node ${path.join(tomQuest, "scripts", "session-start-hook.mjs")}`;
    const instructionsLoadedCommand = `node ${path.join(tomQuest, "scripts", "instructions-loaded-hook.mjs")}`;
    const runHookCommand = `node ${path.join(tomQuest, "scripts", "run-hook.mjs")}`;

    write(path.join(claudeDir, "CLAUDE.md"), "@C:/old/WikiTom/model-of-tom/agent-rules.md\n\n# Laptop notes\n");
    write(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        model: "local-model",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo protect" }] }],
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: "echo local" }] },
            { matcher: "startup", hooks: [{ type: "command", command: "cat C:/Users/heffn/Desktop/WikiTom/AGENTS.md" }] },
            { matcher: "resume", hooks: [{ type: "command", command: "node C:/stale/worktree/scripts/session-start-hook.mjs" }] },
          ],
          SessionEnd: [{ hooks: [{ type: "command", command: "node C:/stale/worktree/scripts/run-hook.mjs" }] }],
        },
      }, null, 2),
    );
    write(
      path.join(codexDir, "hooks.json"),
      JSON.stringify({
        topLevel: { retained: true },
        hooks: {
          SessionStart: [
            { matcher: "resume", hooks: [{ type: "command", command: "echo codex local" }] },
            { matcher: "startup", hooks: [{ type: "command", command: "cat /root/WikiTom/AGENTS.md" }] },
          ],
        },
      }, null, 2),
    );
    const configToml = path.join(codexDir, "config.toml");
    write(configToml, 'model = "local"\n');

    const first = run({ home, wikiTom, tomQuest });
    expect(first.status).toBe(0);
    expect(fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8")).toBe(`${rulesImport}\n\n# Laptop notes\n`);

    const managed = { matcher: "startup|resume|compact", hooks: [{ type: "command", command }] };
    const managedInstructionsLoaded = {
      matcher: "session_start|include|nested_traversal|path_glob_match|compact",
      hooks: [{ type: "command", command: instructionsLoadedCommand, timeout: 5 }],
    };
    const runEntry = (event) => ({
      ...(event === "SessionStart" ? { matcher: "startup|resume|compact" } : {}),
      hooks: [{ type: "command", command: runHookCommand, timeout: 5 }],
    });
    const expectedClaudeSettings = {
      model: "local-model",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo protect" }] }],
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "echo local" }] },
          managed,
          runEntry("SessionStart"),
        ],
        SessionEnd: [runEntry("SessionEnd")],
        InstructionsLoaded: [managedInstructionsLoaded],
        SubagentStart: [runEntry("SubagentStart")],
        Stop: [runEntry("Stop")],
        SubagentStop: [runEntry("SubagentStop")],
      },
    };
    expect(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")).toBe(
      `${JSON.stringify(expectedClaudeSettings, null, 2)}\n`,
    );
    const expectedCodexHooks = {
      topLevel: { retained: true },
      hooks: {
        SessionStart: [
          { matcher: "resume", hooks: [{ type: "command", command: "echo codex local" }] },
          managed,
          runEntry("SessionStart"),
        ],
        SubagentStart: [runEntry("SubagentStart")],
        Stop: [runEntry("Stop")],
        SessionEnd: [runEntry("SessionEnd")],
        SubagentStop: [runEntry("SubagentStop")],
      },
    };
    expect(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8")).toBe(
      `${JSON.stringify(expectedCodexHooks, null, 2)}\n`,
    );
    expect(fs.readFileSync(configToml, "utf8")).toBe('model = "local"\n');

    const beforeSecondRun = [
      fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8"),
      fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"),
      fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"),
      fs.readFileSync(configToml, "utf8"),
    ];
    const second = run({ home, wikiTom, tomQuest });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect([
      fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8"),
      fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"),
      fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"),
      fs.readFileSync(configToml, "utf8"),
    ]).toEqual(beforeSecondRun);
  });

  it("prefixes a laptop CLAUDE.md that has no import", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-prefix-"));
    const home = path.join(root, "home");
    const wikiTom = path.join(root, "WikiTom");
    const tomQuest = path.join(root, "tom.quest");
    write(path.join(home, ".claude", "CLAUDE.md"), "# Laptop notes\n");

    expect(run({ home, wikiTom, tomQuest }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
      `${claudeRulesImport(wikiTom)}\n\n# Laptop notes\n`,
    );
  });

  it("preserves CRLF when replacing the existing rules import", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-crlf-"));
    const home = path.join(root, "home");
    const wikiTom = path.join(root, "WikiTom");
    const tomQuest = path.join(root, "tom.quest");
    write(
      path.join(home, ".claude", "CLAUDE.md"),
      "@C:/old/WikiTom/model-of-tom/agent-rules.md\r\n\r\n# Laptop notes\r\n",
    );

    expect(run({ home, wikiTom, tomQuest }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
      `${claudeRulesImport(wikiTom)}\r\n\r\n# Laptop notes\r\n`,
    );
  });

  it("keeps a different first-line import after the required rules import", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-other-import-"));
    const home = path.join(root, "home");
    const wikiTom = path.join(root, "WikiTom");
    const tomQuest = path.join(root, "tom.quest");
    write(path.join(home, ".claude", "CLAUDE.md"), "@C:/laptop/private-rules.md\n# Laptop notes\n");

    expect(run({ home, wikiTom, tomQuest }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
      `${claudeRulesImport(wikiTom)}\n\n@C:/laptop/private-rules.md\n# Laptop notes\n`,
    );
  });

  // The skills half of setup: the same publish the SessionStart hook runs on
  // every session, done once so the directories are there before the first one.
  it("installs both skills directories and leaves other skills alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-skills-"));
    const home = path.join(root, "home");
    const wikiTom = wikiTomFixture(path.join(root, "WikiTom"));
    // Not a checkout, so no repo but WikiTom's is published: A REPO DIRECTORY
    // THAT IS NOT A CHECKOUT IS SKIPPED, NOT AN ERROR.
    const tomQuest = path.join(root, "tom.quest");
    const claudeSkills = path.join(home, ".claude", "skills");
    const codexSkills = path.join(home, ".codex", "skills");
    // A skill of the laptop's own, sitting where Tom's are about to land.
    write(path.join(claudeSkills, "graphify", "SKILL.md"), "---\nname: graphify\n---\n\nNot Tom's.\n");

    const first = run({ home, wikiTom, tomQuest });
    expect(first.status).toBe(0);
    for (const dir of [claudeSkills, codexSkills]) {
      expect(fs.existsSync(path.join(dir, "tom-write", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "tom-know-admin", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "tom-repo-WikiTom", "SKILL.md"))).toBe(true);
      expect(first.stdout).toContain(`changed ${dir}`);
    }
    expect(fs.readFileSync(path.join(claudeSkills, "tom-write", "SKILL.md"), "utf8")).toContain("Use short sentences.");

    const second = run({ home, wikiTom, tomQuest });
    expect(second.status).toBe(0);
    for (const dir of [claudeSkills, codexSkills]) expect(second.stdout).toContain(`unchanged ${dir}`);
    // Nothing this build did not produce is touched, on either run.
    expect(fs.readFileSync(path.join(claudeSkills, "graphify", "SKILL.md"), "utf8")).toContain("Not Tom's.");
  });

  it("says so in one line when the skills cannot be published, and finishes setup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "laptop-setup-no-skills-"));
    const home = path.join(root, "home");
    // No WikiTom checkout at all — the case every other test above runs in.
    const wikiTom = path.join(root, "WikiTom");
    const tomQuest = path.join(root, "tom.quest");

    const result = run({ home, wikiTom, tomQuest });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("could not publish skills to");
    // And the hooks and the import — the part a laptop cannot work without —
    // are installed anyway.
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
      `${claudeRulesImport(wikiTom)}\n\n`,
    );
  });

  it("keeps the box account setup aligned with the installed hook", () => {
    const setup = fs.readFileSync(path.resolve("worker/setup.sh"), "utf8");
    const ttsLib = fs.readFileSync(path.resolve("worker/jobs/tts-lib.mjs"), "utf8");
    const runHook = fs.readFileSync(path.resolve("scripts/run-hook.mjs"), "utf8");
    const codexRun = fs.readFileSync(path.resolve("scripts/codex-run.mjs"), "utf8");
    expect(setup).toContain('cp "$WORKER_DIR"/../scripts/session-start-hook.mjs /opt/tts/scripts/session-start-hook.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/../scripts/run-hook.mjs /opt/tts/scripts/run-hook.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/../scripts/prelude.mjs /opt/tts/scripts/prelude.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/jobs/markdown-sections.mjs /opt/tts/worker/jobs/markdown-sections.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/runs/*.mjs /opt/tts/runs/');
    expect(setup).toContain('/root/.claude-accounts/wpi /root/.codex');
    expect(setup).toContain('const events = ["SessionStart", "SubagentStart", "Stop", "SessionEnd", "SubagentStop"]');
    expect(setup).toContain('/opt/tts/runs/sweep.mjs --full');
    expect(setup).toContain('/opt/tts/runs-compare.mjs');
    expect(ttsLib).toContain('new URL("./runs/registration.mjs", import.meta.url)');
    expect(runHook).toContain('new URL("../runs/registration.mjs", import.meta.url)');
    expect(codexRun).toContain('new URL("./runs/registration.mjs", import.meta.url)');
    expect(setup).toContain("@/root/wikitom/model-of-tom/agent-rules.md");
    expect(setup).toContain("node /opt/tts/scripts/session-start-hook.mjs");
    expect(setup).toContain("box session opener already carries all three layers");
  });
});
