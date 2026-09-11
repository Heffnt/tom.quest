import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clip,
  graduationsFrom,
  loadItems,
  parseArgs,
  rewrite,
  runFrom,
  summarise,
} from "./graduate-golden.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "graduate-golden.mjs");
const FINISHED_AT = Date.UTC(2026, 8, 5, 8, 30);
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A run item as phase 7 files it. The field order matters to one of the tests
 *  below — the rewrite must not reorder what it copies through. */
const item = (over = {}) => ({
  id: "run-ruling-k97x2m4bq1zp",
  job: "run",
  partition: "runs/planner",
  kind: "capability",
  verdict: "revise",
  confirmedByTom: true,
  trials: 3,
  labelId: "k17label000",
  labelSource: "ruling",
  runId: "k17run00000",
  at: 1757000000000,
  intentKey: "planner/brief",
  input: {
    preludeKnown: true,
    preludeNames: { layers: ["write", "know"], skills: [] },
    task: "plan the week",
    prompt: null,
    contextRowSeq: 0,
    spanSeqs: [412, 412],
  },
  expected: {
    rubric: "This plans around the batch I archived on Tuesday and says nothing about why.",
    target: null,
  },
  output: { text: "The week's plan, as it was written." },
  ...over,
});

/** A weekly run row carrying the per-case results a graduation reads. */
const run = (results, over = {}) => ({
  repo: "tom.quest",
  sha: "0123456789abcdef",
  weekly: true,
  startedAt: FINISHED_AT - 3_600_000,
  finishedAt: FINISHED_AT,
  results,
  failures: [],
  ...over,
});

/** A golden directory on disk, laid out the way evals/golden/runs/ is. */
function fixture(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graduate-golden-"));
  dirs.push(dir);
  const golden = path.join(dir, "evals", "golden");
  fs.mkdirSync(path.join(golden, "runs"), { recursive: true });
  for (const one of items) {
    fs.writeFileSync(path.join(golden, "runs", `${one.id}.json`), `${JSON.stringify(one, null, 2)}\n`);
  }
  return { dir, golden, file: (id) => path.join(golden, "runs", `${id}.json`) };
}

/** The script as the weekly job runs it: a row from a file, so no network and
 *  no credential in the environment. */
function runScript(golden, row, ...flags) {
  const file = path.join(path.dirname(path.dirname(golden)), "row.json");
  fs.writeFileSync(file, JSON.stringify(row));
  return execFileSync(process.execPath, [SCRIPT, "--run", file, "--golden", golden, ...flags], {
    encoding: "utf8",
    env: { ...process.env, CONVEX_SITE_URL: "", TTS_WORKER_KEY: "" },
  });
}

const records = (...items) => items.map((one) => ({ file: `${one.id}.json`, item: one }));

