import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assemblePrelude, assemblePreludePublication, PRELUDE_LAYERS } from "./prelude.mjs";

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
