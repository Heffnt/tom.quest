import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/temp.mjs";

import { renderGrants, skillDirName } from "../shared/skills.mjs";

const RUNNER = path.resolve("scripts/codex-run.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
const PUBLISHED_COMMIT = "e".repeat(40);

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function wikitomFixture({ rules = "# Rules\n\nKeep the promise.\n" } = {}) {
  const dir = tempDir("codex-run-wikitom-");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  if (rules !== null) write(dir, "model-of-tom/agent-rules.md", rules);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

function installedSkills(...names) {
  const home = tempDir("codex-run-skills-");
  for (const name of names) {
    write(home, path.join("skills", skillDirName(name), "SKILL.md"), "---\nname: fixture\n---\n");
    write(home, path.join("skills", skillDirName(name), ".tom-skill.json"), `${JSON.stringify({ commit: PUBLISHED_COMMIT })}\n`);
  }
  return home;
}

function fakeCodex() {
  const dir = tempDir("codex-run-fake-");
  const script = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'const output = process.argv[process.argv.indexOf("-o") + 1];',
    'fs.writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(process.argv.slice(2)));',
    'if (process.env.FAKE_CODEX_ENV) fs.writeFileSync(process.env.FAKE_CODEX_ENV, JSON.stringify({ openrouterKey: process.env.OPENROUTER_API_KEY ?? null }));',
    'fs.writeFileSync(output, "fake answer\\n");',
  ].join("\n"));
  if (process.platform === "win32") {
    const command = path.join(dir, "codex.cmd");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
    return command;
  }
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(script, `#!/usr/bin/env node\n${fs.readFileSync(script, "utf8")}`);
  return script;
}

function run(args, env) {
  const state = tempDir("codex-run-state-");
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    input: "answer this\n",
    env: { ...process.env, RUN_SWEEP_STATE_DIR: state, TTS_RUN_REG_SPOOL: path.join(state, "registration"), ...env },
  });
  result.state = state;
  return result;
}

function developerInstructions(argsFile) {
  const arg = JSON.parse(fs.readFileSync(argsFile, "utf8")).find((entry) => entry.startsWith("developer_instructions="));
  return JSON.parse(arg.slice("developer_instructions=".length));
}

function spooledEnvelope(state) {
  const dir = path.join(state, "registration");
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (names.length !== 1) throw new Error(`expected one spool file, found ${names.length}`);
  return { token: path.basename(names[0], ".json"), envelope: JSON.parse(fs.readFileSync(path.join(dir, names[0]), "utf8")) };
}

describe("codex-run operate instructions", () => {
  it("injects the exact committed operate file as a TOML string", () => {
    const rules = '# Rules\n\nSay "hello".\n';
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run([], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture({ rules }),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fake answer\n");
    const codexArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    const developer = codexArgs.find((arg) => arg.startsWith("developer_instructions="));
    expect(JSON.parse(developer.slice("developer_instructions=".length))).toMatch(
      new RegExp(`^${rules.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nTTS-RUN-TOKEN: [0-9a-f-]{36}$`),
    );
    expect(codexArgs).not.toContain("--ephemeral");
  });

  it("skips the read entirely with --no-operate", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--no-operate"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: path.join(os.tmpdir(), "no-wikitom-here"),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("operate instructions unavailable");
    const developer = JSON.parse(fs.readFileSync(argsFile, "utf8"))
      .find((arg) => arg.startsWith("developer_instructions="));
    expect(JSON.parse(developer.slice("developer_instructions=".length))).toMatch(/^TTS-RUN-TOKEN: [0-9a-f-]{36}$/);
  });

  it("continues after one unavailable-instructions warning", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run([], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: path.join(os.tmpdir(), "no-wikitom-here"),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("codex-run: operate instructions unavailable; continuing without them\n");
    expect(result.stderr.match(/operate instructions unavailable/g)).toHaveLength(1);
    const developer = JSON.parse(fs.readFileSync(argsFile, "utf8"))
      .find((arg) => arg.startsWith("developer_instructions="));
    expect(JSON.parse(developer.slice("developer_instructions=".length))).toMatch(/^TTS-RUN-TOKEN: [0-9a-f-]{36}$/);
    // An unreadable operate file is an absence, not a refusal.
    expect(spooledEnvelope(result.state).envelope.registration.layersDenied).toEqual([]);
  });
});