describe("graduationsFrom", () => {
  it("graduates a capability case that passed every trial of a weekly run", () => {
    const result = graduationsFrom(run([{ id: item().id, judged: "pass", passK: true }]), records(item()));
    expect(result.refusal).toBeNull();
    expect(result.graduated).toHaveLength(1);
    expect(result.graduated[0].id).toBe("run-ruling-k97x2m4bq1zp");
    expect(result.graduated[0].item.kind).toBe("regression");
    expect(result.graduated[0].item.graduatedAt).toBe(FINISHED_AT);
    expect(result.graduated[0].sentence).toBe(item().expected.rubric);
    expect({ skipped: result.skipped, untouched: result.untouched }).toEqual({ skipped: [], untouched: 0 });
  });

  it("leaves a case whose passK is false alone and counts it skipped", () => {
    const result = graduationsFrom(run([{ id: item().id, judged: "pass", passK: false }]), records(item()));
    expect(result.graduated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].why).toContain("passK false");
  });

  it("refuses a case whose passK is absent, and names the reason", () => {
    // judged "pass" and no passK: the gate passed it on one trial of three, and
    // one trial is exactly what a graduation may not rest on.
    const result = graduationsFrom(run([{ id: item().id, judged: "pass" }]), records(item()));
    expect(result.graduated).toEqual([]);
    expect(result.skipped[0].why).toBe(
      "passK absent — the row does not say whether every trial passed, and a case graduates on every trial, not on one",
    );
  });

  it("counts a case that is already a regression as untouched and rewrites nothing", () => {
    const already = item({ kind: "regression", graduatedAt: FINISHED_AT - 86_400_000 });
    const result = graduationsFrom(run([{ id: already.id, judged: "pass", passK: true }]), records(already));
    expect({ graduated: result.graduated, skipped: result.skipped, untouched: result.untouched })
      .toEqual({ graduated: [], skipped: [], untouched: 1 });
  });

  it("counts an item with no kind nowhere at all", () => {
    // The rulings items (scripts/export-golden.mjs) predate the field and the
    // whole lifecycle; they are not part of this question.
    const older = { id: "prepare-chores-k17abc123def", partition: "prepare/chores", verdict: "approve" };
    const result = graduationsFrom(run([{ id: older.id, judged: "pass", passK: true }]), records(older));
    expect(result).toMatchObject({ graduated: [], skipped: [], untouched: 0 });
  });

  it("skips a capability case this run never scored", () => {
    const result = graduationsFrom(run([]), records(item()));
    expect(result.skipped).toEqual([{ id: item().id, why: "not scored by this run" }]);
  });

  it("graduates nothing off a pull-request row and says why", () => {
    const result = graduationsFrom(
      run([{ id: item().id, judged: "pass", passK: true }], { weekly: false }),
      records(item()),
    );
    expect(result).toMatchObject({ graduated: [], skipped: [], untouched: 0 });
    expect(result.refusal).toBe(
      "the row's weekly is false, and only a weekly run graduates a case — a pull-request run scores a " +
      "40-item subset against one branch's tree, so a case promoted on that evidence would let one branch " +
      "raise the bar for main. Absent is a value and is never inferred.",
    );
  });

  it("refuses a row whose weekly is absent rather than reading it as weekly", () => {
    const row = run([{ id: item().id, judged: "pass", passK: true }]);
    delete row.weekly;
    const result = graduationsFrom(row, records(item()));
    expect(result.graduated).toEqual([]);
    expect(result.refusal).toContain("the row's weekly is absent");
  });

  it("refuses a weekly row with no finishedAt to stamp and no per-case results to read", () => {
    const noStamp = run([{ id: item().id, passK: true }], { finishedAt: null });
    expect(graduationsFrom(noStamp, records(item())).refusal).toContain("no finishedAt");
    const noResults = run([], {});
    delete noResults.results;
    expect(graduationsFrom(noResults, records(item())).refusal).toContain("no per-case results");
    expect(graduationsFrom(null, records(item())).refusal).toContain("no run row");
  });
});

describe("rewrite", () => {
  it("changes kind and graduatedAt and nothing else, field for field", () => {
    const before = item();
    const after = rewrite(before, FINISHED_AT);
    expect(after.kind).toBe("regression");
    expect(after.graduatedAt).toBe(FINISHED_AT);
    // Round-tripped, so this compares the JSON both readers would see, not two
    // object graphs that happen to share references.
    const strip = (one) => {
      const copy = JSON.parse(JSON.stringify(one));
      delete copy.kind;
      delete copy.graduatedAt;
      return copy;
    };
    expect(strip(after)).toEqual(strip(before));
    // `verdict` is the compatibility shim three readers in worker/jobs/
    // evals.mjs still use; a graduation does not touch it.
    expect(after.verdict).toBe("revise");
    // Key order is preserved: kind is rewritten where it stood and graduatedAt
    // is the one new key, at the end.
    expect(Object.keys(after)).toEqual([...Object.keys(before), "graduatedAt"]);
  });
});

