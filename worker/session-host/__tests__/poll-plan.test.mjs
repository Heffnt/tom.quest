// The poll walk's per-row decision (worker/session-host/poll-plan.mjs). The
// case this file exists for: a fork ("reopen as", forkedFrom set) is NOT
// claimed while its source is still in the poll's live list, and is claimed
// on the first poll where the source is gone — so the transcript it
// snapshots is the source's whole transcript, ending included.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.

import { describe, expect, it } from "vitest";

import { planRow } from "../poll-plan.mjs";

const liveIds = (...ids) => new Set(ids.map(String));
const local = (status, extra = {}) => ({ status, dead: false, isDrained: () => true, ...extra });

describe("planRow: fresh rows", () => {
  it("claims a requested row", () => {
    expect(planRow({ id: "a", status: "requested" }, { local: undefined, liveIds: liveIds("a") })).toBe("claim");
  });

  it("claims a starting row that never got an SDK id (a daemon died mid-claim)", () => {
    expect(planRow({ id: "a", status: "starting" }, { local: undefined, liveIds: liveIds("a") })).toBe("claim");
  });

  it("adopts a starting row that has an SDK id, and every other live status", () => {
    for (const row of [
      { id: "a", status: "starting", sdkSessionId: "sdk-1" },
      { id: "a", status: "idle" },
      { id: "a", status: "running" },
    ]) {
      expect(planRow(row, { local: undefined, liveIds: liveIds("a") })).toBe("adopt");
    }
  });
});

describe("planRow: a fork waits for its source to end", () => {
  const fork = { id: "fork", status: "requested", forkedFrom: "src" };

  it("is deferred while the source is still listed live", () => {
    expect(planRow(fork, { local: undefined, liveIds: liveIds("src", "fork") })).toBe("defer-fork");
  });

  it("is claimed once the source has left the live list", () => {
    expect(planRow(fork, { local: undefined, liveIds: liveIds("fork") })).toBe("claim");
  });

  it("a poll sequence: deferred, deferred, then claimed the poll the source is gone", () => {
    const polls = [
      [{ id: "src", status: "running" }, fork],
      [{ id: "src", status: "idle" }, fork],
      [fork],
    ];
    const seen = polls.map((rows) =>
      planRow(fork, { local: undefined, liveIds: liveIds(...rows.map((r) => r.id)) }),
    );
    expect(seen).toEqual(["defer-fork", "defer-fork", "claim"]);
  });

  it("the deferral also covers a mid-claim restart of the fork itself", () => {
    const halfClaimed = { id: "fork", status: "starting", forkedFrom: "src" };
    expect(planRow(halfClaimed, { local: undefined, liveIds: liveIds("src", "fork") })).toBe("defer-fork");
    expect(planRow(halfClaimed, { local: undefined, liveIds: liveIds("fork") })).toBe("claim");
  });

  it("a null forkedFrom is not a fork", () => {
    expect(planRow({ id: "a", status: "requested", forkedFrom: null }, { local: undefined, liveIds: liveIds("a") })).toBe("claim");
  });

  it("never defers a row this daemon already holds", () => {
    expect(planRow(fork, { local: local("idle"), liveIds: liveIds("src", "fork") })).toBe("reconcile");
  });
});

describe("planRow: rows this daemon already holds", () => {
  it("reconciles a live local", () => {
    for (const status of ["starting", "idle", "running"]) {
      expect(planRow({ id: "a", status }, { local: local(status), liveIds: liveIds("a") })).toBe("reconcile");
    }
  });

  it("waits for an over-but-undrained local (its ending flush still owes rows)", () => {
    expect(planRow({ id: "a", status: "idle" }, { local: local("ended", { isDrained: () => false }), liveIds: liveIds("a") })).toBe("wait");
  });

  it("re-adopts a drained ended/failed local listed live again (a reopen)", () => {
    expect(planRow({ id: "a", status: "idle" }, { local: local("ended"), liveIds: liveIds("a") })).toBe("readopt");
    expect(planRow({ id: "a", status: "idle" }, { local: local("failed"), liveIds: liveIds("a") })).toBe("readopt");
  });

  it("re-adopts a force-killed local without waiting (dead means gone)", () => {
    expect(planRow({ id: "a", status: "idle" }, { local: local("running", { dead: true, isDrained: () => false }), liveIds: liveIds("a") })).toBe("readopt");
  });
});
