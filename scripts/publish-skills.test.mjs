import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { publishSkills } from "./publish-skills.mjs";

const SCRIPT = path.resolve("scripts/publish-skills.mjs");
// core.autocrlf=false so the committed bytes are the bytes written here: on
// Windows the default rewrites every newline on the way in, and a test that
// compares published bytes would be comparing git's idea of them.
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false"];
// git on Windows costs seconds per repository, and every test here builds at
// least one. The 5-second default is a clock, not a symptom.
const SLOW = 120_000;
const MADE = [];

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${fs.realpathSync.native(dir)}`, "-C", dir, ...IDENTITY, ...args],
    { encoding: "utf8" },
  );
}

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  MADE.push(dir);
  return dir;
}

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

afterAll(() => {
  for (const dir of MADE) fs.rmSync(dir, { recursive: true, force: true });
});

const AGENT_RULES = [
  "# Agent rules",
  "",
  "## Map",
  "",
  "### Repos",
  "- tom.quest: site, Convex record, box jobs; AGENTS.md in app/, convex/.",
  "- ComplexMultiTrigger (CMT): his research code.",
  "",
  "### TTS",
  "- todos and rulings.",
  "",
].join("\n");

const AREAS = Object.freeze({
  admin: "[admin, email, chores]",
  "agent-systems": "[agent-systems, tts, code]",
  climbing: "[climbing, team, practice]",
  "health-and-food": "[health, food, cooking]",
  "mental-health": "[mental-health, therapy, sleep]",
  money: "[money, budget, billing]",
  research: "[research, paper, cmt]",
  social: "[social, dnd, family]",
});

/** A WikiTom with everything the set draws on, committed. */
function wikitom({ schedule = "# Schedule\n\nTuesday is practice.\n" } = {}) {
  const dir = temp("publish-skills-wikitom-");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(dir, "model-of-tom/agent-rules.md", AGENT_RULES);
  write(dir, "model-of-tom/writing.md", "# Writing\n\n## Registers\n\nPlain.\n\n## Form\n\nShort.\n");
  write(dir, "model-of-tom/ground.md", "# Ground\n\nWhat he already knows.\n");
  write(dir, "model-of-tom/intent.md", "# Intent\n\n## Directions\n\nGo.\n");
  write(dir, "model-of-tom/priorities.md", "# Priorities\n\nResearch first.\n");
  if (schedule !== null) write(dir, "model-of-tom/schedule.md", schedule);
  for (const [name, categories] of Object.entries(AREAS)) {
    write(
      dir,
      `model-of-tom/areas/${name}.md`,
      `---\nupdated: 2026-09-10\ncategories: ${categories}\n---\n\n## Current state\n\n- ${name} holds.\n`,
    );
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** A repository with a root AGENTS.md and one nested one. */
function repo(name) {
  const dir = temp(`publish-skills-${name.replace(/[^a-z0-9]/gi, "-")}-`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(dir, "AGENTS.md", `# ${name}\n\nRoot rules.\n`);
  write(dir, "convex/AGENTS.md", `# ${name} convex\n\nNested rules.\n`);
  write(dir, ".cursor/rules/global_AGENTS.md", "# not a rules file\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

// One vault and one pair of repositories, built once and never edited, for
// every test that only cares about what lands under its own --out.
const shared = {};
function sharedVault() {
  shared.vault ??= wikitom();
  return shared.vault;
}
function sharedRepos() {
  shared.tomquest ??= repo("tom.quest");
  shared.cmt ??= repo("cmt");
  return shared;
}

function publish(vault, out, options = {}) {
  const fallback = options.tomquest === undefined || options.cmt === undefined ? sharedRepos() : {};
  return publishSkills({
    wikitom: vault,
    out,
    repos: [
      { repo: "tom.quest", dir: options.tomquest ?? fallback.tomquest },
      { repo: "ComplexMultiTrigger", dir: options.cmt ?? fallback.cmt },
    ],
    ...options.publish,
  });
}

function tree(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      out[entry.name] = fs.readFileSync(path.join(dir, entry.name)).toString("base64");
      continue;
    }
    for (const [name, body] of Object.entries(tree(path.join(dir, entry.name)))) {
      out[`${entry.name}/${name}`] = body;
    }
  }
  return out;
}

describe("publish-skills", () => {
  it("writes one directory per skill, with SKILL.md and one file per reference", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-out-");
    const result = publish(vault, out);
    expect(result.refused).toEqual([]);
    expect(result.skills).toHaveLength(13);
    expect(fs.readdirSync(out).sort()).toEqual(
      [
        "tom-know-admin",
        "tom-know-agent-systems",
        "tom-know-climbing",
        "tom-know-health-and-food",
        "tom-know-intent",
        "tom-know-mental-health",
        "tom-know-money",
        "tom-know-research",
        "tom-know-social",
        "tom-know-week",
        "tom-repo-ComplexMultiTrigger",
        "tom-repo-tom.quest",
        "tom-write",
      ].sort(),
    );
    expect(fs.readdirSync(path.join(out, "tom-write")).sort()).toEqual(["SKILL.md", "ground.md"]);
    expect(fs.readdirSync(path.join(out, "tom-repo-tom.quest")).sort()).toEqual(["SKILL.md", "convex-AGENTS.md"]);
    // global_AGENTS.md is not a rules file: the selection is on the
    // `/AGENTS.md` suffix, not on a basename that happens to end in it.
    expect(fs.readdirSync(path.join(out, "tom-repo-tom.quest"))).not.toContain(
      ".cursor-rules-global_AGENTS.md",
    );
    expect(fs.readFileSync(path.join(out, "tom-know-admin", "SKILL.md"), "utf8")).toContain("name: tom-know-admin");
  }, SLOW);

  it("reads committed objects only, so a dirty work tree changes nothing", () => {
    const vault = wikitom();
    const tomquest = repo("tom.quest");
    const cmt = repo("cmt");
    const first = temp("publish-skills-clean-");
    publish(vault, first, { tomquest, cmt });
    const clean = tree(first);

    write(vault, "model-of-tom/areas/admin.md", "---\ncategories: [wrecked]\n---\n\n## Ruined\n");
    write(vault, "model-of-tom/areas/uncommitted.md", "---\ncategories: [ghost]\n---\n\n## Ghost\n");
    write(tomquest, "AGENTS.md", "# scratch\n");
    const second = temp("publish-skills-dirty-");
    publish(vault, second, { tomquest, cmt });
    expect(tree(second)).toEqual(clean);
  }, SLOW);

  it("is idempotent: the second run writes nothing", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-idempotent-");
    const first = publish(vault, out);
    expect(first.skills.every((skill) => skill.wrote > 0)).toBe(true);
    expect(first.skills.every((skill) => skill.unchanged === 0)).toBe(true);
    const second = publish(vault, out);
    expect(second.skills.every((skill) => skill.wrote === 0)).toBe(true);
    expect(second.skills.every((skill) => skill.unchanged > 0)).toBe(true);
    expect(second.deleted).toEqual([]);
  }, SLOW);

  it("rewrites only the file whose bytes changed", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-changed-");
    publish(vault, out);
    fs.writeFileSync(path.join(out, "tom-know-money", "SKILL.md"), "tampered\n");
    const again = publish(vault, out);
    expect(again.skills.filter((skill) => skill.wrote > 0).map((skill) => skill.name)).toEqual(["know-money"]);
  }, SLOW);

  it("refuses a missing source in the result and still writes the other skills", () => {
    const vault = wikitom({ schedule: null });
    const out = temp("publish-skills-refused-");
    const result = publish(vault, out);
    expect(result.refused).toEqual([
      { name: "know-week", why: "model-of-tom/schedule.md is absent at this commit" },
    ]);
    expect(result.skills.map((skill) => skill.name)).not.toContain("know-week");
    expect(fs.existsSync(path.join(out, "tom-know-week"))).toBe(false);
    expect(fs.existsSync(path.join(out, "tom-know-admin", "SKILL.md"))).toBe(true);
  }, SLOW);

  it("deletes a stale tom- directory and leaves everything else in --out alone", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-stale-");
    fs.mkdirSync(path.join(out, "tom-know-retired"), { recursive: true });
    fs.writeFileSync(path.join(out, "tom-know-retired", "SKILL.md"), "gone\n");
    fs.mkdirSync(path.join(out, "graphify"), { recursive: true });
    fs.writeFileSync(path.join(out, "graphify", "SKILL.md"), "not mine\n");
    fs.writeFileSync(path.join(out, "README.md"), "not mine either\n");

    const result = publish(vault, out);
    expect(result.deleted).toEqual(["tom-know-retired"]);
    expect(fs.existsSync(path.join(out, "tom-know-retired"))).toBe(false);
    expect(fs.readFileSync(path.join(out, "graphify", "SKILL.md"), "utf8")).toBe("not mine\n");
    expect(fs.readFileSync(path.join(out, "README.md"), "utf8")).toBe("not mine either\n");
  }, SLOW);

  it("removes a ghost file inside a directory it owns", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-ghost-");
    publish(vault, out);
    fs.writeFileSync(path.join(out, "tom-know-admin", "renamed-AGENTS.md"), "ghost\n");
    const result = publish(vault, out);
    expect(result.deleted).toEqual(["tom-know-admin/renamed-AGENTS.md"]);
    expect(fs.existsSync(path.join(out, "tom-know-admin", "renamed-AGENTS.md"))).toBe(false);
  }, SLOW);

  it("computes everything and writes nothing on --dry-run", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-dry-");
    const result = publish(vault, out, { publish: { dryRun: true } });
    expect(result.skills).toHaveLength(13);
    expect(result.skills.every((skill) => skill.wrote > 0)).toBe(true);
    expect(fs.readdirSync(out)).toEqual([]);
  }, SLOW);

  it("prints the JSON shape on --json", () => {
    const vault = sharedVault();
    const out = temp("publish-skills-json-");
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", vault, "--repo", `tom.quest=${sharedRepos().tomquest}`, "--out", out, "--json"],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(Object.keys(result).sort()).toEqual(["commit", "deleted", "out", "refused", "skills"]);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    const write = result.skills.find((skill) => skill.name === "write");
    expect(write).toMatchObject({ group: "write", references: ["ground.md"], unchanged: 0 });
    expect(write.descriptionBytes).toBeGreaterThan(0);
    expect(write.bodyBytes).toBeGreaterThan(0);
  }, SLOW);

  it("exits 2 with a publish-skills: line for a bad argument", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--out", temp("publish-skills-bad-")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe("publish-skills: --wikitom DIR is required");
  }, SLOW);

  it("exits 2 for an unreadable WikiTom", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", path.join(os.tmpdir(), "no-such-wikitom-dir"), "--out", temp("publish-skills-nope-")],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("publish-skills: cannot read WikiTom at");
  }, SLOW);

  it("exits 2 for a --repo without NAME=DIR", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", sharedVault(), "--repo", "tom.quest", "--out", temp("publish-skills-repo-")],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe("publish-skills: --repo wants NAME=DIR, not tom.quest");
  }, SLOW);
});
