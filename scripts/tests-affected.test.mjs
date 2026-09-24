import { describe, expect, it } from "vitest";
import {
  changedFiles,
  decideMode,
  FULL,
  GRAPH_EXTENSIONS,
  RELATED,
  slowestOf,
  WIDE_PATHS,
} from "./tests-affected.mjs";

const changed = (...paths) => paths.map((path) => ({ path, deleted: false }));

describe("tests-affected", () => {
  it("runs only the related files when every change is one the graph follows", () => {
    const decision = decideMode(changed("convex/ttsMerge.ts", "app/tts/page.tsx"), { base: "abc" });
    expect(decision.mode).toBe(RELATED);
    expect(decision.files).toEqual(["convex/ttsMerge.ts", "app/tts/page.tsx"]);
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
    for (const path of ["vqc/todos.yaml", "AGENTS.md", "package.json", "pnpm-lock.yaml", "sg/baseline.tsv", "worker/setup.sh"]) {
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
      if (args[1] === "--cached") return "A\tconvex/ttsMerge.ts\nM\tapp/tts/page.tsx\n";
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
      { path: "scripts/new.mjs", deleted: false },
      { path: "app/tts/page.tsx", deleted: false },
      // Present on disk, so a change; absent, so a deletion.
      { path: "package.json", deleted: false },
      { path: "convex/never-written.ts", deleted: true },
    ]);
  });

  it("names the slowest files of a vitest report, in seconds, newest measure first", () => {
    const report = {
      testResults: [
        { name: `${process.cwd()}/convex/http.test.ts`, startTime: 0, endTime: 12_340 },
        { name: `${process.cwd()}/app/tts/page.test.tsx`, startTime: 100, endTime: 200 },
        { name: `${process.cwd()}/convex/tts.test.ts`, startTime: 0, endTime: 4_000 },
      ],
    };
    expect(slowestOf(report, 2)).toEqual([
      { file: "convex/http.test.ts", seconds: 12.3 },
      { file: "convex/tts.test.ts", seconds: 4 },
    ]);
    expect(slowestOf({}, 2)).toEqual([]);
  });
});
