import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGoldenSet,
  buildItem,
  goldenId,
  priorReviseSentence,
  snapshotAt,
  snapshotCommitAt,
  snapshotRows,
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