describe("the script on disk", () => {
  it("rewrites the file, prints the summary, and is a no-op the second time", () => {
    const { golden, file } = fixture([item()]);
    const row = run([{ id: item().id, judged: "pass", passK: true }]);
    const first = runScript(golden, row, "--list");
    expect(first).toContain("run-ruling-k97x2m4bq1zp\truns/planner\tThis plans around the batch");
    expect(first.trim().split("\n").pop())
      .toBe("graduation: 1 capability cases graduated, 0 still failing, 0 untouched.");
    const written = JSON.parse(fs.readFileSync(file(item().id), "utf8"));
    expect(written.kind).toBe("regression");
    expect(written.graduatedAt).toBe(FINISHED_AT);
    expect(Object.keys(written)).toEqual([...Object.keys(item()), "graduatedAt"]);

    const bytes = fs.readFileSync(file(item().id));
    const second = runScript(golden, row);
    expect(second.trim())
      .toBe("graduation: 0 capability cases graduated, 0 still failing, 1 untouched.");
    expect(fs.readFileSync(file(item().id))).toEqual(bytes);
  });

  it("writes no file under --dry-run", () => {
    const { golden, file } = fixture([item()]);
    const bytes = fs.readFileSync(file(item().id));
    const out = runScript(golden, run([{ id: item().id, judged: "pass", passK: true }]), "--dry-run", "--list");
    expect(out).toContain("graduation: 1 capability cases graduated");
    expect(fs.readFileSync(file(item().id))).toEqual(bytes);
  });

  it("exits 2 on a pull-request row and leaves every file alone", () => {
    const { golden, file } = fixture([item()]);
    const bytes = fs.readFileSync(file(item().id));
    let failure = null;
    try {
      runScript(golden, run([{ id: item().id, judged: "pass", passK: true }], { weekly: false }));
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(2);
    expect(String(failure?.stderr)).toContain("only a weekly run graduates a case");
    expect(String(failure?.stdout).trim())
      .toBe("graduation: 0 capability cases graduated, 0 still failing, 0 untouched.");
    expect(fs.readFileSync(file(item().id))).toEqual(bytes);
  });

  it("finds items in evals/golden and one level below it", () => {
    const { golden } = fixture([item(), item({ id: "run-ruling-second00000" })]);
    fs.writeFileSync(path.join(golden, "loose.json"), `${JSON.stringify(item({ id: "aaa-loose" }), null, 2)}\n`);
    const found = loadItems(golden);
    expect(found.map((record) => record.item.id))
      .toEqual(["aaa-loose", "run-ruling-k97x2m4bq1zp", "run-ruling-second00000"]);
    expect(found.every((record) => fs.existsSync(record.file))).toBe(true);
    expect(loadItems(path.join(golden, "nothing-here"))).toEqual([]);
  });
});

describe("parseArgs, runFrom and the summary line", () => {
  it("defaults the golden directory and takes the two sources apart", () => {
    expect(parseArgs(["--run", "row.json"]))
      .toEqual({ run: "row.json", golden: "evals/golden", repo: null, sha: null, dryRun: false, list: false });
    expect(parseArgs(["--repo", "tom.quest", "--sha", "abc123", "--dry-run", "--list"]))
      .toMatchObject({ repo: "tom.quest", sha: "abc123", dryRun: true, list: true });
    expect(() => parseArgs(["--run", "row.json", "--repo", "tom.quest"])).toThrow(/one or the other/);
    expect(() => parseArgs(["--repo", "tom.quest"])).toThrow(/is required/);
    expect(() => parseArgs(["--run", "--list"])).toThrow(/--run needs a value/);
    expect(() => parseArgs(["--weekly"])).toThrow(/unknown argument --weekly/);
  });

  it("unwraps the route's envelope and takes a bare row as it stands", () => {
    const row = run([]);
    expect(runFrom({ run: row, base: null })).toBe(row);
    expect(runFrom(row)).toBe(row);
    // `{ run: null }` means "there is no such run", and it reads as null rather
    // than as the envelope around it.
    expect(runFrom({ run: null, base: null })).toBeNull();
  });

  it("keeps a rubric to one clipped line", () => {
    expect(clip("two\nlines about one\tthing")).toBe("two lines about one thing");
    expect(clip("x".repeat(200))).toHaveLength(80);
    expect(summarise({ graduated: [1, 2], skipped: [1], untouched: 7 }))
      .toBe("graduation: 2 capability cases graduated, 1 still failing, 7 untouched.");
  });
});
