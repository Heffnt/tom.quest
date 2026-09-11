import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGoldenSet,
  buildItem,
  buildRunCase,
  buildRunGoldenSet,
  dedupeByIntent,
  goldenId,
  intentKeyOf,
  outputTextOf,
  preludeTextFor,
  priorReviseSentence,
  runGoldenId,
  snapshotAt,
  snapshotCommitAt,
  snapshotRows,
  splitPrelude,
  summariseRuns,
} from "./export-golden.mjs";

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false"];
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir, at, ...args) {
  const stamp = new Date(at).toISOString();
  return execFileSync("git", ["-c", `safe.directory=${fs.realpathSync.native(dir)}`, "-C", dir, ...IDENTITY, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
}

const DAY = 86_400_000;
const T1 = Date.UTC(2026, 8, 1, 12);
const T2 = Date.UTC(2026, 8, 3, 12);

/** A WikiTom-shaped checkout with two snapshot commits of one table. */
function fixture(rowsAtT1, rowsAtT2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-golden-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const file = path.join(dir, "tts", "snapshot", "dtsTodos.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (rows, at) => {
    fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    git(dir, at, "add", "-A");
    git(dir, at, "commit", "-q", "--allow-empty", "-m", `snapshot ${new Date(at).toISOString()}`);
  };
  write(rowsAtT1, T1);
  write(rowsAtT2, T2);
  return dir;
}

const candidate = (over = {}) => ({
  rulingId: "k17abc123def456",
  ruledAt: T2 - DAY,
  appliedAt: T2 - DAY,
  verdict: "revise",
  sentence: "This tells me nothing I did not already know from the statement.",
  job: "prepare",
  partition: "prepare/chores",
  subject: { type: "life", todoId: "ph79" },
  resolution: {
    table: "dtsTodos",
    rowId: "ph79",
    input: { statement: "sort out the bike lock", source: "slack-capture", provenance: null, category: "chores", createdAt: T1 },
  },
  ...over,
});

const row = (over = {}) => ({
  _id: "ph79",
  statement: "sort out the bike lock",
  source: "slack-capture",
  category: "chores",
  createdAt: T1,
  brief: "The old lock is seized.",
  entryAction: "Open the bike shop page",
  workDescription: "a two-minute errand",
  groundUpExplanation: "<!DOCTYPE html><html>the old one</html>",
  ...over,
});

function readSnapshotFrom(dir) {
  return (table, at) => {
    const sha = snapshotCommitAt(dir, at);
    return sha === null ? null : { sha, rows: snapshotRows(dir, sha, table) };
  };
}

describe("snapshotAt", () => {
  it("reads the commit before the ruling, not the newest one", () => {
    const dir = fixture([row()], [row({ brief: "rewritten after the ruling" })]);
    const before = snapshotAt(dir, "tts/snapshot/dtsTodos.jsonl", T2 - DAY);
    expect(before.text).toContain("The old lock is seized.");
    expect(before.text).not.toContain("rewritten after the ruling");
    const after = snapshotAt(dir, "tts/snapshot/dtsTodos.jsonl", T2 + DAY);
    expect(after.text).toContain("rewritten after the ruling");
    expect(after.sha).not.toBe(before.sha);
  });

  it("returns null for an instant before any snapshot commit", () => {
    const dir = fixture([row()], [row()]);
    expect(snapshotAt(dir, "tts/snapshot/dtsTodos.jsonl", T1 - DAY)).toBeNull();
  });
});

describe("priorReviseSentence", () => {
  it("is the earlier applied revise sentence, never the label ruling's own", () => {
    const label = candidate();
    const earlier = candidate({
      rulingId: "k00earlier0000",
      ruledAt: label.ruledAt - DAY,
      appliedAt: label.ruledAt - DAY,
      sentence: "Say what the lock actually is.",
    });
    const unapplied = candidate({
      rulingId: "k00pending0000",
      ruledAt: label.ruledAt - 2 * DAY,
      appliedAt: null,
      sentence: "Never seen by any run.",
    });
    const sentence = priorReviseSentence(label, [label, earlier, unapplied]);
    expect(sentence).toBe("Say what the lock actually is.");
    expect(sentence).not.toBe(label.sentence);
  });

  it("is null when the only earlier ruling was on another subject", () => {
    const label = candidate();
    const other = candidate({
      rulingId: "k00other00000",
      ruledAt: label.ruledAt - DAY,
      subject: { type: "life", todoId: "ph80" },
      sentence: "About a different todo.",
    });
    expect(priorReviseSentence(label, [label, other])).toBeNull();
  });
});

describe("buildGoldenSet", () => {
  it("writes an item field for field, with the label sentence outside the input", () => {
    const dir = fixture([row()], [row({ brief: "rewritten after the ruling" })]);
    const label = candidate();
    const earlier = candidate({ rulingId: "k00earlier0000", ruledAt: label.ruledAt - DAY, appliedAt: label.ruledAt - DAY, sentence: "Say what the lock is." });
    const { items, unbuildable, redacted } = buildGoldenSet([label, earlier], readSnapshotFrom(dir));
    expect({ unbuildable, redacted }).toEqual({ unbuildable: 0, redacted: 0 });
    const item = items.find((entry) => entry.rulingId === label.rulingId);
    expect(Object.keys(item).sort()).toEqual([
      "id", "input", "job", "output", "partition", "ruledAt", "ruledOn", "rulingId", "sentence", "snapshot", "subject", "verdict",
    ].sort());
    expect(item.id).toBe(goldenId(label));
    expect(item.id).toBe("prepare-chores-k17abc123def");
    expect(item.output).toEqual({
      brief: "The old lock is seized.",
      entryAction: "Open the bike shop page",
      workDescription: "a two-minute errand",
      groundUpExplanation: "<!DOCTYPE html><html>the old one</html>",
    });
    expect(item.input.priorReviseSentence).toBe("Say what the lock is.");
    expect(item.input.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(item.input)).not.toContain(label.sentence);
    expect(item.snapshot.path).toBe("tts/snapshot/dtsTodos.jsonl");
  });

  it("counts a ruling with no snapshot behind it as unbuildable and writes nothing", () => {
    const dir = fixture([row()], [row()]);
    const result = buildGoldenSet([candidate({ ruledAt: T1 - DAY })], readSnapshotFrom(dir));
    expect(result).toMatchObject({ items: [], unbuildable: 1, redacted: 0 });
  });

  it("counts a ruling whose row is absent from the snapshot as unbuildable", () => {
    const dir = fixture([row({ _id: "someone-else" })], [row({ _id: "someone-else" })]);
    expect(buildGoldenSet([candidate()], readSnapshotFrom(dir))).toMatchObject({ items: [], unbuildable: 1 });
  });

  it("drops an item whose text redactSecrets would change, and says so in the count", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const dir = fixture([row({ brief: `The shop replied with ${token} by mistake.` })], [row()]);
    const result = buildGoldenSet([candidate()], readSnapshotFrom(dir));
    expect(result).toMatchObject({ items: [], unbuildable: 0, redacted: 1 });
  });

  it("takes the input as it stood at the snapshot, not as it stands now", () => {
    const dir = fixture([row({ statement: "the statement as it was" })], [row({ statement: "edited since" })]);
    const [item] = buildGoldenSet([candidate()], readSnapshotFrom(dir)).items;
    expect(item.input.statement).toBe("the statement as it was");
  });

  it("reads one table's rows at a commit and ignores every other table", () => {
    const dir = fixture([row()], [row()]);
    const sha = snapshotCommitAt(dir, T2 + DAY);
    expect(snapshotRows(dir, sha, "dtsTodos").get("ph79").statement).toBe("sort out the bike lock");
    expect(snapshotRows(dir, sha, "dtsCodeBriefs").size).toBe(0);
  });

  it("returns null from buildItem for a job it has no table for", () => {
    const dir = fixture([row()], [row()]);
    const sha = snapshotCommitAt(dir, T2 + DAY);
    const snapshot = { sha, rows: snapshotRows(dir, sha, "dtsTodos") };
    expect(buildItem(candidate({ job: "not-a-job" }), snapshot, [])).toBeNull();
  });
});

// ── The labels source ───────────────────────────────────────────────────────

const PRELUDE = "MODEL-OF-TOM FILES (WikiTom commit abc123): model-of-tom/agent-rules.md\n\n" +
  "── model-of-tom/agent-rules.md ──\nYou work for Tom.";
const TASK = "Prepare the todo below.\n\nstatement: sort out the bike lock\n";

const label = (over = {}) => ({
  labelId: "k97x2m4bq1zp8v",
  at: T2,
  source: "ruling",
  polarity: "bad",
  meaning: "This tells me nothing I did not already know from the statement.",
  ref: "ruling:k17abc123def456",
  run: {
    runId: "run-1",
    origin: "planner",
    kind: "worker",
    model: "sonnet",
    context: {
      layersKnown: true,
      layersGiven: ["operate", "write"],
      layersDenied: [],
      skillsUsed: [],
      wikitomCommit: "abc123",
      prompt: PRELUDE + "\n" + TASK,
    },
    outcome: { finalTextSeq: 412, turns: 6, totals: {} },
  },
  rows: {
    contextRow: { seq: 0, content: { prompt: PRELUDE + "\n" + TASK } },
    spanRows: [{ seq: 412, kind: "assistant-text", content: { text: "The old lock is seized." } }],
  },
  link: { todoId: "ph79", batchId: null, subjectKey: "life ph79" },
  ...over,
});

/** The seam the runner drives: the layer text this run's names assemble to. */
const assembles = (text) => () => ({ text });
const refuses = (reason) => () => ({ reason });

describe("splitPrelude", () => {
  it("splits on exactly the newline the runner puts back", () => {
    const prompt = PRELUDE + "\n" + TASK;
    const split = splitPrelude(prompt, PRELUDE);
    expect(split).toEqual({ preludeKnown: true, task: TASK });
    // The invariant that makes the split safe: worker/jobs/evals.mjs rebuilds
    // the prompt as prelude + newline + task, and that must be the original bytes.
    expect(PRELUDE + "\n" + split.task).toBe(prompt);
  });

  it("keeps a blank line that belonged to the task", () => {
    const prompt = PRELUDE + "\n\n" + TASK;
    const split = splitPrelude(prompt, PRELUDE);
    expect(split.task).toBe("\n" + TASK);
    expect(PRELUDE + "\n" + split.task).toBe(prompt);
  });

  it("refuses a prefix that is not followed by the seam newline", () => {
    expect(splitPrelude(PRELUDE + " " + TASK, PRELUDE)).toBeNull();
    expect(splitPrelude("something else\n" + TASK, PRELUDE)).toBeNull();
    expect(splitPrelude(PRELUDE + "\n" + TASK, "")).toBeNull();
  });
});

describe("preludeTextFor", () => {
  it("assembles the run's own layers at the run's own commit", () => {
    const seen = [];
    const assemble = (args) => {
      seen.push(args);
      return { text: PRELUDE };
    };
    expect(preludeTextFor("/wikitom", label().run.context, assemble)).toEqual({ text: PRELUDE });
    expect(seen).toEqual([{ wikitom: "/wikitom", commit: "abc123", layers: ["operate", "write"] }]);
  });

  it("names a reason rather than guessing, for each thing it cannot rebuild", () => {
    const context = label().run.context;
    const boom = () => { throw new Error("cannot resolve commit abc123"); };
    expect(preludeTextFor("/w", { ...context, layersKnown: false }).reason).toMatch(/no layer selection/);
    expect(preludeTextFor("/w", { ...context, layersGiven: [] }).reason).toMatch(/no layers/);
    expect(preludeTextFor("/w", { ...context, skillsUsed: ["codex"] }).reason).toMatch(/skills/);
    expect(preludeTextFor("/w", { ...context, wikitomCommit: "" }).reason).toMatch(/no WikiTom commit/);
    expect(preludeTextFor("/w", context, boom).reason).toMatch(/cannot resolve commit/);
  });
});

describe("buildRunCase", () => {
  it("derives kind, verdict and trials from the polarity, both ways", () => {
    const bad = buildRunCase(label(), assembles(PRELUDE)).item;
    expect([bad.kind, bad.verdict, bad.trials]).toEqual(["capability", "revise", 5]);
    expect(bad.expected.target).toBe(bad.expected.rubric);
    const good = buildRunCase(label({ polarity: "good", meaning: "Tom approved this output" }), assembles(PRELUDE)).item;
    expect([good.kind, good.verdict, good.trials]).toEqual(["regression", "approve", 3]);
    expect(good.expected.target).toBeNull();
  });

  it("writes the case with the prelude stripped and the names kept", () => {
    const { item, blindReason } = buildRunCase(label(), assembles(PRELUDE));
    expect(blindReason).toBeNull();
    expect(item.job).toBe("run");
    expect(item.partition).toBe("runs/planner");
    expect(item.confirmedByTom).toBe(true);
    expect(item.negative).toBe(false);
    expect(item.input.preludeKnown).toBe(true);
    expect(item.input.task).toBe(TASK);
    expect(item.input.prompt).toBeNull();
    expect(item.input.preludeNames).toEqual({ layers: ["operate", "write"], skills: [] });
    expect(item.input.contextRowSeq).toBe(0);
    expect(item.input.spanSeqs).toEqual([412, 412]);
    expect(item.intentKey).toBe("life ph79|planner:worker");
    expect(item.output.text).toBe("The old lock is seized.");
  });

  it("keeps the whole prompt verbatim and counts the case blind when no split can be made", () => {
    const prompt = "a laptop terminal's prompt, with no recorded prefix";
    const blind = label({
      run: { ...label().run, context: { layersKnown: false, layersGiven: [], skillsUsed: [], prompt } },
      rows: { contextRow: { seq: 0, content: { prompt } }, spanRows: label().rows.spanRows },
    });
    const { item, blindReason } = buildRunCase(blind, refuses("the run recorded no layer selection"));
    expect(blindReason).toBe("the run recorded no layer selection");
    expect(item.input.preludeKnown).toBe(false);
    expect(item.input.prompt).toBe(prompt);
    expect(item.input.task).toBeNull();
  });

  it("never lets the rubric reach the input, anywhere in it", () => {
    const { item } = buildRunCase(label(), assembles(PRELUDE));
    const seen = [];
    const walk = (value) => {
      if (typeof value === "string") seen.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(item.input);
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) expect(text).not.toContain(item.expected.rubric);
    expect(JSON.stringify(item.input)).not.toContain(item.expected.rubric);
  });

  it("says why a label is unbuildable rather than throwing on it", () => {
    expect(buildRunCase(label({ run: null }), assembles(PRELUDE)).unbuildable).toMatch(/named no run/);
    expect(buildRunCase(label({ polarity: "neutral" }), assembles(PRELUDE)).unbuildable).toMatch(/no direction/);
    expect(buildRunCase(label({ meaning: "  " }), assembles(PRELUDE)).unbuildable).toMatch(/no sentence/);
    const noText = label({ rows: { contextRow: label().rows.contextRow, spanRows: [] } });
    expect(buildRunCase(noText, assembles(PRELUDE)).unbuildable).toMatch(/no text to judge/);
    const noPrompt = label({
      run: { ...label().run, context: { layersKnown: false, layersGiven: [], skillsUsed: [] } },
      rows: { contextRow: null, spanRows: label().rows.spanRows },
    });
    expect(buildRunCase(noPrompt, assembles(PRELUDE)).unbuildable).toMatch(/neither a prompt nor a prelude/);
  });

  it("joins the span rows' text and ignores a row carrying none", () => {
    expect(outputTextOf({ spanRows: [
      { seq: 1, content: { text: "first turn" } },
      { seq: 2, content: {} },
      { seq: 3, content: { text: "second turn" } },
    ] })).toBe("first turn\n\nsecond turn");
  });

  it("gives an id that is filename-safe and the same for the same label twice", () => {
    const once = buildRunCase(label(), assembles(PRELUDE)).item.id;
    const twice = buildRunCase(label(), assembles(PRELUDE)).item.id;
    expect(once).toBe(twice);
    expect(once).toBe("run-ruling-k97x2m4bq1zp");
    expect(once).toMatch(/^[a-z0-9-]+$/);
    expect(runGoldenId({ source: "digest-reaction", labelId: "K9_7X/2m4bq1zp" })).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("dedupeByIntent", () => {
  it("keeps the newest label on one intent and counts the rest", () => {
    const older = { id: "a", intentKey: "life ph79|planner:worker", at: T1 };
    const newer = { id: "b", intentKey: "life ph79|planner:worker", at: T2 };
    const other = { id: "c", intentKey: "life ph80|planner:worker", at: T1 };
    const { items, superseded } = dedupeByIntent([older, newer, other]);
    expect(items.map((item) => item.id).sort()).toEqual(["b", "c"]);
    expect(superseded).toBe(1);
  });

  it("collapses two reactions on one morning and keeps a ruling of that day apart", () => {
    const morning = Date.UTC(2026, 8, 10, 13);
    const noon = Date.UTC(2026, 8, 10, 17);
    const reaction = (at) => label({
      at,
      source: "digest-reaction",
      polarity: "good",
      meaning: "Tom approved this output",
      link: { todoId: null, batchId: null, subjectKey: null },
    });
    const first = intentKeyOf(reaction(morning));
    const second = intentKeyOf(reaction(noon));
    expect(first).toBe(second);
    expect(first).toContain("digest:2026-09-10");
    const ruling = intentKeyOf(label({ at: noon }));
    expect(ruling).not.toBe(first);
    const built = [
      { id: "r1", intentKey: first, at: morning },
      { id: "r2", intentKey: second, at: noon },
      { id: "k1", intentKey: ruling, at: noon },
    ];
    expect(dedupeByIntent(built)).toMatchObject({ superseded: 1 });
  });
});

describe("buildRunGoldenSet", () => {
  it("drops a credential-shaped item whole and counts it apart from the unbuildable", () => {
    const token = "ghp_" + "a".repeat(36);
    const leaky = label({
      labelId: "k00leak000000",
      link: { todoId: "ph82", batchId: null, subjectKey: "life ph82" },
      rows: {
        contextRow: label().rows.contextRow,
        spanRows: [{ seq: 412, kind: "assistant-text", content: { text: "The shop replied with " + token + "." } }],
      },
    });
    const orphan = label({ labelId: "k00norun00000", run: null });
    const result = buildRunGoldenSet([label(), leaky, orphan], assembles(PRELUDE));
    expect(result.items).toHaveLength(1);
    expect(result.redacted).toBe(1);
    expect(result.unbuildable).toBe(1);
    expect([...result.unbuildableReasons.keys()][0]).toMatch(/named no run/);
  });

  it("counts the blind cases and says so in the summary line", () => {
    const prompt = "a laptop terminal's prompt";
    const blind = label({
      labelId: "k00blind00000",
      link: { todoId: "ph80", batchId: null, subjectKey: "life ph80" },
      run: { ...label().run, runId: "run-2", context: { layersKnown: false, layersGiven: [], skillsUsed: [], prompt } },
      rows: { contextRow: { seq: 0, content: { prompt } }, spanRows: label().rows.spanRows },
    });
    const preludeFor = (context) => (context.layersKnown === true
      ? { text: PRELUDE }
      : { reason: "the run recorded no layer selection" });
    const result = buildRunGoldenSet([label(), blind], preludeFor);
    expect(result.items).toHaveLength(2);
    expect(result.blind).toBe(1);
    expect(summariseRuns(result)).toBe(
      "golden set (labels): 2 items in 1 partitions (0 regression, 2 capability); " +
      "0 unbuildable (), 0 superseded, 0 dropped (credential-shaped text), 1 blind to a layer change.",
    );
  });

  it("sorts by id, so two exports of one input write the same files", () => {
    const other = label({ labelId: "k99zzz000000", link: { todoId: "ph81", batchId: null, subjectKey: "life ph81" } });
    const labels = [other, label()];
    const first = buildRunGoldenSet(labels, assembles(PRELUDE)).items.map((item) => item.id);
    const second = buildRunGoldenSet([...labels].reverse(), assembles(PRELUDE)).items.map((item) => item.id);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});
