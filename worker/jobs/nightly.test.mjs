// Tests for the nightly job's pure halves (worker/jobs/nightly.mjs). The job
// cannot run end-to-end here — it needs the WikiTom checkout, the session
// files on the Jarvis Box, flock, and Convex — so what is pinned is what a
// mistake in would be silent: the bytes a table becomes (a nondeterministic
// line makes every table "changed" every night), the split rule, the
// sections an area page is reduced to, the file order of the post, the
// dates a session file is filed under, and the archive's placement rules.
//
// Importing the job module is safe: it only calls main() when node was
// pointed at the file (the `invokedDirectly` guard at the bottom).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AREA_SECTIONS,
  MODEL_OF_TOM_FIRST,
  SPLIT_BYTES,
  abortStaleRebase,
  claudeEntry,
  codexMetaOf,
  collectModelOfTomFiles,
  commitTree,
  discoverSessionFiles,
  extractSections,
  indexManifests,
  isTableFile,
  planTableFiles,
  readManifests,
  rebaseInProgress,
  serializeRow,
  sessionDateOf,
  sha256,
  syncRemote,
  syncSnapshot,
  utcDay,
  writeArchived,
} from "./nightly.mjs";

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("serializeRow", () => {
  // Phase 1's spacing, keys sorted at every level: the same row gives the
  // same bytes whatever order Convex handed the fields back in.
  it("writes one row in phase 1's form with keys sorted at every level", () => {
    const row = { statement: "x", _id: "abc", _creationTime: 5.5, nested: { z: [1, "two", { b: 1, a: 2 }], a: null } };
    expect(serializeRow(row)).toBe(
      '{ "_creationTime": 5.5, "_id": "abc", "nested": { "a": null, "z": [1, "two", { "a": 2, "b": 1 }] }, "statement": "x" }',
    );
    expect(serializeRow({})).toBe("{}");
    expect(serializeRow([])).toBe("[]");
  });

  it("is the same bytes for the same row in another key order", () => {
    expect(serializeRow({ a: 1, b: { c: 2, d: 3 } })).toBe(serializeRow({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("planTableFiles", () => {
  it("writes a small table as one plain file, newest row first", () => {
    const files = planTableFiles("dtsTodos", [
      { _id: "a", _creationTime: 1 },
      { _id: "b", _creationTime: 2 },
    ]);
    expect(files.map((f) => f.name)).toEqual(["dtsTodos.jsonl"]);
    expect(files[0].bytes.toString("utf8")).toBe(
      '{ "_creationTime": 2, "_id": "b" }\n{ "_creationTime": 1, "_id": "a" }\n',
    );
  });

  it("writes an empty table as an empty file", () => {
    const [f] = planTableFiles("empty", []);
    expect(f.name).toBe("empty.jsonl");
    expect(f.bytes.length).toBe(0);
  });

  // The split: raw slices under the limit, each gzipped alone so any part
  // reads by itself, named partNN in order.
  it("splits a table over the limit into gzipped parts that concatenate back to the whole", () => {
    // The rule at a small limit (the real one is 90 MB, which is the same
    // arithmetic on more bytes): rows of ~1 KB, 200 of them, a 10 KB limit.
    const limit = 10 * 1024;
    const big = "x".repeat(1024);
    const rows = Array.from({ length: 200 }, (_, i) => ({ _id: String(i), body: big }));
    const files = planTableFiles("claudeMessages", rows, limit);
    expect(files.length).toBeGreaterThan(1);
    expect(files.map((f) => f.name)).toEqual(
      files.map((_, i) => `claudeMessages.part${String(i).padStart(2, "0")}.jsonl.gz`),
    );
    const raws = files.map((f) => zlib.gunzipSync(f.bytes));
    for (const r of raws) expect(r.length).toBeLessThanOrEqual(limit);
    const whole = Buffer.concat(raws).toString("utf8");
    const lines = whole.split("\n").filter(Boolean);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain('"_id": "199"'); // newest first
    expect(lines[199]).toContain('"_id": "0"');
    // Deterministic: the same rows give the same part bytes.
    const again = planTableFiles("claudeMessages", rows, limit);
    expect(sha256(again[0].bytes)).toBe(sha256(files[0].bytes));
    // The real limit is phase 1's: under GitHub's 100 MB refusal.
    expect(SPLIT_BYTES).toBe(90 * 1024 * 1024);
  });

  it("knows which snapshot names belong to a table", () => {
    expect(isTableFile("dtsTodos", "dtsTodos.jsonl")).toBe(true);
    expect(isTableFile("claudeMessages", "claudeMessages.part02.jsonl.gz")).toBe(true);
    expect(isTableFile("dtsTodos", "dtsTodosX.jsonl")).toBe(false);
    expect(isTableFile("dtsTodos", "README.md")).toBe(false);
  });
});

describe("syncSnapshot", () => {
  // Only the bytes that changed are written (git sees only those), and a
  // table that crossed the split threshold loses its old shape.
  it("writes changed files, leaves identical ones, removes a table's stale shape, keeps the README", () => {
    const snapshot = tmp();
    const staging = tmp();
    write(snapshot, "README.md", "read-only copy");
    write(snapshot, "same.jsonl", "a\n");
    write(snapshot, "changed.jsonl", "old\n");
    write(snapshot, "big.jsonl", "was one file\n");
    write(staging, "same.jsonl", "a\n");
    write(staging, "changed.jsonl", "new\n");
    write(staging, "big.part00.jsonl.gz", "gz0");
    write(staging, "big.part01.jsonl.gz", "gz1");
    const sameBefore = fs.statSync(path.join(snapshot, "same.jsonl")).mtimeMs;
    const changed = syncSnapshot(snapshot, staging, ["same", "changed", "big"]);
    expect(changed).toEqual(["big.jsonl", "big.part00.jsonl.gz", "big.part01.jsonl.gz", "changed.jsonl"]);
    expect(fs.readFileSync(path.join(snapshot, "changed.jsonl"), "utf8")).toBe("new\n");
    expect(fs.existsSync(path.join(snapshot, "big.jsonl"))).toBe(false);
    expect(fs.readFileSync(path.join(snapshot, "README.md"), "utf8")).toBe("read-only copy");
    expect(fs.statSync(path.join(snapshot, "same.jsonl")).mtimeMs).toBe(sameBefore);
  });
});

describe("extractSections", () => {
  const page = [
    "---",
    "updated: 2026-09-05",
    "---",
    "# Research",
    "",
    "## Current state",
    "",
    "- CMT campaign live (2026-09-05, evidence: PR #104)",
    "",
    "### Detail",
    "",
    "- a sub-point that belongs to the section",
    "",
    "## Ideal state",
    "",
    "Tom's words, never posted.",
    "",
    "## Must not break",
    "",
    "- the D5 judge fix",
    "",
    "## Notes",
    "",
    "not posted either",
  ].join("\n");

  it("takes the two headed sections, sub-headings included, and nothing else", () => {
    const out = extractSections(page);
    expect(out).toBe(
      [
        "## Current state",
        "",
        "- CMT campaign live (2026-09-05, evidence: PR #104)",
        "",
        "### Detail",
        "",
        "- a sub-point that belongs to the section",
        "",
        "## Must not break",
        "",
        "- the D5 judge fix",
      ].join("\n"),
    );
    expect(out).not.toContain("Ideal state");
    expect(out).not.toContain("Tom's words");
    expect(out).not.toContain("Notes");
  });

  it("returns the sections in the fixed order whatever the page's order, and matches headings case-insensitively", () => {
    const flipped = "# Health\n\n## MUST NOT BREAK\n\n- sleep\n\n## current state\n\n- fine\n";
    expect(extractSections(flipped)).toBe("## current state\n\n- fine\n\n## MUST NOT BREAK\n\n- sleep");
  });

  it("is empty for a page with neither section, and copes with CRLF", () => {
    expect(extractSections("# Nothing\n\nprose\n")).toBe("");
    expect(extractSections("## Current state\r\n\r\n- x\r\n## Other\r\n")).toBe("## Current state\n\n- x");
  });

  it("names the two sections the design fixes", () => {
    expect(AREA_SECTIONS).toEqual(["Current state", "Must not break"]);
  });
});

describe("collectModelOfTomFiles", () => {
  it("posts the three named files then each area page's sections, alphabetically", () => {
    const dir = tmp();
    write(dir, "model-of-tom/writing.md", "# Writing\n");
    write(dir, "model-of-tom/priorities.md", "# Priorities\n");
    write(dir, "model-of-tom/schedule.md", "# Schedule\n");
    write(dir, "model-of-tom/README.md", "not posted\n");
    write(dir, "model-of-tom/areas/social.md", "## Current state\n\n- friends\n\n## Ideal state\n\nx\n");
    write(dir, "model-of-tom/areas/admin.md", "## Must not break\n\n- taxes\n");
    write(dir, "model-of-tom/areas/empty.md", "# Empty\n\nno sections yet\n");
    const { files, missing } = collectModelOfTomFiles(dir);
    expect(missing).toEqual([]);
    expect(files.map((f) => f.path)).toEqual([
      ...MODEL_OF_TOM_FIRST,
      "model-of-tom/areas/admin.md",
      "model-of-tom/areas/social.md",
    ]);
    expect(files[4].body).toBe("## Current state\n\n- friends");
    expect(files[3].body).toBe("## Must not break\n\n- taxes");
  });

  // areas/ arrives with the content half of phase 4; until then the three.
  it("posts the named files alone while areas/ does not exist, and names what is missing", () => {
    const dir = tmp();
    write(dir, "model-of-tom/writing.md", "# Writing\n");
    write(dir, "model-of-tom/schedule.md", "   \n");
    const { files, missing } = collectModelOfTomFiles(dir);
    expect(files.map((f) => f.path)).toEqual(["model-of-tom/writing.md"]);
    expect(missing).toEqual(["model-of-tom/priorities.md", "model-of-tom/schedule.md"]);
  });
});

describe("sessionDateOf", () => {
  it("reads a Claude SDK line's timestamp, in UTC", () => {
    const head = '{"type":"queue-operation","timestamp":"2026-08-28T04:24:42.053Z","sessionId":"x"}\n{"type":"user"}\n';
    expect(sessionDateOf(head, 0)).toEqual({ date: "2026-08-28", dateSource: "timestamp" });
  });

  it("reads a Codex rollout's session_meta timestamp", () => {
    const head = '{"timestamp":"2026-09-04T23:28:08.844Z","type":"session_meta","payload":{"id":"t1","timestamp":"2026-09-04T23:28:08.818Z"}}\n';
    expect(sessionDateOf(head, 0)).toEqual({ date: "2026-09-04", dateSource: "timestamp" });
  });

  it("falls back to the file's mtime when no line carries a timestamp", () => {
    const mtime = Date.UTC(2026, 8, 2, 12);
    expect(sessionDateOf('{"type":"summary"}\nnot json\n', mtime)).toEqual({
      date: "2026-09-02",
      dateSource: "mtime",
    });
    expect(utcDay(mtime)).toBe("2026-09-02");
  });
});

describe("codexMetaOf", () => {
  it("reads a parent thread's id and a subagent thread's parent", () => {
    const parent = '{"type":"session_meta","payload":{"id":"p1","cwd":"/tmp/x"}}\n';
    expect(codexMetaOf(parent)).toEqual({ id: "p1", parent: null, cwd: "/tmp/x" });
    const child = '{"type":"session_meta","payload":{"session_id":"p1","id":"c1","parent_thread_id":"p1","cwd":"/w"}}\n';
    expect(codexMetaOf(child)).toEqual({ id: "c1", parent: "p1", cwd: "/w" });
    expect(codexMetaOf('{"type":"event_msg"}\n')).toBeNull();
    expect(codexMetaOf("")).toBeNull();
  });
});

describe("discoverSessionFiles", () => {
  it("finds Codex rollouts and Claude parents, children and attachments, skipping the active symlink", () => {
    const root = tmp();
    const codex = path.join(root, "codex");
    const accounts = path.join(root, "accounts");
    write(codex, "2026/09/05/rollout-2026-09-05T00-02-30-c1.jsonl", "{}\n");
    write(codex, "2026/09/05/notes.txt", "ignored");
    write(accounts, "gmail/projects/-root/s1.jsonl", "{}\n");
    write(accounts, "gmail/projects/-root/s1/subagents/agent-1.jsonl", "{}\n");
    write(accounts, "gmail/projects/-root/s1/tool-results/r.txt", "60000 chars");
    write(accounts, "wpi/projects/-root/s2.jsonl", "{}\n");
    fs.symlinkSync(path.join(accounts, "gmail"), path.join(accounts, "active"), "junction");
    const found = discoverSessionFiles({ codexDir: codex, accountsDir: accounts });
    const brief = found.map((f) => [f.runtime, f.account, f.session ?? null, f.kind ?? null, f.rel ?? null]);
    expect(brief).toEqual([
      ["claude", "gmail", "s1", "parent", null],
      ["claude", "gmail", "s1", "child", "subagents/agent-1.jsonl"],
      ["claude", "gmail", "s1", "attachment", "tool-results/r.txt"],
      ["claude", "wpi", "s2", "parent", null],
      ["codex", null, null, null, null],
    ]);
    // Nothing found twice through the symlink.
    expect(found.filter((f) => f.account === "active")).toEqual([]);
  });

  it("is empty when neither directory exists", () => {
    const root = tmp();
    expect(
      discoverSessionFiles({ codexDir: path.join(root, "no"), accountsDir: path.join(root, "nope") }),
    ).toEqual([]);
  });
});

describe("the manifests and the archive", () => {
  const PARENT_LINE = {
    session: "s1",
    project: "-root",
    date: "2026-08-28",
    date_source: "timestamp",
    orphan: false,
    host: "box",
    account: "gmail",
    runtime: "claude",
    parent: null,
    kind: "parent",
    source: "/root/.claude-accounts/gmail/projects/-root/s1.jsonl",
    dest: "sessions/2026/08/28/claude-s1/session.jsonl.gz",
    raw_bytes: 10,
    stored_bytes: 5,
    sha256: "abc",
    encoding: "gzip",
    parts: null,
  };

  it("reads every manifest file and indexes sources, parent dirs and accounts", () => {
    const dir = tmp();
    write(dir, "manifest-box-2026-09-05.jsonl", `${JSON.stringify(PARENT_LINE)}\ntorn line\n`);
    write(dir, "manifest-laptop-2026-09-05.jsonl", `${JSON.stringify({ ...PARENT_LINE, session: "s9", account: null, host: "laptop", source: "/home/x/s9.jsonl", dest: "sessions/2026/06/11/claude-s9/session.jsonl.gz" })}\n`);
    write(dir, "README.md", "not a manifest");
    const entries = readManifests(dir);
    expect(entries).toHaveLength(2);
    const index = indexManifests(entries);
    expect(index.shaBySource.get(PARENT_LINE.source)).toBe("abc");
    expect(index.dirBySession.get("claude:s1")).toBe("sessions/2026/08/28/claude-s1");
    expect(index.dirBySession.get("claude:s9")).toBe("sessions/2026/06/11/claude-s9");
    expect([...index.accountsBySession.get("s1")]).toEqual(["gmail"]);
  });

  it("files a Claude parent by its own date, and its child and attachment beside it", () => {
    const index = indexManifests([]);
    const accounts = new Map([["s1", new Set(["gmail"])]]);
    const raw = Buffer.from('{"timestamp":"2026-08-28T04:24:42.053Z"}\n');
    const parent = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "parent", source: "/a/s1.jsonl" },
      raw, sha256(raw), 0, index, accounts,
    );
    expect(parent.dest).toBe("sessions/2026/08/28/claude-s1/session.jsonl.gz");
    expect(parent.date_source).toBe("timestamp");
    expect(parent.orphan).toBe(false);
    const child = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "child", rel: "subagents/agent-1.jsonl", source: "/a/s1/subagents/agent-1.jsonl" },
      Buffer.from("{}\n"), "x", Date.UTC(2026, 8, 1), index, accounts,
    );
    expect(child.dest).toBe("sessions/2026/08/28/claude-s1/children/subagents/agent-1.jsonl.gz");
    expect(child.date).toBe("2026-08-28"); // the parent's day, not its own mtime
    expect(child.parent).toBe("s1");
    const pdf = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "attachment", rel: "tool-results/w.pdf", source: "/a/s1/tool-results/w.pdf" },
      Buffer.from("%PDF"), "y", 0, index, accounts,
    );
    expect(pdf.dest).toBe("sessions/2026/08/28/claude-s1/attachments/tool-results/w.pdf");
    expect(pdf.encoding).toBe("raw");
  });

  it("puts a session id held by two accounts under per-account subdirectories, and marks a parentless child an orphan", () => {
    const index = indexManifests([]);
    const accounts = new Map([["s1", new Set(["gmail", "wpi"])]]);
    const raw = Buffer.from('{"timestamp":"2026-09-02T10:00:00Z"}\n');
    const wpi = claudeEntry(
      { runtime: "claude", account: "wpi", project: "-p", session: "s1", kind: "parent", source: "/w/s1.jsonl" },
      raw, "a", 0, index, accounts,
    );
    expect(wpi.dest).toBe("sessions/2026/09/02/claude-s1/wpi/session.jsonl.gz");
    const orphan = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-p", session: "s7", kind: "child", rel: "subagents/a.jsonl", source: "/g/s7/subagents/a.jsonl" },
      Buffer.from('{"timestamp":"2026-09-03T10:00:00Z"}\n'), "b", 0, index, new Map(),
    );
    expect(orphan.orphan).toBe(true);
    expect(orphan.dest).toBe("sessions/2026/09/03/claude-s7/children/subagents/a.jsonl.gz");
  });

  it("writes the gzipped file under the checkout and appends the manifest line", () => {
    const checkout = tmp();
    const manifest = path.join(checkout, "sessions", "manifest-box-2026-09-06.jsonl");
    const index = indexManifests([]);
    const raw = Buffer.from('{"timestamp":"2026-08-28T04:24:42.053Z"}\n');
    const entry = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "parent", source: "/a/s1.jsonl" },
      raw, sha256(raw), 0, index, new Map([["s1", new Set(["gmail"])]]),
    );
    const record = writeArchived(checkout, manifest, entry, raw, index);
    const stored = fs.readFileSync(path.join(checkout, record.dest));
    expect(zlib.gunzipSync(stored).equals(raw)).toBe(true);
    expect(record.stored_bytes).toBe(stored.length);
    expect(record.parts).toBeNull();
    const lines = fs.readFileSync(manifest, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(Object.keys(line)).toEqual(Object.keys(PARENT_LINE)); // phase 1's columns
    expect(line.sha256).toBe(sha256(raw));
    // The index now knows this source at this content, so tomorrow skips it.
    expect(index.shaBySource.get("/a/s1.jsonl")).toBe(sha256(raw));
  });
});