describe("codex-run registration", () => {
  it("spools the launcher's envelope under the token the run carries", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run([], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
      TTS_RUN_ORIGIN: "cron:audit",
      TTS_RUN_PARENT_RUN_ID: "claude:box:parent-session",
      RUN_HOST: "box",
    });
    expect(result.status).toBe(0);
    const { token, envelope } = spooledEnvelope(result.state);
    const developer = JSON.parse(fs.readFileSync(argsFile, "utf8"))
      .find((arg) => arg.startsWith("developer_instructions="));
    // The rollout names its own token, so the sweeper can bind the envelope
    // exactly even where `codex exec` fires no hooks.
    expect(JSON.parse(developer.slice("developer_instructions=".length))).toContain(`TTS-RUN-TOKEN: ${token}`);
    // The envelope version is registration.mjs's to state and its own tests'
    // to assert; this case is about what the LAUNCHER wrote into it.
    expect(envelope).toMatchObject({
      token,
      writer: { file: "scripts/codex-run.mjs", job: "audit" },
      registration: {
        host: "box",
        cli: "codex",
        origin: "cron:audit",
        kind: "codex-child",
        parentRunId: "claude:box:parent-session",
        layersKnown: true,
        layersGiven: ["operate"],
        layersDenied: [],
      },
    });
    // A child with a parent names no environment: it runs where its parent runs.
    expect(envelope.registration).not.toHaveProperty("environment");
    expect(envelope.registration.wikitomCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(envelope.registration.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records no skills when the spawner named none", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run([], { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture(), FAKE_CODEX_ARGS: argsFile });
    expect(result.status).toBe(0);
    // A mechanical Codex child gets the base and nothing else: no block at all.
    expect(developerInstructions(argsFile)).not.toContain("SKILLS (WikiTom commit");
    expect(spooledEnvelope(result.state).envelope.registration).toMatchObject({ skillsGranted: [], skillsRefused: [] });
  });

  it("records a job with no parent, and --no-operate as a denial", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--no-operate"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    const { envelope } = spooledEnvelope(result.state);
    expect(envelope.registration).toMatchObject({
      origin: "job",
      kind: "job",
      environment: "worker",
      layersKnown: true,
      layersGiven: [],
      layersDenied: ["operate"],
    });
    expect(envelope.registration.parentRunId).toBe(null);
  });

  it("takes a launcher's named environment over both defaults, and ignores a word that is not one", () => {
    const environmentWith = (env) => {
      const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
      const result = run([], { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture(), FAKE_CODEX_ARGS: argsFile, ...env });
      expect(result.status).toBe(0);
      return spooledEnvelope(result.state).envelope.registration.environment;
    };
    expect(environmentWith({ TTS_RUN_ENVIRONMENT: "runner" })).toBe("runner");
    expect(environmentWith({ TTS_RUN_ENVIRONMENT: "session", TTS_RUN_PARENT_RUN_ID: "claude:box:parent-session" })).toBe("session");
    expect(environmentWith({ TTS_RUN_ENVIRONMENT: "autonomous" })).toBe("worker");
  });
});

