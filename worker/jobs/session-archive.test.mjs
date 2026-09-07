// Tests for the one home that archives a session file into WikiTom's
// sessions/ (worker/jobs/session-archive.mjs) — the function the nightly
// sweep and the daemon's session-end archive share. The placement rules
// (dates, accounts, orphans) are pinned in nightly.test.mjs through the
// re-exports; what is pinned here is what the sharing added: one session at
// a time, the write that cannot leave a torn file behind a manifest line,
// and the missing-checkout error a daemon must be able to name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STAGING_DIR,
  archiveSessionFiles,
  readManifests,
  sha256,
  writeArchived,
  indexManifests,
  claudeEntry,
} from "./session-archive.mjs";

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const line = (ts, extra = {}) => `${JSON.stringify({ timestamp: ts, ...extra })}\n`;

/** A box with two Claude sessions under one account, and a Codex thread with
 * a subagent, plus an empty checkout. */
function box() {
  const accounts = tmp();
  const codex = tmp();
  const checkout = tmp();
  fs.mkdirSync(path.join(checkout, ".git"));
  write(accounts, "gmail/projects/-root/aaaa.jsonl", line("2026-09-05T20:00:00.000Z", { n: 1 }));
  write(accounts, "gmail/projects/-root/aaaa/child.jsonl", line("2026-09-05T20:01:00.000Z"));
  write(accounts, "gmail/projects/-root/aaaa/notes.txt", "an attachment\n");
  write(accounts, "gmail/projects/-root/bbbb.jsonl", line("2026-09-05T21:00:00.000Z", { n: 2 }));
  write(
    codex,
    "2026/09/05/rollout-2026-09-05T22-00-00-thread1.jsonl",
    `${JSON.stringify({ type: "session_meta", timestamp: "2026-09-05T22:00:00.000Z", payload: { id: "thread1", cwd: "/root/x" } })}\n`,
  );
  write(
    codex,
    "2026/09/05/rollout-2026-09-05T22-01-00-thread1-sub.jsonl",
    `${JSON.stringify({ type: "session_meta", timestamp: "2026-09-05T22:01:00.000Z", payload: { id: "sub1", parent_thread_id: "thread1", cwd: "/root/x" } })}\n`,
  );
  return { accounts, codex, checkout };
}

const archive = (b, over = {}) =>
  archiveSessionFiles({ checkoutDir: b.checkout, day: "2026-09-06", codexDir: b.codex, accountsDir: b.accounts, log: () => {}, ...over });

