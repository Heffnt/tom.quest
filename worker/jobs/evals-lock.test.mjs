// A hand-run and the five-minute `--serve` cron deleted each other's worktrees
// mid-run on 2026-09-14 — worktreeFor computed one path per ref and cleared it
// on the way in. These are the two halves of the fix: the lock that stops the
// second run starting, and the sweep that clears what a killed run left.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pruneStaleWorktrees, STALE_WORKTREE_MS, takeEvalsLock } from "./evals-lock.mjs";

const made = [];
const tempDir = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  made.push(dir);
  return dir;
};

afterEach(() => {
  while (made.length > 0) fs.rmSync(made.pop(), { recursive: true, force: true });
});

// A pid no process can have, so `kill(pid, 0)` says ESRCH on every platform
// this runs on. The maximum is 2^22 on Linux and lower on Windows.
const DEAD_PID = 4_194_303;

describe("takeEvalsLock", () => {
  it("takes a free lock and names the process holding it", () => {
    const file = path.join(tempDir("tts-lock-"), "tts-evals.lock");
    const lock = takeEvalsLock({ file, what: "--serve" });
    expect(lock.held).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      pid: process.pid,
      what: "--serve",
    });
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  // THE CASE THAT HAPPENED. The second run must not start, and the line it
  // prints has to say who has it — a refusal that names nothing is a refusal
  // nobody can act on.
  it("refuses a lock a live process holds, saying which one", () => {
    const file = path.join(tempDir("tts-lock-"), "tts-evals.lock");
    const first = takeEvalsLock({ file, what: "--serve", now: () => Date.parse("2026-09-14T18:02:00Z") });
    expect(first.held).toBe(true);
    const second = takeEvalsLock({ file, what: "--repo tom.quest --sha aee6483" });
    expect(second.held).toBe(false);
    expect(second.why).toContain(`pid ${process.pid}`);
    expect(second.why).toContain("--serve");
    expect(second.why).toContain("2026-09-14T18:02:00");
    // And the holder's file is untouched by the refusal.
    expect(JSON.parse(fs.readFileSync(file, "utf8")).what).toBe("--serve");
    first.release();
  });

  // A run killed with SIGKILL leaves its file behind. Waiting for a human to
  // delete it would mean the evals stop until somebody notices.
  it("takes a lock whose holder is gone", () => {
    const file = path.join(tempDir("tts-lock-"), "tts-evals.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, at: Date.now(), what: "--weekly" }));
    const lock = takeEvalsLock({ file });
    expect(lock.held).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("takes a lock whose file says nothing readable", () => {
    const file = path.join(tempDir("tts-lock-"), "tts-evals.lock");
    fs.writeFileSync(file, "half a wri");
    const lock = takeEvalsLock({ file });
    expect(lock.held).toBe(true);
    lock.release();
  });

  // Releasing twice is not a second release, and releasing a lock this process
  // no longer owns must not hand away somebody else's.
  it("releases once, and never somebody else's", () => {
    const file = path.join(tempDir("tts-lock-"), "tts-evals.lock");
    const lock = takeEvalsLock({ file });
    lock.release();
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, at: Date.now(), what: "somebody else" }));
    lock.release();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).what).toBe("somebody else");
  });

  it("creates the directory the lock lives in", () => {
    const file = path.join(tempDir("tts-lock-"), "nested", "deeper", "tts-evals.lock");
    const lock = takeEvalsLock({ file });
    expect(lock.held).toBe(true);
    lock.release();
  });
});

describe("pruneStaleWorktrees", () => {
  const tree = (root, repo, name) => {
    const dir = path.join(root, repo, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x");
    return dir;
  };

  it("clears what a dead run left and leaves a live run's tree alone", () => {
    const root = tempDir("tts-evals-work-");
    const dead = tree(root, "tom.quest", `aee6483.${DEAD_PID}`);
    const live = tree(root, "tom.quest", `f5c1fb9.${process.pid}`);
    expect(pruneStaleWorktrees(root)).toEqual([dead]);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  // The age floor is for a directory whose name carries no pid — every
  // worktree made before this round — and for a pid recycled onto something
  // else entirely.
  it("clears an unowned directory only once it is older than a day", () => {
    const root = tempDir("tts-evals-work-");
    const legacy = tree(root, "WikiTom", "origin-main");
    // Made a moment ago: something may well be using it.
    expect(pruneStaleWorktrees(root)).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);
    // A day on, nothing is.
    const later = Date.now() + STALE_WORKTREE_MS + 60_000;
    expect(pruneStaleWorktrees(root, { now: () => later })).toEqual([legacy]);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("is quiet about a work directory that does not exist yet", () => {
    expect(pruneStaleWorktrees(path.join(os.tmpdir(), "tts-evals-never-made"))).toEqual([]);
  });
});
