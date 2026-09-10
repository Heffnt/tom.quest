import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/laptop-setup.mjs");

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function run({ home, wikiTom, tomQuest }) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, WIKITOM_DIR: wikiTom, TOM_QUEST_DIR: tomQuest },
  });
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
          ],
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
    const expectedClaudeSettings = {
      model: "local-model",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo protect" }] }],
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "echo local" }] },
          managed,
        ],
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
        ],
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

  it("keeps the box account setup aligned with the installed hook", () => {
    const setup = fs.readFileSync(path.resolve("worker/setup.sh"), "utf8");
    expect(setup).toContain('cp "$WORKER_DIR"/../scripts/session-start-hook.mjs /opt/tts/scripts/session-start-hook.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/../scripts/prelude.mjs /opt/tts/scripts/prelude.mjs');
    expect(setup).toContain('cp "$WORKER_DIR"/jobs/markdown-sections.mjs /opt/tts/worker/jobs/markdown-sections.mjs');
    expect(setup).toContain("@/root/wikitom/model-of-tom/agent-rules.md");
    expect(setup).toContain("node /opt/tts/scripts/session-start-hook.mjs");
    expect(setup).toContain("box session opener already carries all three layers");
  });
});
