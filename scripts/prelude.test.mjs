import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assemblePrelude, assemblePreludePublication, cutAreaSections, PRELUDE_BLOCKS } from "./prelude.mjs";
import { extractSections } from "../worker/jobs/markdown-sections.mjs";

const SCRIPT = path.resolve("scripts/prelude.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(dir, ...args) {
  return execFileSync("git", ["-c", `safe.directory=${fs.realpathSync.native(dir)}`, "-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

const REQUIRED_AREAS = PRELUDE_BLOCKS.know.areas.required;

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
  write(dir, "model-of-tom/priorities.md", "# Priorities\n\nResearch.\n");
  write(dir, "model-of-tom/schedule.md", "# Schedule\n\nTuesday.\n");
  for (const area of REQUIRED_AREAS) {
    write(dir, area, "## Current state\n\n- Present.\n\n## Must not break\n\n- Safety.\n");
  }
  write(
    dir,
    "model-of-tom/areas/zebra.md",
    "# Zebra\n\n## Ideal state\n\nHidden.\n\n## Current state\n\n- Present.\n\n### Detail\n\n- Kept.\n\n## Must not break\n\n- Safety.\n\n## History\n\nDropped.\n",
  );
  write(dir, "model-of-tom/areas/alpha.md", "# Alpha\n\nCurrent state\n-------------\n\n- First.\n\n## Must not break\n\n- Also first.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

describe("prelude", () => {
  it("uses the shared markdown section cutter", () => {
    const area = "---\nname: area\n---\n\n## Current state\n\n- kept\n\n```md\n## Must not break\n\n- ignored\n```\n\n## Must not break\n\n- kept\n";
    expect(cutAreaSections(area)).toBe(extractSections(area, ["Current state", "Must not break"]));
  });

  it("assembles requested blocks in canonical order and cuts each area to its two sections", () => {
    const dir = fixture();
    const prelude = assemblePrelude({ wikitom: dir, blocks: "know,operate" });
    expect(Object.keys(prelude.blocks)).toEqual(["operate", "know"]);
    expect(prelude.files.map((file) => file.path)).toEqual([
      "model-of-tom/agent-rules.md",
      "model-of-tom/priorities.md",
      "model-of-tom/schedule.md",
      ...[...REQUIRED_AREAS, "model-of-tom/areas/alpha.md", "model-of-tom/areas/zebra.md"].sort(),
    ]);
    expect(prelude.text.split("\n")[0]).toBe(
      `MODEL-OF-TOM FILES (WikiTom commit ${prelude.commit}): ${prelude.files.map((file) => file.path).join(", ")}`,
    );
    expect(prelude.text.split("\n")[2]).toBe("── model-of-tom/agent-rules.md ──");
    const zebra = prelude.files.find((file) => file.path.endsWith("zebra.md")).body;
    expect(zebra).toContain("## Current state");
    expect(zebra).toContain("### Detail");
    expect(zebra).toContain("## Must not break");
    expect(zebra).not.toContain("Ideal state");
    expect(zebra).not.toContain("History");
  });

  it("omits ground.md only until it is first committed", () => {
    const dir = fixture();
    const absent = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "write"], { encoding: "utf8" });
    expect(absent.status).toBe(0);
    expect(absent.stdout).not.toContain("ground.md");
    expect(absent.stderr).toContain("optional model-of-tom/ground.md is absent");

    const firstBlank = fixture();
    write(firstBlank, "model-of-tom/ground.md", " \n\t");
    git(firstBlank, "add", "-A");
    git(firstBlank, "commit", "-q", "-m", "first blank ground");
    const blankFirstAppearance = spawnSync(process.execPath, [SCRIPT, "--wikitom", firstBlank, "--blocks", "write"], { encoding: "utf8" });
    expect(blankFirstAppearance.status).toBe(2);
    expect(blankFirstAppearance.stderr).toContain("required model-of-tom/ground.md is blank");

    write(dir, "model-of-tom/ground.md", "# Ground\n\nNow present.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ground");
    const present = assemblePrelude({ wikitom: dir, blocks: "write" });
    expect(present.files.map((file) => file.path)).toEqual([
      "model-of-tom/writing.md",
      "model-of-tom/ground.md",
    ]);

    write(dir, "model-of-tom/ground.md", " \n\t");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "blank ground");
    const blank = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "write"], { encoding: "utf8" });
    expect(blank.status).toBe(2);
    expect(blank.stderr).toContain("required model-of-tom/ground.md is blank");

    git(dir, "rm", "model-of-tom/ground.md");
    git(dir, "commit", "-q", "-m", "delete ground");
    const deleted = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "write"], { encoding: "utf8" });
    expect(deleted.status).toBe(2);
    expect(deleted.stderr).toContain("required model-of-tom/ground.md is absent");
  });

  it("keeps raw area files as facts while blocks carry only their selected sections", () => {
    const dir = fixture();
    const publication = assemblePreludePublication({ wikitom: dir });
    const area = publication.files.find((file) => file.path === "model-of-tom/areas/zebra.md");
    expect(area.sourceBody).toContain("## Ideal state");
    expect(area.body).not.toContain("Ideal state");
    expect(area.bytes).toBe(Buffer.byteLength(area.sourceBody));
    expect(publication.blocks.know).not.toContain("Ideal state");
    expect(publication.headers).toHaveLength(7);
  });

  it("fails the CLI when any committed area lacks either required section", () => {
    const dir = fixture();
    write(dir, "model-of-tom/areas/alpha.md", "# Alpha\n\n## Current state\n\n- First.\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "missing area section");
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "know"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("model-of-tom/areas/alpha.md");
    expect(result.stderr).toContain('no "Must not break" section');
  });

  it("requires every named area and the areas directory", () => {
    const missingPage = fixture();
    git(missingPage, "rm", "model-of-tom/areas/admin.md");
    git(missingPage, "commit", "-q", "-m", "missing named area");
    const absentPage = spawnSync(process.execPath, [SCRIPT, "--wikitom", missingPage, "--blocks", "know"], { encoding: "utf8" });
    expect(absentPage.status).toBe(2);
    expect(absentPage.stderr).toContain("model-of-tom/areas/admin.md");

    const missingDirectory = fixture();
    git(missingDirectory, "rm", "-r", "model-of-tom/areas");
    git(missingDirectory, "commit", "-q", "-m", "missing areas");
    const absentDirectory = spawnSync(process.execPath, [SCRIPT, "--wikitom", missingDirectory, "--blocks", "know"], { encoding: "utf8" });
    expect(absentDirectory.status).toBe(2);
    expect(absentDirectory.stderr).toContain("model-of-tom/areas");
  });

  it("rejects blank required fixed files with their paths", () => {
    for (const [block, definition] of Object.entries(PRELUDE_BLOCKS)) {
      for (const entry of definition.files.filter((file) => !file.optionalUntilPresent)) {
        const dir = fixture();
        write(dir, entry.path, " \n\t");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "blank required file");
        const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", block], { encoding: "utf8" });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`required ${entry.path} is blank`);
      }
    }
  });

  it("accepts a sandbox-owned checkout through a per-command safe-directory setting", () => {
    const dir = fixture();
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "operate"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    expect(result.status).toBe(0);
  });

  it("fails with exit 2 and the missing required path", () => {
    const dir = fixture();
    git(dir, "rm", "model-of-tom/priorities.md");
    git(dir, "commit", "-q", "-m", "missing priorities");
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--blocks", "know"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("model-of-tom/priorities.md");
  });

  it("renders commit metadata, pushed state, and byte metadata as JSON", () => {
    const dir = fixture({ ground: true });
    const commit = git(dir, "rev-parse", "HEAD").trim();
    const result = spawnSync(process.execPath, [SCRIPT, "--wikitom", dir, "--commit", commit, "--blocks", "write", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json)).toEqual(["commit", "committedAt", "pushed", "blocks", "files"]);
    expect(json).toMatchObject({ commit, committedAt: expect.any(Number), pushed: false });
    expect(Object.keys(json.blocks)).toEqual(["write"]);
    expect(json.files).toEqual([
      { path: "model-of-tom/writing.md", bytes: Buffer.byteLength("# Writing\n\nBe plain.\n") },
      { path: "model-of-tom/ground.md", bytes: Buffer.byteLength("# Ground\n\nStart here.\n") },
    ]);
  });
});
