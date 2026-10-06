import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  decideMode,
  FULL,
  GRAPH_EXTENSIONS,
  groupResidentBytes,
  optionsOf,
  RELATED,
  runMeasured,
  skippedOf,
  slowestOf,
  WIDE_PATHS,
} from "./tests-affected.mjs";

const changed = (...paths) => paths.map((path) => ({ path, deleted: false }));

describe("tests-affected", () => {
  // The box's checks job sets the three in the environment and runs the
  // package.json script, where no argument crosses pnpm; the workflow passes
  // arguments. An argument wins over the variable, and an empty value of
  // either is null, never an empty left side for git diff.
  it("reads --base, --summary and --mode from the arguments, else from the environment", () => {
    expect(optionsOf(["--base", "abc", "--summary", "/s.json", "--mode", "full"], { TESTS_BASE: "env" }))
      .toEqual({ base: "abc", summaryPath: "/s.json", forced: "full" });
    expect(optionsOf([], { TESTS_BASE: "abc", TESTS_SUMMARY: "/s.json", TESTS_MODE: "full" }))
      .toEqual({ base: "abc", summaryPath: "/s.json", forced: "full" });
    // An argument given empty is the push event's "no base", not a fall-through.
    expect(optionsOf(["--base", ""], { TESTS_BASE: "abc" })).toEqual({ base: null, summaryPath: null, forced: null });
    expect(optionsOf([], { TESTS_BASE: " ", TESTS_MODE: "" })).toEqual({ base: null, summaryPath: null, forced: null });
    expect(optionsOf([], {})).toEqual({ base: null, summaryPath: null, forced: null });
  });

  it("runs only the related files when every change is one the graph follows", () => {
    const decision = decideMode(changed("convex/ttsMerge.ts", "app/jarvis/page.tsx"), { base: "abc" });
    expect(decision.mode).toBe(RELATED);
    expect(decision.files).toEqual(["convex/ttsMerge.ts", "app/jarvis/page.tsx"]);
    expect(decision.why).toBe("2 changed files, all in the module graph");
  });

  // The four falls back to the whole suite, each because the graph cannot
  // answer for the change. No test is ever dropped: the worst any of these can
  // do is run more than it had to.
  it("runs everything when there is no base to diff against", () => {
    expect(decideMode(changed("convex/ttsMerge.ts"), { base: null })).toEqual({
      mode: FULL,
      why: "no merge base, so the diff is unknown",
      files: [],
    });
    expect(decideMode([], { base: "" }).mode).toBe(FULL);
  });

  it("runs everything when a file was deleted", () => {
    const decision = decideMode(
      [{ path: "convex/old.ts", deleted: true }, { path: "convex/new.ts", deleted: false }],
      { base: "abc" },
    );
    expect(decision.mode).toBe(FULL);
    expect(decision.why).toContain("convex/old.ts");
  });

  it("runs everything when a file no test imports and every test depends on changes", () => {
    for (const wide of WIDE_PATHS) {
      const decision = decideMode(changed("convex/ttsMerge.ts", wide), { base: "abc" });
      expect(decision.mode).toBe(FULL);
      expect(decision.why).toContain(wide);
    }
  });

  // The rule that keeps the yaml, the markdown and the lockfile honest: a test
  // reads vqc/todos.yaml and an AGENTS.md off the disk, and no import graph has
  // ever seen that edge.
  it("runs everything when a changed file is read off disk rather than imported", () => {
    for (const path of ["vqc/todos.yaml", "AGENTS.md", "package.json", "pnpm-lock.yaml", "sg/baseline.tsv", ".github/workflows/guardrails.yml"]) {
      const decision = decideMode(changed("convex/ttsMerge.ts", path), { base: "abc" });
      expect(decision.mode, path).toBe(FULL);
      expect(decision.why).toContain(path);
      expect(GRAPH_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))).toBe(false);
    }
  });

  it("answers related with nothing to run for an empty diff", () => {
    expect(decideMode([], { base: "abc" })).toEqual({
      mode: RELATED,
      why: "0 changed files, all in the module graph",
      files: [],
    });
  });

  // The same three questions vitest's own --changed asks, so the mode is
  // chosen from the file list the run is actually built on.
  it("unions the committed diff, the staged files and the unstaged ones, once each", () => {
    const asked = [];
    const rows = changedFiles("base", (args) => {
      asked.push(args.join(" "));
      if (args[1] === "--name-status") return "M\tconvex/ttsMerge.ts\nD\tconvex/gone.ts\nR100\tscripts/old.mjs\tscripts/new.mjs\n\n";
      if (args[1] === "--cached") return "A\tconvex/ttsMerge.ts\nM\tapp/jarvis/page.tsx\n";
      return "package.json\nconvex/never-written.ts\n";
    });
    expect(asked).toEqual([
      "diff --name-status base...HEAD",
      "diff --cached --name-status",
      "ls-files --other --modified --exclude-standard",
    ]);
    expect(rows).toEqual([
      { path: "convex/ttsMerge.ts", deleted: false },
      { path: "convex/gone.ts", deleted: true },
      { path: "scripts/old.mjs", deleted: true },
      { path: "scripts/new.mjs", deleted: false },
      { path: "app/jarvis/page.tsx", deleted: false },
      // Present on disk, so a change; absent, so a deletion.
      { path: "package.json", deleted: false },
      { path: "convex/never-written.ts", deleted: true },
    ]);
  });

  // A RENAME IS A DELETION OF ITS OLD NAME. Before this, the old path was
  // dropped and a pure rename of an imported module ran in related mode.
  it("takes the whole suite when a diff renames or copies a file", () => {
    for (const status of ["R100", "C075"]) {
      const rows = changedFiles("base", (args) => {
        if (args[1] === "--name-status") return `${status}\tscripts/old.mjs\tscripts/new.mjs\n`;
        return "";
      });
      expect(rows).toEqual([
        { path: "scripts/old.mjs", deleted: true },
        { path: "scripts/new.mjs", deleted: false },
      ]);
      expect(decideMode(rows, { base: "base" })).toEqual({
        mode: FULL,
        why: "scripts/old.mjs was deleted, and the graph cannot name what imported it",
        files: [],
      });
    }
  });

  it("names the slowest files of a vitest report, in seconds, newest measure first", () => {
    const report = {
      testResults: [
        { name: `${process.cwd()}/convex/http.test.ts`, startTime: 0, endTime: 12_340 },
        { name: `${process.cwd()}/app/jarvis/page.test.tsx`, startTime: 100, endTime: 200 },
        { name: `${process.cwd()}/convex/tts.test.ts`, startTime: 0, endTime: 4_000 },
      ],
    };
    expect(slowestOf(report, 2)).toEqual([
      { file: "convex/http.test.ts", seconds: 12.3 },
      { file: "convex/tts.test.ts", seconds: 4 },
    ]);
    expect(slowestOf({}, 2)).toEqual([]);
  });

  it("counts the skipped and todo tests of a vitest report, and nothing for a report it cannot read", () => {
    expect(skippedOf({ numPendingTests: 3, numTodoTests: 2 })).toBe(5);
    expect(skippedOf({ numPendingTests: 0 })).toBe(0);
    expect(skippedOf({})).toBeNull();
  });

  it("sums the resident memory of one process group from a /proc tree", () => {
    const proc = mkdtempSync(path.join(tmpdir(), "tests-affected-proc-"));
    try {
      // Fields after the command: state, ppid, pgrp, session, 17 more, then rss
      // (field 24). The command holds a space and a parenthesis on purpose.
      const stat = (pid, pgrp, rssPages) =>
        `${pid} (node (vitest) w) S 1 ${pgrp} ${pgrp} ${Array(17).fill(0).join(" ")} ${rssPages} 0 0\n`;
      const write = (pid, text) => {
        mkdirSync(path.join(proc, String(pid)));
        writeFileSync(path.join(proc, String(pid), "stat"), text);
      };
      write(100, stat(100, 100, 10));
      write(101, stat(101, 100, 20));
      write(200, stat(200, 200, 1_000)); // another group: not counted
      mkdirSync(path.join(proc, "self")); // not a process number: skipped
      mkdirSync(path.join(proc, "102")); // exited before its stat was read
      expect(groupResidentBytes(100, { proc, pageBytes: 4096 })).toBe(30 * 4096);
      expect(groupResidentBytes(999, { proc })).toBe(0);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
    expect(groupResidentBytes(1, { proc: path.join(tmpdir(), "no-such-proc-dir") })).toBeNull();
  });

  it.runIf(process.platform === "linux")("measures a real command's exit and its group's peak memory", async () => {
    const ok = await runMeasured("sh", ["-c", "sleep 0.6"]);
    expect(ok.ok).toBe(true);
    expect(ok.peakBytes).toBeGreaterThan(0);
    expect((await runMeasured("sh", ["-c", "exit 3"])).ok).toBe(false);
  });
});
