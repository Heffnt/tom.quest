import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  STALE_WORKDIR_MS,
  reapWorkdir,
  reapableWorkdirs,
  sweepWorkdirs,
  workdirTouchedAt,
} from "../workdir-sweep.mjs";

const NOW = Date.parse("2026-09-23T19:00:00.000Z");
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "workdir-sweep-"));

/** A session workdir with one repo checkout in it, last touched `ageMs` ago. */
function workdir(base, id, { ageMs = 0, overflow = null } = {}) {
  const dir = path.join(base, id);
  fs.mkdirSync(path.join(dir, "tom.quest", ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tom.quest", "AGENTS.md"), "# tom.Quest\n");
  if (overflow !== null) {
    fs.mkdirSync(path.join(dir, "overflow"), { recursive: true });
    fs.writeFileSync(path.join(dir, "overflow", "41"), overflow);
  }
  const at = new Date(NOW - ageMs);
  for (const entry of fs.readdirSync(dir)) {
    fs.utimesSync(path.join(dir, entry), at, at);
  }
  fs.utimesSync(dir, at, at);
  return dir;
}

describe("reapableWorkdirs", () => {
  it("reaps the workdir of a session that ended in another daemon's process", () => {
    // THE 2026-09-22 LEAK. cleanupWorkdir is a Session method, so a session
    // whose ending was reported by a process that is now gone leaves its clone
    // behind and nothing ever looks at it again.
    const base = root();
    workdir(base, "ended-last-week", { ageMs: 7 * 24 * 60 * 60_000 });
    expect(reapableWorkdirs({ root: base, now: NOW })).toEqual(["ended-last-week"]);
  });

  it("reaps an idle session's workdir, which the next turn re-clones", () => {
    // An adoption parks a session idle and never ends it, so cleanupWorkdir is
    // never reached; #deliverUserTurn calls ensureWorkdir({ forResume: true }),
    // so the cost of deleting the clone is one re-clone and not the transcript.
    const base = root();
    workdir(base, "idle-since-yesterday", { ageMs: STALE_WORKDIR_MS + 60_000 });
    expect(reapableWorkdirs({ root: base, busy: new Set(), now: NOW })).toEqual([
      "idle-since-yesterday",
    ]);
  });

  it("keeps a workdir a turn is running in, however old the clone is", () => {
    const base = root();
    workdir(base, "mid-turn", { ageMs: 30 * 24 * 60 * 60_000 });
    expect(reapableWorkdirs({ root: base, busy: new Set(["mid-turn"]), now: NOW })).toEqual([]);
  });

  it("keeps a workdir touched within the day", () => {
    const base = root();
    workdir(base, "this-morning", { ageMs: 3 * 60 * 60_000 });
    expect(reapableWorkdirs({ root: base, now: NOW })).toEqual([]);
  });

  it("reads the age from the checkout inside, not from the directory alone", () => {
    // A one-repo session's top directory holds a single name and its mtime
    // never moves after the clone; only the child says when work last happened.
    const base = root();
    const dir = workdir(base, "busy-clone", { ageMs: 30 * 24 * 60 * 60_000 });
    const fresh = new Date(NOW - 60_000);
    fs.utimesSync(path.join(dir, "tom.quest"), fresh, fresh);
    expect(workdirTouchedAt(dir)).toBe(fresh.getTime());
    expect(reapableWorkdirs({ root: base, now: NOW })).toEqual([]);
  });

  it("answers nothing when the sessions root does not exist", () => {
    expect(reapableWorkdirs({ root: path.join(root(), "never-made"), now: NOW })).toEqual([]);
  });
});

describe("reapWorkdir", () => {
  it("deletes everything when overflow holds nothing", () => {
    const base = root();
    const dir = workdir(base, "plain", { ageMs: STALE_WORKDIR_MS });
    expect(reapWorkdir(dir)).toBe("deleted");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps overflow and deletes everything beside it", () => {
    // The one exception to "losing this dir loses nothing durable": these are
    // complete payloads Convex refused, and they exist nowhere else.
    const base = root();
    const dir = workdir(base, "refused", { ageMs: STALE_WORKDIR_MS, overflow: "the payload" });
    expect(reapWorkdir(dir)).toBe("kept-overflow");
    expect(fs.readdirSync(dir)).toEqual(["overflow"]);
    expect(fs.readFileSync(path.join(dir, "overflow", "41"), "utf8")).toBe("the payload");
  });
});

describe("sweepWorkdirs", () => {
  it("frees the stale clones, keeps the overflow, and reports the bytes", () => {
    const base = root();
    workdir(base, "stale-a", { ageMs: STALE_WORKDIR_MS + 1 });
    workdir(base, "stale-b", { ageMs: 9 * 24 * 60 * 60_000, overflow: "kept" });
    workdir(base, "fresh", { ageMs: 60_000 });
    workdir(base, "running", { ageMs: STALE_WORKDIR_MS + 1 });

    const lines = [];
    const swept = sweepWorkdirs({
      root: base,
      busy: new Set(["running"]),
      now: NOW,
      log: (line) => lines.push(line),
    });

    expect(swept).toMatchObject({ deleted: 1, keptOverflow: 1 });
    expect(swept.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(base).sort()).toEqual(["fresh", "running", "stale-b"]);
    expect(fs.readdirSync(path.join(base, "stale-b"))).toEqual(["overflow"]);
    expect(lines.join("\n")).toContain("session stale-a deleted");
  });

  it("keeps sweeping after a directory that will not delete", () => {
    // A sweep that throws costs the box the disk it was there to free, and a
    // throw out of the poll loop would cost every live session.
    const base = root();
    workdir(base, "unreadable", { ageMs: STALE_WORKDIR_MS + 1 });
    workdir(base, "ordinary", { ageMs: STALE_WORKDIR_MS + 1 });
    const failing = Object.create(fs);
    failing.rmSync = (target, options) => {
      if (String(target).includes("unreadable")) throw new Error("EBUSY");
      return fs.rmSync(target, options);
    };
    const lines = [];
    const swept = sweepWorkdirs({ root: base, now: NOW, fs: failing, log: (line) => lines.push(line) });
    expect(swept.deleted).toBe(1);
    expect(fs.existsSync(path.join(base, "ordinary"))).toBe(false);
    expect(lines.join("\n")).toContain("session unreadable kept — EBUSY");
  });
});