// ── The git half, in a temp repository ───────────────────────────────────────
// What these pin is what the box cannot tell us about until the night after:
// the checkout must always be left in a state the next night can pull into.
// Every repository here is made WITHOUT a committer identity anywhere git
// would find one (no global, no system, no local config, no GIT_AUTHOR_*), so
// a commit or a rebase that does not carry the job's own `-c` pair dies
// exactly as it would on the Jarvis Box.
describe("the git half", () => {
  const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

  beforeEach(() => {
    // An empty global config file and no system config: the machine running
    // the tests has an identity, and the Jarvis Box has none.
    const empty = path.join(tmp(), "gitconfig");
    fs.writeFileSync(empty, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", empty);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** git in `dir`, with the TEST's identity — never the job's. */
  function run(dir, ...args) {
    return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  /** A repository with one commit holding a snapshot file and a manifest. */
  function repo() {
    const dir = tmp();
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    write(dir, "tts/snapshot/dtsTodos.jsonl", "old\n");
    write(dir, "sessions/manifest-box-2026-09-05.jsonl", "{}\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "base");
    return dir;
  }
  const status = (dir) => run(dir, "status", "--porcelain").trim();
  const subjects = (dir) => run(dir, "log", "--format=%s").trim().split("\n");
  const committers = (dir) => run(dir, "log", "--format=%cn|%an").trim().split("\n");

  it("commits under the job's identity where the checkout has none configured", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "new\n");
    const { made, failures } = commitTree(
      dir,
      [{ paths: ["tts/snapshot"], message: "snapshot: 2026-09-06 — 1 table" }],
      "2026-09-06",
    );
    expect(failures).toEqual([]);
    expect(made).toEqual(["snapshot: 2026-09-06 — 1 table"]);
    expect(committers(dir)[0]).toBe("tts-nightly|tts-nightly");
    expect(status(dir)).toBe("");
  });

  // witness: without the sweep, a run that died after writing files leaves the
  // tree modified, and every later night's `git pull --rebase` refuses it.
  it("commits what an earlier run left modified even when this run changed nothing", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "left behind by a crashed run\n");
    write(dir, "sessions/2026/09/06/claude-s1/session.jsonl.gz", "half an archive");
    const { made, failures } = commitTree(dir, [], "2026-09-06");
    expect(failures).toEqual([]);
    expect(made).toEqual(["nightly: 2026-09-06 — changes an earlier run left uncommitted"]);
    expect(status(dir)).toBe("");
    // The leftovers are IN the commit, not merely staged.
    expect(run(dir, "show", "--stat", "--format=", "HEAD")).toContain("session.jsonl.gz");
  });

  it("leaves nothing modified when a step's own commit did not cover it", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight\n");
    write(dir, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    const { made } = commitTree(
      dir,
      [{ paths: ["tts/snapshot"], message: "snapshot: 2026-09-06" }],
      "2026-09-06",
    );
    expect(made).toEqual([
      "snapshot: 2026-09-06",
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
    ]);
    expect(status(dir)).toBe("");
  });

  it("adds nothing and commits nothing when the tree is clean", () => {
    const dir = repo();
    expect(commitTree(dir, [], "2026-09-06")).toEqual({ made: [], failures: [] });
    expect(subjects(dir)).toEqual(["base"]);
  });

  // A rebase left in progress by a previous night blocks `git commit`
  // outright; the checkout would never commit or push again on its own. The
  // abort is before the run's first write because it resets the tree hard.
  it("aborts a rebase an earlier run left in progress, records it, and commits after", () => {
    const dir = repo();
    run(dir, "checkout", "-q", "-b", "theirs");
    write(dir, "tts/snapshot/dtsTodos.jsonl", "theirs\n");
    run(dir, "commit", "-qam", "theirs");
    run(dir, "checkout", "-q", "main");
    write(dir, "tts/snapshot/dtsTodos.jsonl", "ours\n");
    run(dir, "commit", "-qam", "ours");
    try {
      run(dir, "rebase", "theirs");
    } catch {
      // the conflict is the point
    }
    expect(rebaseInProgress(dir)).toBe(true);

    const failures = abortStaleRebase(dir);
    expect(failures).toHaveLength(1);
    expect(failures[0].step).toBe("rebase");
    expect(failures[0].error).toContain("still in progress");
    expect(rebaseInProgress(dir)).toBe(false);
    expect(status(dir)).toBe("");
    // The night's own work then commits on a checkout that can be pulled into.
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight's snapshot\n");
    const { made, failures: after } = commitTree(dir, [], "2026-09-06");
    expect(after).toEqual([]);
    expect(made).toEqual(["nightly: 2026-09-06 — changes an earlier run left uncommitted"]);
    expect(status(dir)).toBe("");
  }, 30_000);

  // witness: `git pull --rebase` re-commits the local commits it replays, and
  // without an identity it dies — on the box, every night, forever after.
  it("rebases a local commit onto origin and pushes it, with no identity configured", () => {
    const bare = tmp();
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
    const first = repo();
    run(first, "remote", "add", "origin", bare);
    run(first, "push", "-q", "-u", "origin", "main");
    const box = tmp();
    execFileSync("git", ["clone", "-q", bare, box], { stdio: "ignore" });
    // Another writer pushes; the box holds a commit of its own from a night
    // whose push was refused.
    write(first, "tts/snapshot/dtsEvents.jsonl", "elsewhere\n");
    run(first, "add", "-A");
    run(first, "commit", "-q", "-m", "from another writer");
    run(first, "push", "-q");
    write(box, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    const { made } = commitTree(box, [], "2026-09-06");
    expect(made).toHaveLength(1);

    const result = syncRemote(box);
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ pulled: true, pushed: true });
    // The box's commit was replayed on top of the other writer's, under the
    // job's identity, and origin now holds both.
    expect(subjects(box).slice(0, 2)).toEqual([
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
      "from another writer",
    ]);
    expect(committers(box)[0]).toBe("tts-nightly|tts-nightly");
    expect(run(bare, "log", "--format=%s", "-1", "main").trim()).toBe(
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
    );
  }, 60_000);

  it("records a refused pull as a failure and keeps the commit local", () => {
    const dir = repo();
    run(dir, "remote", "add", "origin", path.join(tmp(), "not-a-repo"));
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight\n");
    commitTree(dir, [], "2026-09-06");
    const result = syncRemote(dir);
    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.failures.map((f) => f.step)).toEqual(["pull"]);
    expect(result.failures[0].error).not.toBe("");
    expect(subjects(dir)[0]).toContain("nightly: 2026-09-06");
    expect(rebaseInProgress(dir)).toBe(false);
  }, 30_000);
});
