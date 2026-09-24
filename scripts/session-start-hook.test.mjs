import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assemblePrelude } from "./prelude.mjs";
import { renderGrants } from "../shared/skills.mjs";
import { PULL_TIMEOUT_MS, pullWikiTom } from "./session-start-hook.mjs";
import { registrationSidecarPath } from "../worker/runs/registration.mjs";
import { tempDir } from "../test/temp.mjs";

const HOOK = path.resolve("scripts/session-start-hook.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

/** The real vault, when this laptop has it. The budget below is asserted
 * against it as well as against the fixture: a fixture proves the shape, and
 * only the real operate layer proves the SIZE. */
const VAULT = "C:/Users/heffn/Desktop/WikiTom-uae";

/** What a laptop session is allowed to cost before it has done anything. The
 * old hook sent 19,775 bytes here (operate, the write layer and the fetchable
 * index); the budget is set at 12,000 so a drift back toward that number fails
 * a test rather than quietly costing every session. */
const LAPTOP_BUDGET = 12_000;

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

/**
 * A WikiTom the whole catalog can be published out of: the map (with a
 * `### Repos` block, which is where a `repo-` skill's description comes from),
 * the write layer and the know layer.
 */
function fixture({ writing = true } = {}) {
  const dir = tempDir("session-start-wikitom-");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  // The repository's own rules, which is what a `repo-` skill's body IS.
  write(dir, "AGENTS.md", "# WikiTom\n\nThe vault. Never edit tom-text/.\n");
  write(
    dir,
    "model-of-tom/agent-rules.md",
    "# Agent rules\n\n## Map\n\n### Repos\n- WikiTom: the vault.\n- tom.quest: the site.\n\n## How you work\n\n- Read this.\n",
  );
  if (writing) write(dir, "model-of-tom/writing.md", "# Writing\n\n## Sentences\n\nUse short sentences.\n");
  write(dir, "model-of-tom/ground.md", "# Ground\n\nKnown facts.\n");
  write(dir, "model-of-tom/intent.md", "# Intent\n\n## Directions\n\n- Ship.\n");
  write(dir, "model-of-tom/priorities.md", "# Priorities\n\n## What becomes a todo\n\n- Dated things.\n");
  write(dir, "model-of-tom/schedule.md", "# Schedule\n\n## Week\n\n- Monday — practice.\n");
  write(dir, "model-of-tom/areas/admin.md", "---\ncategories: [admin, email]\nupdated: 2026-09-09\n---\n\n## Current state\n\n- Present.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/**
 * The hook, with every destination pointed at `skills` and every other source
 * of one neutralised. `TTS_SKILLS_DIRS` is the seam scripts/session-start-hook.mjs
 * declares; `CLAUDE_CONFIG_DIR` and `CMT_DIR` are cleared so this laptop's own
 * configuration cannot reach a test, and `TOM_QUEST_DIR` is pointed at a
 * directory that is not a checkout so the run publishes no repo but WikiTom's.
 *
 * `RUN_HOST` IS CLEARED FOR THE SAME REASON, and it was the one source of a
 * destination this list forgot. The hook publishes only when it is NOT on the
 * box (the box's nightly is the one publisher there), and worker/setup.sh
 * exports `RUN_HOST=box` from the first line of the box's `.bashrc` — so on the
 * box six cases here published nothing, read an empty catalog and got
 * "refused: write" where they asked for "granted: write". They passed on Tom's
 * laptop, where the variable is unset, and on a CI runner for the same reason.
 * The three cases that WANT the box branch pass `RUN_HOST` themselves.
 */
function run({ wikitom, skills, tomQuest, env = {}, payload = {
  hook_event_name: "SessionStart",
  transcript_path: path.join(tempDir("session-start-default-run-"), "session.jsonl"),
} }) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: `${JSON.stringify(payload)}\n`,
    env: {
      ...process.env,
      WIKITOM_DIR: wikitom,
      TTS_SKILLS_DIRS: Array.isArray(skills) ? skills.join(";") : skills,
      TOM_QUEST_DIR: tomQuest ?? path.join(os.tmpdir(), "no-tom-quest-checkout"),
      CLAUDE_CONFIG_DIR: "",
      CMT_DIR: "",
      RUN_HOST: "",
      ...env,
    },
  });
}

function contextOf(result) {
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
  expect(Object.keys(json.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
  expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return json.hookSpecificOutput.additionalContext;
}

// Every case here SPAWNS the hook — a node process, a git checkout and a skill
// publication each — so the default five seconds is a load measurement rather
// than a fact about the hook (worker/jobs/nightly.test.mjs says the same).
describe("session-start-hook", { timeout: 30_000 }, () => {
  // The skills round: the write layer became the `write` skill and the
  // fetchable index went with it, so what rides every session start is the
  // operate layer and the names this run may load — and NOTHING ELSE.
  it("emits the operate layer and the grant block, and nothing else", () => {
    const wikitom = fixture();
    const skills = tempDir("session-start-skills-");
    const commit = git(wikitom, "rev-parse", "HEAD").trim();

    const context = contextOf(run({ wikitom, skills }));

    expect(context).toBe(
      `${assemblePrelude({ wikitom, layers: "operate" }).text}\n\n`
        + `${renderGrants({ commit, granted: ["write"], refused: [] })}`,
    );
    // The write layer is a SKILL now, not a prefix: its name is in the block
    // and its body is not in the prompt.
    expect(context).toContain("granted: write");
    expect(context).not.toContain("── model-of-tom/writing.md ──");
    expect(context).not.toContain("Use short sentences.");
    expect(context).not.toContain("── model-of-tom/ground.md ──");
    // And neither is the index of what the run could fetch.
    expect(context).not.toContain("MODEL-OF-TOM FETCHABLE");
    expect(context).not.toContain("--layers know");
  });

  it("hands the actual granted and refused names to the independent receipt", () => {
    const wikitom = fixture({ writing: false });
    const skills = tempDir("session-start-registration-skills-");
    const transcript = path.join(tempDir("session-start-registration-run-"), "session.jsonl");

    contextOf(run({
      wikitom,
      skills,
      payload: { hook_event_name: "SessionStart", transcript_path: transcript },
    }));

    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(transcript), "utf8"));
    expect(envelope.receipt).toMatchObject({
      by: "hook:session-start-grants",
      runFile: path.resolve(transcript),
      skillsGranted: [],
      skillsRefused: ["write"],
    });
    expect(envelope.claim).toBeUndefined();
  });

  it("accepts only Claude's transcript_path and Codex's rollout_path run-file fields", () => {
    const wikitom = fixture();
    const skills = tempDir("session-start-run-file-skills-");
    const legacy = path.join(tempDir("session-start-legacy-run-"), "legacy.jsonl");
    contextOf(run({ wikitom, skills, payload: { hook_event_name: "SessionStart", transcriptPath: legacy } }));
    expect(fs.existsSync(registrationSidecarPath(legacy))).toBe(false);

    const rollout = path.join(tempDir("session-start-rollout-run-"), "rollout.jsonl");
    contextOf(run({ wikitom, skills, payload: { hook_event_name: "SessionStart", rollout_path: rollout } }));
    expect(JSON.parse(fs.readFileSync(registrationSidecarPath(rollout), "utf8")).receipt.runFile).toBe(path.resolve(rollout));
  });

  it("keeps operate context but does not route skills for an invalid or ambiguous payload", () => {
    const wikitom = fixture();
    const skills = path.join(tempDir("session-start-unidentified-skills-"), "skills");
    const invalid = path.join(tempDir("session-start-invalid-run-"), "session.jsonl");
    const transcript = path.join(tempDir("session-start-unidentified-run-"), "session.jsonl");
    const invalidContext = contextOf(run({
      wikitom,
      skills,
      payload: { hook_event_name: "SessionStart", transcriptPath: invalid },
    }));
    expect(invalidContext).toContain("SKILLS could not be routed: launcher identity missing; skill catalog was not read");
    expect(fs.existsSync(registrationSidecarPath(invalid))).toBe(false);

    const context = contextOf(run({
      wikitom,
      skills,
      payload: { hook_event_name: "SessionStart", transcript_path: transcript, rollout_path: transcript },
      env: {
        TTS_CLI: "Codex", TTS_RUNNER: "claude", CODEX_THREAD_ID: "thread", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "entry", CODEX_HOME: "somewhere", CLAUDE_CONFIG_DIR: "somewhere-else",
      },
    }));
    expect(context).toContain("── model-of-tom/agent-rules.md ──");
    expect(context).toContain("SKILLS could not be routed: launcher identity missing; skill catalog was not read");
    expect(fs.existsSync(skills)).toBe(false);
    expect(fs.existsSync(registrationSidecarPath(transcript))).toBe(false);
  });

  it("routes ordinary Claude and Codex SessionStart payloads from their own fields", () => {
    const wikitom = fixture();
    const claudeSkills = tempDir("session-start-payload-claude-skills-");
    const codexSkills = tempDir("session-start-payload-codex-skills-");
    const claudeRun = path.join(tempDir("session-start-payload-claude-run-"), "session.jsonl");
    const codexRun = path.join(tempDir("session-start-payload-codex-run-"), "rollout.jsonl");

    expect(contextOf(run({
      wikitom,
      skills: claudeSkills,
      payload: { hook_event_name: "SessionStart", transcript_path: claudeRun, session_id: "claude-session", cwd: process.cwd() },
    }))).toContain("granted: write");
    expect(contextOf(run({
      wikitom,
      skills: codexSkills,
      payload: { hook_event_name: "SessionStart", rollout_path: codexRun, thread_id: "codex-thread", cwd: process.cwd() },
    }))).toContain("granted: write");
  });

  it("stays inside the laptop budget, on the fixture and on the real vault", () => {
    const wikitom = fixture();
    const skills = tempDir("session-start-budget-");
    expect(Buffer.byteLength(contextOf(run({ wikitom, skills })))).toBeLessThan(LAPTOP_BUDGET);

    // The real operate layer is the one that costs something, and it is the one
    // the budget is really about. Assembled here rather than through the hook
    // so the suite never fetches: the hook's WikiTom pull is a network call and
    // a test that made it would fail on a plane and mutate a checkout it does
    // not own. The bytes are the same bytes — the pull cannot change them.
    if (!fs.existsSync(VAULT)) return;
    const operate = assemblePrelude({ wikitom: VAULT, layers: "operate" });
    const text = `${operate.text}\n\n${renderGrants({ commit: operate.commit, granted: ["write"], refused: [] })}`;
    expect(Buffer.byteLength(text)).toBeLessThan(LAPTOP_BUDGET);
  });

  // A SESSION THAT CANNOT WRITE A DIRECTORY STILL STARTS. The base is fatal and
  // a skill is not: the operate layer goes either way, the names the run cannot
  // load are recorded refused, and the whole cost of the failure is one line.
  it("keeps the base when the skills refresh fails, and says the catalog may be stale", () => {
    const wikitom = fixture();
    const blocked = path.join(tempDir("session-start-blocked-"), "a-file");
    fs.writeFileSync(blocked, "not a directory\n");

    const context = contextOf(run({ wikitom, skills: path.join(blocked, "skills") }));

    expect(context).toContain("── model-of-tom/agent-rules.md ──");
    expect(context).toContain("granted: —");
    expect(context).toContain("refused: write — no published body at this commit");
    const stale = context.split("\n").filter((line) => line.startsWith("skill catalog may be stale: "));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain(path.resolve(path.join(blocked, "skills")));
  });

  it("reports a one-line load failure and exits successfully", () => {
    const skills = tempDir("session-start-missing-");
    const context = contextOf(run({ wikitom: path.join(os.tmpdir(), "missing-session-start-wikitom"), skills }));
    const lines = context.split("\n");
    expect(lines[0]).toMatch(/^model-of-tom context could not be loaded: .+$/);
    // The catalog could not be built either, and that is the only other line.
    expect(lines[1]).toMatch(/^skill catalog may be stale: .+$/);
    expect(lines).toHaveLength(2);
  });

  // The refresh writes ONLY what it produces. A skills directory holds other
  // people's skills, and a hook that tidied them would lose work nobody asked
  // it to manage.
  it("publishes the tom- directories and leaves every other skill alone", () => {
    const wikitom = fixture();
    const skills = tempDir("session-start-publish-");
    const other = tempDir("session-start-publish-codex-");
    fs.mkdirSync(path.join(skills, "graphify"), { recursive: true });
    fs.writeFileSync(path.join(skills, "graphify", "SKILL.md"), "---\nname: graphify\n---\n\nNot Tom's.\n");

    contextOf(run({ wikitom, skills: [skills, other] }));

    for (const dir of [skills, other]) {
      expect(fs.existsSync(path.join(dir, "tom-write", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "tom-know-admin", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "tom-repo-wikitom", "SKILL.md"))).toBe(true);
    }
    expect(fs.readFileSync(path.join(skills, "graphify", "SKILL.md"), "utf8")).toContain("Not Tom's.");
    expect(fs.readFileSync(path.join(skills, "tom-write", "SKILL.md"), "utf8")).toContain("Use short sentences.");
  });

  // A page Tom emptied is a REFUSAL, not a dead session.
  it("records a skill with no page as refused and still starts the session", () => {
    const wikitom = fixture({ writing: false });
    const skills = tempDir("session-start-refused-");
    const context = contextOf(run({ wikitom, skills }));
    expect(context).toContain("── model-of-tom/agent-rules.md ──");
    expect(context).toContain("granted: —");
    expect(context).toContain("refused: write — no published body at this commit");
    expect(context).not.toContain("skill catalog may be stale");
  });

  it("labels box grants with the commit in their existing skill bodies", () => {
    const wikitom = fixture();
    const skills = tempDir("session-start-box-stale-");
    const oldCommit = git(wikitom, "rev-parse", "HEAD").trim();
    contextOf(run({ wikitom, skills }));

    write(wikitom, "model-of-tom/writing.md", "# Writing\n\n## Sentences\n\nThe new body.\n");
    git(wikitom, "add", "-A");
    git(wikitom, "commit", "-q", "-m", "new body");
    const newCommit = git(wikitom, "rev-parse", "HEAD").trim();

    const context = contextOf(run({ wikitom, skills, env: { RUN_HOST: "box" } }));
    expect(context).toContain(`SKILLS (WikiTom commit ${oldCommit})`);
    expect(context).not.toContain(`SKILLS (WikiTom commit ${newCommit})`);
    expect(fs.readFileSync(path.join(skills, "tom-write", "SKILL.md"), "utf8")).toContain("Use short sentences.");
  });

  it("routes the Claude SessionStart grant from Claude's directory only", () => {
    const wikitom = fixture();
    const claude = tempDir("session-start-claude-catalog-");
    const codex = tempDir("session-start-codex-catalog-");
    const commit = git(wikitom, "rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(codex, "tom-write"));
    fs.writeFileSync(
      path.join(codex, "tom-write", "SKILL.md"),
      `<!-- generated from WikiTom model-of-tom/writing.md at commit ${commit} — do not edit -->\n`,
    );

    const context = contextOf(run({ wikitom, skills: [claude, codex], env: { RUN_HOST: "box" } }));
    expect(context).toContain("granted: —");
    expect(context).toContain("refused: write — no published body at this commit");
  });

  it("routes a Codex SessionStart grant from Codex's directory only", () => {
    const wikitom = fixture();
    const claude = tempDir("session-start-claude-catalog-");
    const codex = tempDir("session-start-codex-catalog-");
    const commit = git(wikitom, "rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(claude, "tom-write"));
    fs.writeFileSync(
      path.join(claude, "tom-write", "SKILL.md"),
      `<!-- generated from WikiTom model-of-tom/writing.md at commit ${commit} — do not edit -->\n`,
    );

    const context = contextOf(run({
      wikitom,
      skills: [claude, codex],
      env: { RUN_HOST: "box" },
      payload: { hook_event_name: "SessionStart", rollout_path: path.join(tempDir("session-start-codex-route-"), "rollout.jsonl") },
    }));
    expect(context).toContain("granted: —");
    expect(context).toContain("refused: write — no published body at this commit");
  });

  // A session start waits for the pull, so the pull must be capped: without a
  // timeout one slow fetch made a laptop session wait two minutes.
  it("caps the WikiTom pull at fifteen seconds", () => {
    const dir = fixture();
    const calls = [];
    const fakeExecFileSync = (file, args, options) => { calls.push({ file, args, options }); };

    expect(pullWikiTom(dir, fakeExecFileSync)).toBe(true);
    expect(calls).toEqual([{
      file: "git",
      args: ["-C", dir, "pull", "--ff-only", "--quiet"],
      options: { stdio: "ignore", timeout: 15_000 },
    }]);
    expect(PULL_TIMEOUT_MS).toBe(15_000);
  });

  it("skips the pull when WikiTom is absent, and swallows a pull that fails", () => {
    const absent = path.join(os.tmpdir(), "missing-session-start-wikitom");
    const never = () => { throw new Error("must not run"); };
    expect(pullWikiTom(absent, never)).toBe(false);

    const dir = fixture();
    const killed = () => { throw Object.assign(new Error("timed out"), { signal: "SIGTERM" }); };
    expect(pullWikiTom(dir, killed)).toBe(false);
  });
});
