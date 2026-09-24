import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { reapUnlisted, removeOrphanWorkdirs, removeWorkdir } from "../workdir.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "session-workdir-"));

/** A session workdir with one repo checkout in it, and a refused payload if asked. */
function workdir(base, id, { overflow = null } = {}) {
  const dir = path.join(base, id);
  fs.mkdirSync(path.join(dir, "tom.quest", ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tom.quest", "AGENTS.md"), "# tom.Quest\n");
  if (overflow !== null) {
    fs.mkdirSync(path.join(dir, "overflow"), { recursive: true });
    fs.writeFileSync(path.join(dir, "overflow", "41"), overflow);
  }
  return dir;
}

/** A local Session as the reap step sees it. */
function local(status, { dead = false, drained = true } = {}) {
  return {
    status,
    dead,
    killed: null,
    isDrained: () => drained,
    forceKill(reason) {
      this.killed = reason;
      this.dead = true;
    },
  };
}

describe("removeWorkdir", () => {
  it("deletes the workdir of the session it names", () => {
    const base = root();
    const dir = workdir(base, "s1");
    expect(removeWorkdir("s1", { root: base })).toBe("deleted");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps overflow/ when it holds a refused payload", () => {
    const base = root();
    const dir = workdir(base, "s1", { overflow: "payload" });
    expect(removeWorkdir("s1", { root: base })).toBe("kept-overflow");
    expect(fs.readdirSync(dir)).toEqual(["overflow"]);
    expect(fs.readFileSync(path.join(dir, "overflow", "41"), "utf8")).toBe("payload");
  });

  it("answers null for a workdir that is not there", () => {
    expect(removeWorkdir("gone", { root: root() })).toBe(null);
  });
});

describe("reapUnlisted", () => {
  // The hole: cleanupWorkdir runs only in the process that ends the session,
  // so a session another process ended (a force-close from the page, a stop
  // on a session this daemon adopted idle) left its clone for good.
  it("deletes the workdir of a session force-closed from the page", () => {
    const base = root();
    const dir = workdir(base, "s1");
    const s = local("running");
    const sessions = new Map([["s1", s]]);
    reapUnlisted(sessions, new Set(), { remove: (id) => removeWorkdir(id, { root: base }) });
    expect(s.killed).toBe("server no longer lists this session");
    expect(sessions.has("s1")).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes the workdir of an adopted idle session that ended server-side", () => {
    const base = root();
    const dir = workdir(base, "s1");
    const sessions = new Map([["s1", local("idle")]]);
    reapUnlisted(sessions, new Set(), { remove: (id) => removeWorkdir(id, { root: base }) });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes the workdir of a force-killed session", () => {
    const base = root();
    const dir = workdir(base, "s1");
    const sessions = new Map([["s1", local("ended", { dead: true, drained: false })]]);
    reapUnlisted(sessions, new Set(), { remove: (id) => removeWorkdir(id, { root: base }) });
    expect(sessions.size).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("waits for an ended session's outbox to drain before it reaps", () => {
    const removed = [];
    const sessions = new Map([["s1", local("ended", { drained: false })]]);
    reapUnlisted(sessions, new Set(), { remove: (id) => removed.push(id) });
    expect(sessions.has("s1")).toBe(true);
    expect(removed).toEqual([]);
  });

  it("leaves a listed session and its workdir alone", () => {
    const base = root();
    const dir = workdir(base, "s1");
    const s = local("idle");
    const sessions = new Map([["s1", s]]);
    reapUnlisted(sessions, new Set(["s1"]), { remove: (id) => removeWorkdir(id, { root: base }) });
    expect(s.killed).toBe(null);
    expect(sessions.has("s1")).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("removeOrphanWorkdirs", () => {
  it("deletes the workdirs of sessions that ended while no daemon ran", () => {
    const base = root();
    workdir(base, "ended");
    const live = workdir(base, "live");
    const held = workdir(base, "held");
    const rescued = workdir(base, "rescued", { overflow: "payload" });
    const removed = removeOrphanWorkdirs({ known: new Set(["live", "held"]), root: base });
    expect(removed.sort()).toEqual(["ended", "rescued"]);
    expect(fs.readdirSync(base).sort()).toEqual(["held", "live", "rescued"]);
    expect(fs.existsSync(path.join(live, "tom.quest"))).toBe(true);
    expect(fs.existsSync(path.join(held, "tom.quest"))).toBe(true);
    expect(fs.readdirSync(rescued)).toEqual(["overflow"]);
  });

  it("answers empty when the sessions root does not exist yet", () => {
    expect(removeOrphanWorkdirs({ known: new Set(), root: path.join(root(), "missing") })).toEqual([]);
  });
});