describe("archiveSessionFiles", () => {
  it("archives one session at session end — its parent, child and attachment — and leaves the rest for the sweep", () => {
    const b = box();
    const first = archive(b, { only: "aaaa" });
    expect(first.archived.map((r) => r.dest).sort()).toEqual([
      "sessions/2026/09/05/claude-aaaa/attachments/notes.txt.gz",
      "sessions/2026/09/05/claude-aaaa/children/child.jsonl.gz",
      "sessions/2026/09/05/claude-aaaa/session.jsonl.gz",
    ]);
    expect(first.manifestPath).toBe(path.join(b.checkout, "sessions", "manifest-box-2026-09-06.jsonl"));
    expect(readManifests(path.join(b.checkout, "sessions"))).toHaveLength(3);
    expect(fs.existsSync(path.join(b.checkout, "sessions/2026/09/05/claude-bbbb"))).toBe(false);
    // A Codex thread by its id: the rollout and its subagent thread.
    const codex = archive(b, { only: "thread1" });
    expect(codex.archived.map((r) => r.dest).sort()).toEqual([
      "sessions/2026/09/05/codex-thread1/children/sub1.jsonl.gz",
      "sessions/2026/09/05/codex-thread1/rollout.jsonl.gz",
    ]);
    // The sweep takes what is left, and nothing twice.
    const sweep = archive(b);
    expect(sweep.archived.map((r) => r.dest)).toEqual(["sessions/2026/09/05/claude-bbbb/session.jsonl.gz"]);
    expect(archive(b).archived).toEqual([]);
    // A file that grew since is archived again, at its new content.
    fs.appendFileSync(path.join(b.accounts, "gmail/projects/-root/aaaa.jsonl"), line("2026-09-05T23:00:00.000Z"));
    const again = archive(b, { only: "aaaa" });
    expect(again.archived.map((r) => r.dest)).toEqual(["sessions/2026/09/05/claude-aaaa/session.jsonl.gz"]);
    const stored = fs.readFileSync(path.join(b.checkout, again.archived[0].dest));
    expect(zlib.gunzipSync(stored).toString()).toContain("2026-09-05T23:00:00.000Z");
    // Nothing staged is left behind, and git is told to look away from the
    // staging root.
    expect(fs.readdirSync(path.join(b.checkout, STAGING_DIR))).toEqual([".gitignore"]);
    expect(fs.readFileSync(path.join(b.checkout, STAGING_DIR, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("names a missing checkout with a code the daemon can act on", () => {
    const b = box();
    fs.rmSync(path.join(b.checkout, ".git"), { recursive: true });
    let err;
    try {
      archive(b, { only: "aaaa" });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("NO_CHECKOUT");
    expect(err?.message).toContain("is not a git checkout");
  });

  it("a session no file belongs to archives nothing", () => {
    const b = box();
    expect(archive(b, { only: "nope" })).toMatchObject({ archived: [] });
  });
});

// witness: the archive gzipped the session file's own bytes, so the GitHub
// token a session printed into its transcript on 2026-08-30 — the very rows
// the snapshot's redactRow keeps out of the vault — went into the vault
// verbatim, by the other door.
describe("the archived transcript is redacted", () => {
  // Assembled at runtime from pieces, so no committed line spells a token.
  const token = ["gh", "p_", "B".repeat(36)].join("");

  it("stores the filtered text and keeps the source's hash, so the grew-since check is unmoved", () => {
    const b = box();
    const source = path.join(b.accounts, "gmail/projects/-root/aaaa.jsonl");
    fs.appendFileSync(source, line("2026-09-05T20:02:00.000Z", { text: `gh auth login --with-token ${token}` }));
    const raw = fs.readFileSync(source);
    const { archived } = archive(b, { only: "aaaa" });
    const parent = archived.find((r) => r.kind === "parent");
    const stored = zlib.gunzipSync(fs.readFileSync(path.join(b.checkout, parent.dest))).toString("utf8");
    expect(stored).not.toContain(token);
    expect(stored).toContain("[redacted:github]");
    // Still one line per line, and everything that was not a credential is
    // where it was.
    expect(stored.trim().split("\n")).toHaveLength(2);
    expect(stored).toContain("gh auth login --with-token");
    // The manifest describes the SOURCE — that is what "has it grown since?"
    // asks about — so a second call archives nothing.
    expect(parent.sha256).toBe(sha256(raw));
    expect(parent.raw_bytes).toBe(raw.length);
    expect(archive(b, { only: "aaaa" }).archived).toEqual([]);
  });

  it("filters a Codex rollout and a text attachment, and leaves bytes that are not text alone", () => {
    const b = box();
    fs.appendFileSync(
      path.join(b.codex, "2026/09/05/rollout-2026-09-05T22-00-00-thread1.jsonl"),
      `${JSON.stringify({ timestamp: "2026-09-05T22:02:00.000Z", text: token })}\n`,
    );
    write(b.accounts, "gmail/projects/-root/aaaa/notes.txt", `the key is ${token}\n`);
    // A PNG's bytes are not valid UTF-8, so nothing decodes and re-encodes
    // them: it is stored exactly as it was read.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    write(b.accounts, "gmail/projects/-root/aaaa/shot.png", png);
    const { archived } = archive(b);
    const at = (suffix) => archived.find((r) => r.dest.endsWith(suffix));
    const unzip = (rec) => zlib.gunzipSync(fs.readFileSync(path.join(b.checkout, rec.dest))).toString();
    expect(unzip(at("codex-thread1/rollout.jsonl.gz"))).toContain("[redacted:github]");
    expect(unzip(at("attachments/notes.txt.gz"))).toBe("the key is [redacted:github]\n");
    expect(at("shot.png").encoding).toBe("raw");
    expect(fs.readFileSync(path.join(b.checkout, at("shot.png").dest)).equals(png)).toBe(true);
  });
});

// witness: the bytes were written to their destination first and the
// manifest line after — a crash between the two left a torn file at the
// destination, which the sweep's next commit carried into history.
describe("writeArchived is atomic", () => {
  function entryFor(checkout, raw) {
    const index = indexManifests([]);
    const f = { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "parent", source: "/a/s1.jsonl" };
    return { index, entry: claudeEntry(f, raw, sha256(raw), 0, index, new Map([["s1", new Set(["gmail"])]])) };
  }

  it("stages, renames into place, then appends the manifest line — in that order", () => {
    const checkout = tmp();
    const manifest = path.join(checkout, "sessions", "manifest-box-2026-09-06.jsonl");
    const raw = Buffer.from(line("2026-08-28T04:24:42.053Z"));
    const { index, entry } = entryFor(checkout, raw);
    const order = [];
    vi.spyOn(fs, "renameSync").mockImplementation(function (from, to) {
      order.push(`rename ${path.relative(checkout, to).split(path.sep).join("/")}`);
      return fs.copyFileSync(from, to);
    });
    vi.spyOn(fs, "appendFileSync").mockImplementation(function (file) {
      order.push(`manifest ${path.basename(file)}`);
    });
    writeArchived(checkout, manifest, entry, raw, index);
    expect(order).toEqual([
      "rename sessions/2026/08/28/claude-s1/session.jsonl.gz",
      "manifest manifest-box-2026-09-06.jsonl",
    ]);
  });

  it("leaves no destination and no manifest line when the rename fails", () => {
    const checkout = tmp();
    const manifest = path.join(checkout, "sessions", "manifest-box-2026-09-06.jsonl");
    const raw = Buffer.from(line("2026-08-28T04:24:42.053Z"));
    const { index, entry } = entryFor(checkout, raw);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => writeArchived(checkout, manifest, entry, raw, index)).toThrow("disk full");
    expect(fs.existsSync(path.join(checkout, entry.dest))).toBe(false);
    expect(fs.existsSync(manifest)).toBe(false);
    // The bytes sit in staging, where git does not look and the next call
    // overwrites them.
    expect(fs.existsSync(path.join(checkout, STAGING_DIR, "s1", entry.dest))).toBe(true);
    expect(index.shaBySource.has("/a/s1.jsonl")).toBe(false);
  });

  it("leaves the destination but no manifest line when the append fails, so the sweep archives it again", () => {
    const checkout = tmp();
    const manifest = path.join(checkout, "sessions", "manifest-box-2026-09-06.jsonl");
    const raw = Buffer.from(line("2026-08-28T04:24:42.053Z"));
    const { index, entry } = entryFor(checkout, raw);
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => writeArchived(checkout, manifest, entry, raw, index)).toThrow("disk full");
    expect(fs.existsSync(path.join(checkout, entry.dest))).toBe(true);
    expect(fs.existsSync(manifest)).toBe(false);
    expect(index.shaBySource.has("/a/s1.jsonl")).toBe(false);
  });
});