describe("codex-run skill grants", () => {
  it("puts the grant block between the operate text and the token line", () => {
    const rules = "# Rules\n\nKeep the promise.\n";
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const vault = wikitomFixture({ rules });
    const result = run(["--grant", "write", "--grant", "know-research"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: vault,
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: installedSkills("write", "know-research"),
    });
    expect(result.status).toBe(0);
    const developer = developerInstructions(argsFile);
    const { envelope } = spooledEnvelope(result.state);
    // The renderer is the one authority on the block's bytes; the wrapper's
    // job is only to put them in the right place.
    const block = renderGrants({
      commit: PUBLISHED_COMMIT,
      checkoutCommit: git(vault, "rev-parse", "HEAD").trim(),
      granted: ["write", "know-research"],
    });
    expect(developer).toContain(block);
    expect(developer.indexOf(rules)).toBeLessThan(developer.indexOf(block));
    expect(developer.indexOf(block)).toBeLessThan(developer.indexOf("TTS-RUN-TOKEN:"));
    // findCodexRegistration anchors on a whole line, so the token keeps one.
    expect(developer).toMatch(/\nTTS-RUN-TOKEN: [0-9a-f-]{36}$/);
    expect(envelope.registration.skillsGranted).toEqual(["write", "know-research"]);
    expect(envelope.registration.skillsRefused).toEqual([]);
    expect(envelope.registration.wikitomCommit).toBe(PUBLISHED_COMMIT);
  });

  it("carries a refusal and its reason into both the block and the record", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--refuse", "know-research=mechanical run, no planning"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain("refused: know-research — mechanical run, no planning");
    expect(spooledEnvelope(result.state).envelope.registration).toMatchObject({
      skillsGranted: [],
      skillsRefused: ["know-research — mechanical run, no planning"],
    });
  });

  it("records a normalized grant with the spelling rendered in the prompt", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--grant", "repo-tom.quest"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: installedSkills("repo-tom-quest"),
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain("granted: repo-tom-quest");
    expect(spooledEnvelope(result.state).envelope.registration.skillsGranted).toEqual(["repo-tom-quest"]);
  });

  it("refuses a named grant whose installed SKILL.md is missing", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--grant", "write", "--grant", "know-research"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: installedSkills("write"),
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain("granted: write");
    expect(developerInstructions(argsFile)).toContain("its installed SKILL.md is missing");
    const registration = spooledEnvelope(result.state).envelope.registration;
    expect(registration.skillsGranted).toEqual(["write"]);
    expect(registration.skillsRefused).toHaveLength(1);
    expect(registration.skillsRefused[0]).toContain("know-research");
    expect(registration.skillsRefused[0]).toContain("its installed SKILL.md is missing");
  });

  it("grants a published skill even when the checkout is unavailable", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const result = run(["--grant", "write"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: path.join(os.tmpdir(), "no-wikitom-here"),
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: installedSkills("write"),
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain(`SKILLS (WikiTom commit ${PUBLISHED_COMMIT})`);
    expect(developerInstructions(argsFile)).toContain("granted: write");
    expect(spooledEnvelope(result.state).envelope.registration).toMatchObject({
      skillsGranted: ["write"],
      skillsRefused: [],
      wikitomCommit: PUBLISHED_COMMIT,
    });
  });

  it("refuses a hand-written SKILL.md that has no published catalog metadata", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const home = tempDir("codex-run-skills-");
    write(home, path.join("skills", skillDirName("write"), "SKILL.md"), "---\nname: fixture\n---\n");
    const result = run(["--grant", "write"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: home,
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain("its published catalog metadata is missing or invalid");
    expect(spooledEnvelope(result.state).envelope.registration.skillsGranted).toEqual([]);
  });

  it("rejects a refusal with no reason", () => {
    const result = run(["--refuse", "write"], { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--refuse takes NAME=WHY");
  });

  it.each([
    [["--grant", "write", "--grant", "write"], "--grant names write more than once"],
    [["--refuse", "write=no need", "--refuse", "write=still no need"], "--refuse names write more than once"],
  ])("rejects duplicate skill decisions", (args, message) => {
    const result = run(args, { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it.each([
    [
      ["--grant", "repo-tom.quest", "--grant", "repo-tom-quest"],
      "--grant names repo-tom.quest and repo-tom-quest as the same skill (tom-repo-tom-quest)",
    ],
    [
      ["--refuse", "repo-tom.quest=no need", "--refuse", "repo-tom-quest=still no need"],
      "--refuse names repo-tom.quest and repo-tom-quest as the same skill (tom-repo-tom-quest)",
    ],
  ])("rejects canonical-equivalent decisions of the same kind", (args, message) => {
    const result = run(args, { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it.each([
    [
      ["--grant", "write", "--refuse", "write=withheld"],
      "--refuse write conflicts with --grant write (tom-write)",
    ],
    [
      ["--grant", "repo-tom.quest", "--refuse", "repo-tom-quest=withheld"],
      "--refuse repo-tom-quest conflicts with --grant repo-tom.quest (tom-repo-tom-quest)",
    ],
  ])("rejects conflicting grant and refusal decisions", (args, message) => {
    const result = run(args, { CODEX_BIN: fakeCodex(), WIKITOM_DIR: wikitomFixture() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it("refuses a named grant when SKILL.md is a directory rather than an installed skill file", () => {
    const argsFile = path.join(tempDir("codex-run-args-"), "args.json");
    const home = tempDir("codex-run-skills-");
    fs.mkdirSync(path.join(home, "skills", skillDirName("write"), "SKILL.md"), { recursive: true });
    const result = run(["--grant", "write"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture(),
      FAKE_CODEX_ARGS: argsFile,
      CODEX_HOME: home,
    });
    expect(result.status).toBe(0);
    expect(developerInstructions(argsFile)).toContain("refused: write — its installed SKILL.md is missing");
    expect(spooledEnvelope(result.state).envelope.registration).toMatchObject({
      skillsGranted: [],
      skillsRefused: ["write — its installed SKILL.md is missing"],
    });
  });
});

// witness: by 2026-09-23 the Jarvis Box held 5,278 abandoned /tmp/codex-run-*
// directories, one per run that did not reach its child's `close` — the model
// backgrounded the run and its turn ended, box-run settled it as a survivor,
// ssh dropped. The reap lived in the close handler and nowhere else.
describe("codex-run OpenRouter models", () => {
  const MODEL = "openrouter/deepseek/deepseek-v4-flash";
  const envFile = (body) => {
    const file = path.join(tempDir("codex-run-envfile-"), "worker.env");
    fs.writeFileSync(file, body);
    return file;
  };
  const files = () => ({
    args: path.join(tempDir("codex-run-args-"), "args.json"),
    env: path.join(tempDir("codex-run-env-"), "env.json"),
  });

  it("selects the openrouter provider, sends OpenRouter's model id, and hands the key from the env file to Codex alone", () => {
    const out = files();
    const result = run(["--model", MODEL, "--no-operate"], {
      CODEX_BIN: fakeCodex(),
      FAKE_CODEX_ARGS: out.args,
      FAKE_CODEX_ENV: out.env,
      OPENROUTER_API_KEY: "",
      RUN_ENV_FILE: envFile("GH_TOKEN=not-this-one\nOPENROUTER_API_KEY=sk-or-from-file\n"),
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(out.args, "utf8"));
    expect(argv[argv.indexOf("-m") + 1]).toBe("deepseek/deepseek-v4-flash");
    expect(argv).toContain('model_provider="openrouter"');
    expect(argv).toContain('shell_environment_policy.exclude=["OPENROUTER_API_KEY"]');
    expect(argv.join(" ")).not.toContain("sk-or-from-file");
    expect(JSON.parse(fs.readFileSync(out.env, "utf8")).openrouterKey).toBe("sk-or-from-file");
    expect(spooledEnvelope(result.state).envelope.registration.modelRequested).toBe(MODEL);
  });

  it("refuses an OpenRouter run with no key before anything is spooled", () => {
    const out = files();
    const result = run(["--model", MODEL, "--no-operate"], {
      CODEX_BIN: fakeCodex(),
      FAKE_CODEX_ARGS: out.args,
      OPENROUTER_API_KEY: "",
      RUN_ENV_FILE: envFile("GH_TOKEN=x\n"),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("an openrouter/ model needs OPENROUTER_API_KEY");
    expect(fs.existsSync(out.args)).toBe(false);
    expect(fs.existsSync(path.join(result.state, "registration"))).toBe(false);
  });

  // witness: the 2026-09-24 smoke test. The key's line was present, the
  // provider entry was present, and OpenRouter still answered "401 Missing
  // Authentication header": Codex had the variable but dropped the header,
  // which it does for a value holding a control character. These pin both
  // halves — a clean key reaches the Codex child byte for byte, however the
  // line is quoted or terminated, and a key carrying a paste's escape
  // sequences is refused before Codex starts, without printing the value.
  it("hands the caller's own key to the Codex child unchanged", () => {
    const out = files();
    const result = run(["--model", MODEL, "--no-operate"], {
      CODEX_BIN: fakeCodex(),
      FAKE_CODEX_ARGS: out.args,
      FAKE_CODEX_ENV: out.env,
      OPENROUTER_API_KEY: "sk-or-v1-fromcaller",
      RUN_ENV_FILE: envFile("OPENROUTER_API_KEY=sk-or-v1-fromfile\n"),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out.env, "utf8")).openrouterKey).toBe("sk-or-v1-fromcaller");
  });

  for (const [label, line] of [
    ["a CRLF line", "OPENROUTER_API_KEY=sk-or-v1-abc123\r\n"],
    ["a quoted value", 'OPENROUTER_API_KEY="sk-or-v1-abc123"\n'],
    ["an export line", "export OPENROUTER_API_KEY=sk-or-v1-abc123\n"],
  ]) {
    it(`reads the key from ${label} into the Codex child exactly`, () => {
      const out = files();
      const result = run(["--model", MODEL, "--no-operate"], {
        CODEX_BIN: fakeCodex(),
        FAKE_CODEX_ARGS: out.args,
        FAKE_CODEX_ENV: out.env,
        OPENROUTER_API_KEY: "",
        RUN_ENV_FILE: envFile(`A=1\n${line}B=2\n`),
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(out.env, "utf8")).openrouterKey).toBe("sk-or-v1-abc123");
    });
  }

  it("refuses a key carrying a paste's escape sequences, without printing it", () => {
    const out = files();
    const result = run(["--model", MODEL, "--no-operate"], {
      CODEX_BIN: fakeCodex(),
      FAKE_CODEX_ARGS: out.args,
      OPENROUTER_API_KEY: "",
      RUN_ENV_FILE: envFile("OPENROUTER_API_KEY=\u001b[200~sk-or-v1-pasted\u001b[201~\n"),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("holds 2 character(s) outside printable ASCII (2 control, 0 space, 0 non-ASCII)");
    expect(result.stderr).not.toContain("sk-or-v1-pasted");
    expect(fs.existsSync(out.args)).toBe(false);
    expect(fs.existsSync(path.join(result.state, "registration"))).toBe(false);
  });

  it("refuses a spelling without a vendor", () => {
    const result = run(["--model", "openrouter/deepseek-v4-flash", "--no-operate"], {
      CODEX_BIN: fakeCodex(),
      OPENROUTER_API_KEY: "sk-or-env",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("an OpenRouter model is spelled openrouter/<vendor>/<model>");
  });

  it("keeps the key from a run on the default provider", () => {
    const out = files();
    const result = run(["--no-operate"], {
      CODEX_BIN: fakeCodex(),
      FAKE_CODEX_ARGS: out.args,
      FAKE_CODEX_ENV: out.env,
      OPENROUTER_API_KEY: "sk-or-env",
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(out.args, "utf8"));
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.6-sol");
    expect(argv.some((arg) => arg.startsWith("model_provider="))).toBe(false);
    expect(JSON.parse(fs.readFileSync(out.env, "utf8")).openrouterKey).toBeNull();
  });
});

describe("codex-run work directory", () => {
  const codexRunDirs = (root) => fs.readdirSync(root).filter((name) => name.startsWith("codex-run-"));

  it("leaves nothing behind when the binary will not start", () => {
    const tmp = tempDir("codex-run-tmp-");
    // A file that exists but cannot be executed: codex-run.mjs accepts it as
    // CODEX_BIN and makes its work directory, and the spawn then fails.
    const unstartable = path.join(tmp, "unstartable-codex");
    fs.writeFileSync(unstartable, "not a program\n", { mode: 0o644 });
    const result = run(["--cwd", process.cwd()], {
      TMPDIR: tmp,
      CODEX_BIN: unstartable,
      FAKE_CODEX_ARGS: path.join(tmp, "args.json"),
    });
    expect(result.status).not.toBe(0);
    expect(codexRunDirs(tmp)).toEqual([]);
  });

  // witness: both cases named TTS_CODEX_BIN, which is box-run.mjs's variable;
  // codex-run.mjs reads CODEX_BIN. On the box they ran the real `codex` from
  // PATH, and on CI, where no codex is installed, this one waited for a work
  // directory that codex-run never made (it stops at "codex binary not
  // found") until vitest's 5-second default ended it. The 30-second limit
  // covers the loop's own 20-second deadline.
  it("leaves nothing behind when the run is hung up on", async () => {
    const tmp = tempDir("codex-run-tmp-");
    const slow = path.join(tmp, "slow-codex.mjs");
    fs.writeFileSync(slow, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n");
    fs.chmodSync(slow, 0o755);
    const state = tempDir("codex-run-state-");
    const child = spawn(process.execPath, [RUNNER, "--cwd", process.cwd()], {
      env: { ...process.env, TMPDIR: tmp, CODEX_BIN: slow, RUN_SWEEP_STATE_DIR: state, TTS_RUN_REG_SPOOL: path.join(state, "registration") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end("answer this\n");
    const deadline = Date.now() + 20_000;
    while (codexRunDirs(tmp).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(codexRunDirs(tmp)).toHaveLength(1);
    child.kill("SIGHUP");
    await new Promise((resolve) => child.on("close", resolve));
    expect(codexRunDirs(tmp)).toEqual([]);
  }, 30_000);
});
