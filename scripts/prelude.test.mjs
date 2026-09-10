import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assemblePrelude, assemblePreludePublication, collectRepoRules, PRELUDE_LAYERS } from "./prelude.mjs";
import { EXPAND_BUDGET } from "../worker/jobs/context-relevance.mjs";
import {
  CONTEXT_PAGES,
  CONTEXT_REPO_RULES,
  EXPECTED,
  IDS,
  OVERSIZE_PAGE,
  contextRecord,
  expectedPrefix,
} from "./context-fixture.mjs";

const SCRIPT = path.resolve("scripts/prelude.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(dir, ...args) {
  return execFileSync("git", ["-c", `safe.directory=${fs.realpathSync.native(dir)}`, "-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

const REQUIRED_AREAS = PRELUDE_LAYERS.know.areas.required;

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function fixture({ ground = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prelude-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(dir, "model-of-tom/agent-rules.md", "# Rules\n\nDo the thing.\n");
  write(dir, "model-of-tom/writing.md", "# Writing\n\nBe plain.\n");
  if (ground) write(dir, "model-of-tom/ground.md", "# Ground\n\nStart here.\n");
  write(dir, "model-of-tom/intent.md", "# Intent\n\nBuild useful things.\n");
  write(dir, "model-of-tom/priorities.md", "# Priorities\n\nResearch.\n");
  write(dir, "model-of-tom/schedule.md", "# Schedule\n\nTuesday.\n");
  for (const area of REQUIRED_AREAS) {
    write(dir, area, "## Current state\n\n- Present.\n");
  }
  write(
    dir,
    "model-of-tom/areas/zebra.md",
    "---\nupdated: 2026-09-09\n---\n\n# Zebra\n\n## Current state\n\n- Present.\n\n## History\n\n- Kept.\n",
  );
  write(dir, "model-of-tom/areas/alpha.md", "---\nupdated: 2026-09-09\n---\n\n# Alpha\n\n## Current state\n\n- First.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

describe("prelude", () => {
  it("assembles requested layers in canonical order and keeps each area page minus frontmatter", () => {
    const dir = fixture();
    const prelude = assemblePrelude({ wikitom: dir, layers: "know,operate" });
    expect(Object.keys(prelude.layers)).toEqual(["operate", "know"]);
    expect(prelude.files.map((file) => file.path)).toEqual([
      "model-of-tom/agent-rules.md",
      "model-of-tom/intent.md",
      "model-of-tom/priorities.md",
      "model-of-tom/schedule.md",
      ...[...REQUIRED_AREAS, "model-of-tom/areas/alpha.md", "model-of-tom/areas/zebra.md"].sort(),
    ]);
    expect(prelude.text.split("\n")[0]).toBe(
      `MODEL-OF-TOM FILES (WikiTom commit ${prelude.commit}): ${prelude.files.map((file) => file.path).join(", ")}`,
    );
    expect(prelude.text.split("\n")[2]).toBe("── model-of-tom/agent-rules.md ──");
    const zebra = prelude.files.find((file) => file.path.endsWith("zebra.md")).body;
    expect(zebra).toBe("# Zebra\n\n## Current state\n\n- Present.\n\n## History\n\n- Kept.");
    expect(zebra).not.toContain("updated:");
    expect(prelude.files.filter((file) => file.path.startsWith("model-of-tom/areas/")).map((file) => file.path)).toEqual(
      [...REQUIRED_AREAS, "model-of-tom/areas/alpha.md", "model-of-tom/areas/zebra.md"].sort(),
    );
  });

  it("omits ground.md only until it is first committed", () => {
    const dir = fixture();
    const absent = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "write"], { encoding: "utf8" });
    expect(absent.status).toBe(0);
    expect(absent.stdout).not.toContain("ground.md");
    expect(absent.stderr).toContain("optional model-of-tom/ground.md is absent");

    const firstBlank = fixture();
    write(firstBlank, "model-of-tom/ground.md", " \n\t");
    git(firstBlank, "add", "-A");
    git(firstBlank, "commit", "-q", "-m", "first blank ground");
    const blankFirstAppearance = spawnSync(process.execPath, [SCRIPT, "--wikitom", firstBlank, "--layers", "write"], { encoding: "utf8" });
    expect(blankFirstAppearance.status).toBe(2);
    expect(blankFirstAppearance.stderr).toContain("required model-of-tom/ground.md is blank");

    write(dir, "model-of-tom/ground.md", "# Ground\n\nNow present.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ground");
    const present = assemblePrelude({ wikitom: dir, layers: "write" });
    expect(present.files.map((file) => file.path)).toEqual([
      "model-of-tom/writing.md",
      "model-of-tom/ground.md",
    ]);

    write(dir, "model-of-tom/ground.md", " \n\t");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "blank ground");
    const blank = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "write"], { encoding: "utf8" });
    expect(blank.status).toBe(2);
    expect(blank.stderr).toContain("required model-of-tom/ground.md is blank");

    git(dir, "rm", "model-of-tom/ground.md");
    git(dir, "commit", "-q", "-m", "delete ground");
    const deleted = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "write"], { encoding: "utf8" });
    expect(deleted.status).toBe(2);
    expect(deleted.stderr).toContain("required model-of-tom/ground.md is absent");
  });

  it("keeps raw area files as facts while layers carry their whole bodies without frontmatter", () => {
    const dir = fixture();
    const publication = assemblePreludePublication({ wikitom: dir });
    const area = publication.files.find((file) => file.path === "model-of-tom/areas/zebra.md");
    expect(area.sourceBody).toContain("updated: 2026-09-09");
    expect(area.body).toContain("## History");
    expect(area.body).not.toContain("updated: 2026-09-09");
    expect(area.bytes).toBe(Buffer.byteLength(area.sourceBody));
    expect(publication.layers.know).toContain("## History");
    expect(publication.headers).toHaveLength(7);
  });

  it("accepts a required area with the current-state page shape", () => {
    const dir = fixture();
    write(dir, "model-of-tom/areas/alpha.md", "---\nupdated: 2026-09-09\n---\n\n## Current state\n\n- First.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "current state area");
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "know"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## Current state");
  });

  it("rejects an area whose body is blank after frontmatter", () => {
    const dir = fixture();
    const area = "model-of-tom/areas/alpha.md";
    write(dir, area, "---\nupdated: 2026-09-09\n---\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "blank area body");
    const commit = git(dir, "rev-parse", "HEAD").trim();
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "know"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`required ${area} is blank at ${commit}`);
  });

  it("requires every named area and the areas directory", () => {
    const missingPage = fixture();
    git(missingPage, "rm", "model-of-tom/areas/admin.md");
    git(missingPage, "commit", "-q", "-m", "missing named area");
    const absentPage = spawnSync(process.execPath, [SCRIPT, "--wikitom", missingPage, "--layers", "know"], { encoding: "utf8" });
    expect(absentPage.status).toBe(2);
    expect(absentPage.stderr).toContain("model-of-tom/areas/admin.md");

    const missingDirectory = fixture();
    git(missingDirectory, "rm", "-r", "model-of-tom/areas");
    git(missingDirectory, "commit", "-q", "-m", "missing areas");
    const absentDirectory = spawnSync(process.execPath, [SCRIPT, "--wikitom", missingDirectory, "--layers", "know"], { encoding: "utf8" });
    expect(absentDirectory.status).toBe(2);
    expect(absentDirectory.stderr).toContain("model-of-tom/areas");
  });

  it("rejects blank required fixed files with their paths", () => {
    for (const [layer, definition] of Object.entries(PRELUDE_LAYERS)) {
      for (const entry of definition.files.filter((file) => !file.optionalUntilPresent)) {
        const dir = fixture();
        write(dir, entry.path, " \n\t");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "blank required file");
        const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", layer], { encoding: "utf8" });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`required ${entry.path} is blank`);
      }
    }
  });

  it("accepts a sandbox-owned checkout through a per-command safe-directory setting", () => {
    const dir = fixture();
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "operate"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    expect(result.status).toBe(0);
  });

  it("fails with exit 2 and the missing required path", () => {
    const dir = fixture();
    git(dir, "rm", "model-of-tom/priorities.md");
    git(dir, "commit", "-q", "-m", "missing priorities");
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--layers", "know"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("model-of-tom/priorities.md");
  });

  it("renders commit metadata, pushed state, and byte metadata as JSON", () => {
    const dir = fixture({ ground: true });
    const commit = git(dir, "rev-parse", "HEAD").trim();
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--commit", commit, "--layers", "write", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json)).toEqual(["commit", "committedAt", "pushed", "layers", "files"]);
    expect(json).toMatchObject({ commit, committedAt: expect.any(Number), pushed: false });
    expect(Object.keys(json.layers)).toEqual(["write"]);
    expect(json.files).toEqual([
      { path: "model-of-tom/writing.md", bytes: Buffer.byteLength("# Writing\n\nBe plain.\n") },
      { path: "model-of-tom/ground.md", bytes: Buffer.byteLength("# Ground\n\nStart here.\n") },
    ]);
  });
});

