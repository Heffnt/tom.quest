// The AGENTS.md chain threshold warns and never fails (Tom, 2026-09-22). The
// script checks the directory it runs in, so each test builds a small git
// checkout and runs the script there.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/temp.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-agents-md.mjs");

/** A checkout holding a root AGENTS.md and one nested under app/, each with
 *  its CLAUDE.md, every CLAUDE.md in the git index. */
function checkout(rootBytes, appBytes) {
  const dir = tempDir("check-agents-md-");
  // Distinct ten-byte lines, so the duplicated-sentence check has nothing to find.
  const body = (tag, bytes) =>
    Array.from({ length: Math.ceil(bytes / 10) }, (_, i) => `${tag}${String(i).padStart(8, "0")}\n`)
      .join("")
      .slice(0, bytes);
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), body("r", rootBytes));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");
  fs.writeFileSync(path.join(dir, "app", "AGENTS.md"), body("a", appBytes));
  fs.writeFileSync(path.join(dir, "app", "CLAUDE.md"), "@AGENTS.md\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}

describe("the AGENTS.md chain threshold", () => {
  it("warns past 32,768 bytes, naming the size, the threshold and the largest file, and passes", () => {
    const result = run(checkout(3000, 31000));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "the AGENTS chain AGENTS.md -> app/AGENTS.md is 34000 bytes, over the 32768-byte threshold; its largest file is app/AGENTS.md at 31000 bytes.",
    );
    expect(result.stdout).toContain("AGENTS.md check passed");
  });

  it("says nothing of the threshold under it", () => {
    const result = run(checkout(3000, 3000));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("threshold");
  });
});