// ── --for: one run's own context ─────────────────────────────────────────────
// Every assertion below is on THE EXACT ASSEMBLY, and every expected string
// comes from scripts/context-fixture.mjs, which convex/ttsContext.test.ts
// imports too. The two implementations of the composition cannot drift the way
// the prelude and its callers could before.

/** The fixture WikiTom: the same pages the Convex test seeds, in a git dir. */
function contextFixture({ oversize = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prelude-for-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const [relative, body] of Object.entries(CONTEXT_PAGES)) write(dir, relative, body);
  if (oversize) write(dir, "model-of-tom/areas/oversize.md", OVERSIZE_PAGE);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "context fixture");
  return dir;
}

function recordFile(dir, overrides = {}) {
  const file = path.join(dir, "record.json");
  fs.writeFileSync(file, JSON.stringify({ ...contextRecord(), repoRules: CONTEXT_REPO_RULES, ...overrides }));
  return file;
}

function assembleFor(dir, subject, caller = "opener") {
  return assemblePrelude({
    wikitom: dir,
    for: subject,
    caller,
    record: { ...contextRecord(), repoRules: CONTEXT_REPO_RULES },
  });
}

describe("prelude --for", () => {
  it("gives the laptop hook the map, the operate rules, the write layer and the whole index", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, "laptop", "laptop");
    expect(prelude.prefix).toBe(expectedPrefix(prelude.commit));
    expect(prelude.expanded).toBe(EXPECTED.laptop.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.laptop.fetchable);
    expect(prelude.text).toBe(`${prelude.prefix}\n\n${EXPECTED.laptop.fetchable}`);
    // The whole point: no know layer at all, and the know layer's own line
    // saying how to get it.
    expect(prelude.text).not.toContain("── model-of-tom/intent.md ──");
    expect(prelude.text).toContain("--layers know");
  });

  it("expands one area by name and leaves the other seven in the index", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, "area:climbing");
    expect(prelude.expanded).toBe(EXPECTED.areaClimbing.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.areaClimbing.fetchable);
  });

  it("expands a dated todo's area, its intent section, the corrections, and its own weekday", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, `todo:${IDS.climb}`);
    expect(prelude.expanded).toBe(EXPECTED.todoClimbing.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.todoClimbing.fetchable);
    expect(prelude.manifest).toEqual(EXPECTED.todoClimbing.manifest);
    // The Monday bullets and NO other day's.
    expect(prelude.expanded).not.toContain("Tuesday");
    expect(prelude.expanded).not.toContain("Wednesday");
  });

  it("expands no area for a category no page claims, says so, and exits 0", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, `todo:${IDS.nosuch}`);
    expect(prelude.expanded).toBe(EXPECTED.todoNoMatch.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.todoNoMatch.fetchable);
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", dir, "--for", `todo:${IDS.nosuch}`, "--caller", "opener", "--record", recordFile(dir)],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('nothing matched category "nosuch"');
  });

  it("expands the repo rules the brief's paths name, root first then deepest", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, `todo:${IDS.paths}`);
    expect(prelude.expanded).toBe(EXPECTED.todoPaths.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.todoPaths.fetchable);
  });

  it("expands a batch's areas by todo count then name, and indexes the third", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, `batch:${IDS.memberBatch}`);
    expect(prelude.expanded).toBe(EXPECTED.batchMembers.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.batchMembers.fetchable);
  });

  it("shrinks an oversized area in the documented order, and puts every dropped item in the index", () => {
    const dir = contextFixture({ oversize: true });
    const prelude = assembleFor(dir, `todo:${IDS.oversize}`);
    expect(prelude.shrink.expand).toEqual(EXPECTED.oversize.shrink);
    expect(prelude.manifest).toEqual(EXPECTED.oversize.manifest);
    expect(prelude.bytes.expandedBody).toBeLessThanOrEqual(EXPAND_BUDGET);
    // The page whose History went, the outcomes that went, and the rulings
    // that went are each one line away.
    expect(prelude.fetchable).toContain(EXPECTED.oversize.fetchableLine);
    expect(prelude.fetchable).toContain("tts-search sessions [--repo NAME]");
    expect(prelude.fetchable).toContain('tts-search rulings "<query>"');
  });

  it("assembles byte-identically twice at one commit", () => {
    const dir = contextFixture();
    const first = assembleFor(dir, `todo:${IDS.paths}`);
    const second = assembleFor(dir, `todo:${IDS.paths}`);
    expect(second.text).toBe(first.text);
    expect(Buffer.byteLength(second.text)).toBe(Buffer.byteLength(first.text));
  });

  it("expands a repo's area and its root rules, with nothing todo-shaped", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, "repo:tom.quest");
    expect(prelude.expanded).toBe(EXPECTED.repoTomQuest.expanded);
    expect(prelude.fetchable).toBe(EXPECTED.repoTomQuest.fetchable);
    expect(prelude.expanded).not.toContain("his rulings on this subject");
  });

  it("refuses a todo or batch subject with no record, and never guesses one", () => {
    const dir = contextFixture();
    const noRecord = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--for", `todo:${IDS.climb}`], { encoding: "utf8" });
    expect(noRecord.status).toBe(2);
    expect(noRecord.stderr).toContain(`--for todo:${IDS.climb} needs --record`);
    const noBatchRecord = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--for", "batch:whatever"], { encoding: "utf8" });
    expect(noBatchRecord.status).toBe(2);
    expect(noBatchRecord.stderr).toContain("needs --record");
    // A subject that names nothing is a hard error, not a silent empty
    // expansion: a run that thinks it saw the relevant area and saw nothing is
    // worse than a run that stops.
    const noArea = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--for", "area:nosuch"], { encoding: "utf8" });
    expect(noArea.status).toBe(2);
    expect(noArea.stderr).toContain("no area page named nosuch");
    const noTodo = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", dir, "--for", "todo:absent", "--record", recordFile(dir)],
      { encoding: "utf8" },
    );
    expect(noTodo.status).toBe(2);
    expect(noTodo.stderr).toContain("todo absent is not in the record");
  });

  it("says on header line 2 when an area matched with no categories: frontmatter", () => {
    const dir = contextFixture();
    const prelude = assembleFor(dir, "area:money");
    expect(prelude.expanded).toBe(EXPECTED.areaMoneyFallback.expanded);
  });

  it("refuses --for beside --layers, and --record without --for", () => {
    const dir = contextFixture();
    const both = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", dir, "--for", "laptop", "--layers", "write"],
      { encoding: "utf8" },
    );
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("mutually exclusive");
    const orphan = spawnSync(
      process.execPath,
      [SCRIPT, "--wikitom", dir, "--layers", "write", "--record", recordFile(dir)],
      { encoding: "utf8" },
    );
    expect(orphan.status).toBe(2);
    expect(orphan.stderr).toContain("--record needs --for");
  });
});

describe("collectRepoRules", () => {
  it("reads every AGENTS.md out of one immutable commit, sorted, with its bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-rules-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    for (const rule of CONTEXT_REPO_RULES) write(dir, rule.path, rule.body);
    write(dir, "convex/schema.ts", "not a rules file\n");
    write(dir, "docs/AGENTS.md", "   \n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rules");
    const collected = collectRepoRules({ dir, repo: "tom.quest" });
    expect(collected.commit).toBe(git(dir, "rev-parse", "HEAD").trim());
    // Sorted, blank ones dropped, and nothing that is not an AGENTS.md.
    expect(collected.rules.map((rule) => rule.path)).toEqual([
      "AGENTS.md", "app/AGENTS.md", "convex/AGENTS.md", "worker/AGENTS.md",
    ]);
    expect(collected.rules[0]).toEqual({
      repo: "tom.quest",
      path: "AGENTS.md",
      body: CONTEXT_REPO_RULES[0].body,
      bytes: Buffer.byteLength(CONTEXT_REPO_RULES[0].body),
    });
  });
});
