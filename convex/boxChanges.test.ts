// Box changes on the record's side (plan-root T1 and T3): the shape the door
// holds a box-change row to, the digest lines a change earns, the /agents read,
// the digest's "Box changes" section, the /agents window view's events read,
// and the silence alarm over the box jobs' heartbeats.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  BOX_LEAD,
  composeToday,
  renderSlack,
  todayFactsBlock,
  type TodayFacts,
} from "./ttsCompose";
import {
  AGENTS_WINDOW_URL,
  BOX_CHANGE_HISTORY_COPIED_THROUGH,
  BOX_CHANGE_HISTORY_CUT,
  BOX_CHANGE_SCAN,
  boxChangeFaults,
  boxChangeLines,
  boxChangesInWindow,
  whoCanActLine,
  type BoxChange,
} from "./boxChanges";
import { SILENCE_INTERVALS } from "./ttsJobs";
import {
  DIGEST_READ_BOUND,
  GATHER_BYTES,
  READ_BYTES,
  ROLLOVER_BYTES,
  THREAD_GATHER_BYTES,
  THREAD_OWN_BYTES,
  gatherTodayFacts,
  rollMissed,
} from "./ttsDigest";
import { THREAD_OWN_READS, appendDigestToThread, markSurfaced } from "./jarvis/digest";
import { CONVEX_READ_LIMIT, MAX_DOCUMENT_BYTES, MIB, ReadBudget } from "./readBudget";
import { composeTodayFitted, readCutLine, readCutsLead } from "./ttsCompose";
import { nyCalendarDayBoundsUtc } from "./ttsShared";
import type { MutationCtx } from "./_generated/server";
import { getDocumentSize, type Value } from "convex/values";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const AT = Date.UTC(2026, 8, 25, 5, 8, 34);
const AGENT = "claude:box:bc34b0d6-a223-4529-bfb0-af12442b8c6a";
const TOKEN = `ghp_${"a1B2".repeat(9)}`;

/** ctx.db with every document it returns sized as Convex sizes reads
 *  (getDocumentSize) and added up: the bytes a function reads, whatever path
 *  the read takes (a range walked row by row, a terminal, a get, the row a
 *  patch changes). */
function dbCountingReturnedBytes(db: MutationCtx["db"], add: (bytes: number, doc: Record<string, Value>) => void): MutationCtx["db"] {
  const size = (doc: unknown) => add(getDocumentSize(doc as Record<string, Value>), doc as Record<string, Value>);
  const terminals = new Set<PropertyKey>(["take", "first", "unique", "collect", "paginate"]);
  const wrap = (chain: object): object =>
    new Proxy(chain, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        if (key === Symbol.asyncIterator) {
          return async function* () {
            const iterator = Reflect.apply(member, target, []) as AsyncIterator<unknown>;
            for (;;) {
              const result = await iterator.next();
              if (result.done) return;
              size(result.value);
              yield result.value;
            }
          };
        }
        if (terminals.has(key)) {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(member, target, args) as unknown;
            if (Array.isArray(result)) result.forEach(size);
            else if (result !== null && typeof result === "object" && "page" in result && Array.isArray(result.page)) result.page.forEach(size);
            else if (result !== null) size(result);
            return result;
          };
        }
        return (...args: unknown[]) => {
          const result = Reflect.apply(member, target, args) as unknown;
          return result !== null && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      if (key === "query") return (...args: unknown[]) => wrap(Reflect.apply(member, target, args) as object);
      if (key === "get") return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, args) as unknown;
        if (result !== null) size(result);
        return result;
      };
      // A patch or replace reads the row it changes: counted as a read of it.
      if (key === "patch" || key === "replace") return async (...args: unknown[]) => {
        const before = await target.get(args[0] as never);
        if (before !== null) size(before);
        return await Reflect.apply(member, target, args);
      };
      return member.bind(target);
    },
  });
}

const change = (over: Partial<BoxChange> = {}): BoxChange => ({
  source: "sudo",
  why: "ran-as-root",
  command: "/usr/local/sbin/tts-install-cron",
  cwd: "/home/jarvis",
  user: "jarvis",
  at: AT,
  ...over,
});

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function postEvent(t: ReturnType<typeof convexTest>, body: unknown) {
  return await t.fetch("/tts/event", {
    method: "POST",
    headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const scheduled = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());

/** The rows the digest reads its decisions and broken lines from, oldest first. */
const digestLines = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("events").collect())
      .filter((row) => row.kind === "digest-line")
      .sort((a, b) => a.at - b.at || a._creationTime - b._creationTime),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TTS_WORKER_KEY", "s3cret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function recordEvent(t: ReturnType<typeof convexTest>, body: unknown) {
  return await t.fetch("/jarvis/event", {
    method: "POST",
    headers: { "X-Jarvis-Key": "s3cret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const eventOf = (data: BoxChange) => ({
  kind: "box-change",
  at: data.at,
  provenance: { job: "box-watch", ...(data.agentId === undefined ? {} : { agentId: data.agentId }) },
  data,
});

it("records a worker run through POST /jarvis/event", async () => {
  const t = convexTest({ schema, modules });
  const baseCommit = "a".repeat(40);
  const event = {
    kind: "work-run",
    provenance: { agentId: "codex:box:synthetic-session", job: "work-queue" },
    subject: `example@${baseCommit}`,
    data: {
      repo: "example", remote: "https://example.invalid/repo.git", cwd: "/workspace/example", baseCommit,
      briefKey: "runs/example/brief", preStatePatchKey: "runs/example/pre.patch", resultDiffKey: "runs/example/result.patch",
      bytes: { brief: 120, preStatePatch: 0, resultDiff: 240 }, check: null, checkPassed: null,
      model: "synthetic-model", effort: "high", sandbox: "workspace-write", durationMs: 1234,
      costUsd: 0.01, exitCode: 0, harness: "codex", agentToken: "synthetic-agent-token",
    },
    text: "example on synthetic-model completed",
  };
  expect(await (await recordEvent(t, event)).json()).toMatchObject({ ok: true });
  expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toMatchObject([event]);
});

it("keeps one row when a worker run's row is re-posted with the same data.id, and a new one for another", async () => {
  const t = convexTest({ schema, modules });
  const baseCommit = "b".repeat(40);
  const event = {
    kind: "work-run",
    provenance: { agentId: "codex:box:synthetic-session", job: "work-queue" },
    subject: `example@${baseCommit}`,
    data: {
      id: "work-run:box:run-1",
      repo: "example", remote: "https://example.invalid/repo.git", cwd: "/workspace/example", baseCommit,
      briefKey: "runs/example/brief", preStatePatchKey: "runs/example/pre.patch", resultDiffKey: "runs/example/result.patch",
      bytes: { brief: 120, preStatePatch: 0, resultDiff: 240 }, check: null, checkPassed: null,
      model: "synthetic-model", effort: "high", sandbox: "workspace-write", durationMs: 1234,
      costUsd: 0.01, exitCode: 0, harness: "codex", agentToken: "synthetic-agent-token",
    },
    text: "example on synthetic-model completed",
  };
  const first = await (await recordEvent(t, event)).json();
  expect(first).toMatchObject({ ok: true, duplicate: false });
  expect(await (await recordEvent(t, event)).json()).toEqual({ ok: true, id: first.id, duplicate: true });
  expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(1);
  const other = await (await recordEvent(t, { ...event, data: { ...event.data, id: "work-run:box:run-2" } })).json();
  expect(other).toMatchObject({ ok: true, duplicate: false });
  expect(other.id).not.toBe(first.id);
  expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(2);
});

it("keeps one row when the deploy job re-posts the same disabled part", async () => {
  const t = convexTest({ schema, modules });
  const event = {
    kind: "part-disabled",
    provenance: { job: "deploy" },
    subject: "poll-dump",
    data: { id: "part-disabled:poll-dump", part: "poll-dump", replacedBy: "thread-reply", ruling: "2026-10-02: \"retire slack fully.\"" },
  };
  const first = await (await recordEvent(t, event)).json();
  expect(first).toMatchObject({ ok: true, duplicate: false });
  expect(await (await recordEvent(t, event)).json()).toEqual({ ok: true, id: first.id, duplicate: true });
  expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(1);
});

describe("the box-change door", () => {
  it("records a change posted to POST /jarvis/event under the agent it names, and nothing in dtsEvents", async () => {
    const t = convexTest({ schema, modules });
    const res = await recordEvent(t, eventOf(change({ agentId: AGENT })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "box-change", at: AT, provenance: { job: "box-watch", agentId: AGENT }, data: change({ agentId: AGENT }) });
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });

  it("records a change the legacy pen still receives as the same events row", async () => {
    const t = convexTest({ schema, modules });
    const res = await postEvent(t, { kind: "box-change", key: AGENT, data: change({ agentId: AGENT }) });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "box-change", at: AT, provenance: { job: "box-watch", agentId: AGENT }, data: change({ agentId: AGENT }) });
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });

  it("keeps one row per change when the outbox sends it twice, through either door", async () => {
    const t = convexTest({ schema, modules });
    const sent = change({ agentId: AGENT, id: "s=1;i=a1" });
    expect(await (await postEvent(t, { kind: "box-change", key: AGENT, data: sent })).json()).toMatchObject({ duplicate: false });
    expect(await (await recordEvent(t, eventOf(sent))).json()).toMatchObject({ duplicate: true });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, id: "s=1;i=a2", command: "/usr/bin/true" })))).json()).toMatchObject({ duplicate: false });
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(2);
  });

  // witness: the hook deleted the resend's row and both doors answered with
  // that deleted row's id, which names nothing in the record.
  it("answers a resend with the id of the row that stands, through either door", async () => {
    const t = convexTest({ schema, modules });
    const first = change({ agentId: AGENT, id: "s=1;i=s1" });
    const kept = (await (await recordEvent(t, eventOf(first))).json()) as { id: string };
    const again = (await (await recordEvent(t, eventOf(first))).json()) as { id: string; duplicate: boolean };
    expect(again).toMatchObject({ ok: true, duplicate: true, id: kept.id });
    const second = change({ agentId: AGENT, id: "s=1;i=s2", at: AT + 1 });
    const legacyKept = (await (await postEvent(t, { kind: "box-change", key: AGENT, data: second })).json()) as { id: string };
    const legacyAgain = (await (await postEvent(t, { kind: "box-change", key: AGENT, data: second })).json()) as { id: string };
    expect(legacyAgain).toMatchObject({ ok: true, duplicate: true, id: legacyKept.id });
    const ids = (await t.run(async (ctx) => ctx.db.query("events").collect())).map((row) => row._id as string);
    expect(ids.sort()).toEqual([kept.id, legacyKept.id].sort());
  });

  it("records two identical changes in one millisecond as two, when their ids differ or they carry none", async () => {
    const t = convexTest({ schema, modules });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, id: "s=1;i=b1" })))).json()).toMatchObject({ duplicate: false });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, id: "s=1;i=b2" })))).json()).toMatchObject({ duplicate: false });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT })))).json()).toMatchObject({ duplicate: false });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT })))).json()).toMatchObject({ duplicate: false });
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(4);
  });

  // witness: the resend check read only 50 rows of the millisecond, so a
  // resend of the 51st same-millisecond change was recorded twice.
  it("finds a resend by its id however many changes share its millisecond", async () => {
    const t = convexTest({ schema, modules });
    for (let n = 0; n < 60; n += 1) {
      expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, id: `s=1;i=c${n}` })))).json()).toMatchObject({ duplicate: false });
    }
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, id: "s=1;i=c59" })))).json()).toMatchObject({ duplicate: true });
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(60);
  });

  // witness: the legacy pen's translation labelled a journal gap posted with
  // source "state" as box-state; the journal reader is box-watch.
  it("files a journal gap under the journal reader, box-watch", async () => {
    const t = convexTest({ schema, modules });
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "journal-gap" } }) });
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "sudoers" }, at: AT + 1 }) });
    const rows = (await t.run(async (ctx) => ctx.db.query("events").collect()))
      .filter((row) => row.kind === "box-change")
      .sort((a, b) => a.at - b.at);
    expect(rows.map((row) => row.provenance.job)).toEqual(["box-watch", "box-state"]);
  });

  // witness: the read scanned every event recorded in the window and kept
  // the box changes, so a long catch-up window of other rows could pass a
  // query's read limit and stop every digest. It reads the kind's own index.
  it("reads the window's box changes on their kind's index, past any number of other rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      const liveAt = BOX_CHANGE_HISTORY_CUT + 60 * 60_000;
      vi.setSystemTime(liveAt + 60_000);
      await t.run(async (ctx) => {
        for (let n = 0; n < 2500; n += 1) {
          await ctx.db.insert("events", { kind: "decision", at: liveAt, provenance: {}, subject: `d${n}`, data: {} });
        }
      });
      await recordEvent(t, eventOf(change({ agentId: AGENT, at: liveAt })));
      const rows = await t.run(async (ctx) => boxChangesInWindow(ctx, liveAt, Date.now() + 60_000));
      expect(rows).toHaveLength(1);
      expect(rows[0].command).toBe(change().command);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  // witness: the history migration inserted its copied rows after its event-
  // time cut, so a creation-time lower bound at that cut replayed the copies.
  it("excludes a post-cut history copy and selects a late live change exactly once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      const boundary = BOX_CHANGE_HISTORY_COPIED_THROUGH + 2_000;
      const happenedAt = BOX_CHANGE_HISTORY_CUT - 5 * 60_000;
      vi.setSystemTime(BOX_CHANGE_HISTORY_CUT + 1);
      await t.run(async (ctx) => {
        const old = change({ at: BOX_CHANGE_HISTORY_CUT - 1, id: "copied-history" });
        await ctx.db.insert("events", { ...eventOf(old), provenance: eventOf(old).provenance });
      });
      vi.setSystemTime(BOX_CHANGE_HISTORY_COPIED_THROUGH + 1_000);
      await recordEvent(t, eventOf(change({ agentId: AGENT, at: happenedAt, id: "late-live" })));
      const first = await t.run(async (ctx) => boxChangesInWindow(ctx, BOX_CHANGE_HISTORY_CUT, boundary));
      const second = await t.run(async (ctx) => boxChangesInWindow(ctx, boundary, boundary + 2_000));
      expect(first.map((row) => row.id)).toEqual(["late-live"]);
      expect(second).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the first 2,000 box changes and records the stop on its budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      const recordedAt = BOX_CHANGE_HISTORY_COPIED_THROUGH + 10_000;
      vi.setSystemTime(recordedAt);
      await t.run(async (ctx) => {
        for (let n = 0; n <= BOX_CHANGE_SCAN; n += 1) {
          const data = change({ at: AT + n, id: `window-${n}` });
          await ctx.db.insert("events", { ...eventOf(data), provenance: eventOf(data).provenance });
        }
      });
      const budget = ReadBudget.of(8 * MIB);
      const rows = await t.run(async (ctx) =>
        boxChangesInWindow(ctx, BOX_CHANGE_HISTORY_COPIED_THROUGH + 1, recordedAt + 100, budget.allot("box changes", 8 * MIB)),
      );
      expect(rows).toHaveLength(BOX_CHANGE_SCAN);
      expect(rows[0].id).toBe("window-0");
      expect(rows[BOX_CHANGE_SCAN - 1].id).toBe(`window-${BOX_CHANGE_SCAN - 1}`);
      expect(budget.cuts()).toEqual([{ what: "box changes", read: BOX_CHANGE_SCAN, skipped: 0, by: "rows" }]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("refuses a body without the shape, a key or provenance that is not its agent, and an at that is not its own", async () => {
    const t = convexTest({ schema, modules });
    expect((await postEvent(t, { kind: "box-change", data: { source: "root", why: "ran-as-root", user: "jarvis", at: AT } })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", data: change({ at: Number.NaN as unknown as number }) })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", key: "claude:box:other", data: change({ agentId: AGENT }) })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", key: AGENT, data: change() })).status).toBe(400);
    expect((await recordEvent(t, { ...eventOf(change()), provenance: { job: "box-watch", agentId: AGENT } })).status).toBe(400);
    expect((await recordEvent(t, eventOf(change({ agentId: AGENT })))).status).toBe(200);
    expect((await recordEvent(t, { ...eventOf(change({ agentId: AGENT, command: "/usr/bin/id -u" })), at: AT + 1 })).status).toBe(400);
    expect((await recordEvent(t, { ...eventOf(change()), data: { source: "root" } })).status).toBe(400);
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(1);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toHaveLength(0);
  });

  it("refuses a malformed post that reuses a recorded change's id, rather than answering it as a resend", async () => {
    const t = convexTest({ schema, modules });
    const sent = change({ agentId: AGENT, id: "s=1;i=m1" });
    expect((await recordEvent(t, eventOf(sent))).status).toBe(200);
    // Its provenance names no agent, its at is not its own, its body lacks the shape.
    expect((await recordEvent(t, { ...eventOf(sent), provenance: { job: "box-watch" } })).status).toBe(400);
    expect((await recordEvent(t, { ...eventOf(sent), at: sent.at + 1 })).status).toBe(400);
    expect((await recordEvent(t, { ...eventOf(sent), data: { id: "s=1;i=m1", source: "root" } })).status).toBe(400);
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(1);
  });

  it("names every fault of a malformed body", () => {
    expect(boxChangeFaults(change())).toEqual([]);
    expect(boxChangeFaults({ ...change(), count: 0, commit: "not-hex", change: { what: "" } })).toEqual([
      "data.commit must be a hex commit",
      "data.count must be a positive integer",
      "data.change.what must be a non-empty string",
    ]);
  });
});

describe("the digest read budget", () => {
  it("holds the budgets' sum under Convex's read limit", () => {
    const allotted = Object.values(READ_BYTES).reduce((sum, bytes) => sum + bytes, 0);
    expect(allotted).toBe(GATHER_BYTES);
    expect(DIGEST_READ_BOUND).toBe(GATHER_BYTES + ROLLOVER_BYTES + 2 * MAX_DOCUMENT_BYTES);
    expect(DIGEST_READ_BOUND).toBeLessThan(CONVEX_READ_LIMIT);
  });

  // witness: the prepared todos were read 200 at a time whatever they held,
  // each one's needs fetched whole, and the rollover read every past-dated
  // todo, so 200 todos of 64 KB were 12.8 MB before any other read.
  it("reads at most its byte bound when the sources hold more than Convex's read limit", async () => {
    const t = convexTest({ schema, modules });
    const recordedAt = Date.UTC(2026, 8, 27, 9);
    const now = recordedAt + 60_000;
    const since = recordedAt - 3_600_000;
    const day = "2026-09-27";
    const { start: dayStart } = nyCalendarDayBoundsUtc(day);
    vi.setSystemTime(recordedAt);
    // One explanation as long as the ones the audit named.
    const pad = "x".repeat(64 * 1024);

    let seeded = 0;
    await t.run(async (ctx) => {
      const insert = async (table: "todos" | "dtsEvents" | "events" | "runs", doc: Record<string, unknown>) => {
        const id = await ctx.db.insert(table, doc as never);
        seeded += getDocumentSize((await ctx.db.get(id)) as Record<string, Value>);
        return id;
      };
      const late = [];
      for (let n = 0; n < 60; n += 1) {
        late.push(await insert("todos", {
          statement: `late ${n}`, groundUpExplanation: pad, readiness: "unprepared", status: "active",
          timingClass: "dated", dueAt: dayStart - (n + 1) * 60_000, dateKind: "external", source: "synthetic",
          createdAt: recordedAt - n, updatedAt: recordedAt - n,
        }));
      }
      for (let n = 0; n < 60; n += 1) {
        await insert("todos", {
          statement: `prepared ${n}`, groundUpExplanation: pad, readiness: "prepared", status: "active",
          timingClass: "whenever", needs: [late[n]], source: "synthetic",
          createdAt: recordedAt - n, updatedAt: recordedAt - n,
        });
      }
      for (let n = 0; n < 20; n += 1) {
        await insert("todos", {
          statement: `flagged email ${n}`, groundUpExplanation: pad, needsTomToday: { why: "only Tom can answer" },
          readiness: "unprepared", status: "active", timingClass: "whenever", source: "email",
          createdAt: recordedAt - n, updatedAt: recordedAt - n,
        });
      }
      // Twenty session outcomes, each naming a late todo the gather looks up
      // by id: the lookups' allotment is spent before the last of them.
      for (let n = 0; n < 20; n += 1) {
        await insert("events", { at: recordedAt - n, kind: "session-outcome", provenance: { job: "synthetic" }, subject: late[n], data: {} });
      }
      for (let n = 0; n < 80; n += 1) {
        await insert("dtsEvents", { at: recordedAt - n, kind: "synthetic-note", data: { pad } });
      }
      for (let n = 0; n < 60; n += 1) {
        await insert("runs", {
          runId: `run-${n}`, rootRunId: `run-${n}`, depth: 0, linkKnown: true, origin: pad, host: "box",
          environment: "worker", cli: "claude", parserVersion: "1", kind: "job", status: "ended",
          startedAt: recordedAt - n, lastLineAt: recordedAt - n, attachments: [], ingestedAt: recordedAt,
          file: { path: `run-${n}.jsonl`, sourceHash: "h", storedHash: "h", bytes: 0, storedBytes: 0, committedLine: 0, committedPrefixSha256: "h" },
        });
      }
    });
    // Without the bounds one digest would read every byte seeded.
    expect(seeded).toBeGreaterThan(CONVEX_READ_LIMIT);

    let bytesRead = 0;
    const facts = await t.run(async (ctx) => {
      const counted = { ...ctx, db: dbCountingReturnedBytes(ctx.db, (bytes) => { bytesRead += bytes; }) } as MutationCtx;
      const { cuts } = await rollMissed(counted, day);
      return await gatherTodayFacts(counted, { day, now, since, earlierCuts: cuts });
    });
    expect(bytesRead).toBeLessThanOrEqual(DIGEST_READ_BOUND);
    expect(bytesRead).toBeGreaterThan(8 * MIB);

    const cuts = facts.readCuts ?? [];
    expect(cuts.map((cut) => cut.what)).toEqual(expect.arrayContaining([
      "past-dated todos for the missed rollover",
      "dated todos",
      "email captures",
      "events of the night",
      "prepared todos",
      "needs of prepared todos",
      "rows looked up by id",
      "agent runs",
    ]));
    expect(cuts.find((cut) => cut.what === "rows looked up by id")?.skipped).toBeGreaterThan(0);
    const { message } = composeTodayFitted(facts, { canReply: false });
    expect(renderSlack(message)).toContain(readCutsLead(cuts.length));
    for (const cut of cuts) expect(renderSlack(message)).toContain(readCutLine(cut));
  }, 120_000);

  it("puts only a flagged email without a surfaced row in needs-you", async () => {
    const t = convexTest({ schema, modules });
    const recordedAt = Date.UTC(2026, 8, 27, 9);
    vi.setSystemTime(recordedAt);
    await t.run(async (ctx) => {
      const surfaced = await ctx.db.insert("todos", {
        statement: "surfaced flagged email",
        needsTomToday: { why: "only Tom can answer" },
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "email",
        createdAt: recordedAt,
        updatedAt: recordedAt,
      });
      await ctx.db.insert("dtsEvents", { at: recordedAt, kind: "surfaced", todoId: surfaced, data: { via: "digest", day: "2026-09-26" } });
      // witness: a surfaced row from another writer hid the email from the digest.
      const elsewhere = await ctx.db.insert("todos", {
        statement: "flagged email surfaced elsewhere",
        needsTomToday: { why: "only Tom can answer" },
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "email",
        createdAt: recordedAt + 2,
        updatedAt: recordedAt + 2,
      });
      await ctx.db.insert("dtsEvents", { at: recordedAt, kind: "surfaced", todoId: elsewhere, data: { via: "page" } });
      await ctx.db.insert("todos", {
        statement: "unsurfaced flagged email",
        needsTomToday: { why: "only Tom can answer" },
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "email",
        createdAt: recordedAt + 1,
        updatedAt: recordedAt + 1,
      });
    });

    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, {
      day: "2026-09-27",
      now: recordedAt + 1_000,
      since: recordedAt - 1,
    }));
    expect(facts.needsYou.map((item) => item.statement)).toEqual(["unsurfaced flagged email", "flagged email surfaced elsewhere"]);
  });

  // witness: the prepared read stopped at 200 rows and the ready count was
  // short with no line saying so.
  it("says a read stopped at its row cap and how many rows it read", async () => {
    const t = convexTest({ schema, modules });
    const recordedAt = Date.UTC(2026, 8, 27, 9);
    vi.setSystemTime(recordedAt);
    await t.run(async (ctx) => {
      for (let n = 0; n < 201; n += 1) {
        await ctx.db.insert("todos", {
          statement: `prepared ${n}`, readiness: "prepared", status: "active", timingClass: "whenever",
          source: "synthetic", createdAt: recordedAt - n, updatedAt: recordedAt - n,
        });
      }
    });
    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, {
      day: "2026-09-27",
      now: recordedAt + 1_000,
      since: recordedAt - 1,
    }));
    expect(facts.readyBeyond).toBe(200);
    expect(facts.readCuts).toEqual([{ what: "prepared todos", read: 200, skipped: 0, by: "rows" }]);
    expect(renderSlack(composeTodayFitted(facts, { canReply: false }).message)).toContain(
      "Prepared todos: 200 read, stopped at the row limit.",
    );
  });
  // witness: the thread digest's own reads (its openings scan) were added to
  // the rollover and the gather, 14.5 MiB, and could pass Convex's 16 MiB.
  it("reads at most the same bound in the thread digest, with every read at its cap, and still appends", async () => {
    const own = Object.values(THREAD_OWN_READS).reduce((sum, read) => sum + read.bytes, 0);
    expect(own).toBe(THREAD_OWN_BYTES);
    expect(ROLLOVER_BYTES + THREAD_GATHER_BYTES + THREAD_OWN_BYTES + 3 * MAX_DOCUMENT_BYTES).toBe(DIGEST_READ_BOUND);
    const t = convexTest({ schema, modules });
    const now = Date.UTC(2026, 8, 27, 10); // 06:00 New York
    const day = "2026-09-27";
    const { start: dayStart } = nyCalendarDayBoundsUtc(day);
    vi.setSystemTime(now);
    const pad = "x".repeat(64 * 1024);
    await t.run(async (ctx) => {
      const todo = (n: number, over: Record<string, unknown>) => ctx.db.insert("todos", {
        statement: `todo ${n}`, groundUpExplanation: pad, readiness: "unprepared", status: "active",
        timingClass: "whenever", source: "synthetic", createdAt: now - n, updatedAt: now - n, ...over,
      } as never);
      for (let n = 0; n < 60; n += 1) {
        const late = await todo(n, { timingClass: "dated", dueAt: dayStart - (n + 1) * 60_000, dateKind: "external" });
        await todo(n, { readiness: "prepared", needs: [late] });
        await todo(n, { source: "email", needsTomToday: { why: "only Tom can answer" } });
        await ctx.db.insert("dtsEvents", { at: now - 3_600_000 + n, kind: "synthetic-note", data: { pad } });
      }
      for (let d = 1; d <= 4; d += 1) {
        const at = now - d * 18 * 3_600_000;
        const items = Array.from({ length: 30 }, (_, n) => ({ n: n + 1, key: `listed-${d}-${n}`, text: "y".repeat(2_000) }));
        const digestId = await ctx.db.insert("events", {
          kind: "thread-digest", at, provenance: { job: "digest" }, subject: `day-${d}`, text: "Synthetic daily digest.",
          data: { day: `day-${d}`, windowEnd: at, objectionAskIds: [], items, openingsFrom: now - 4 * 86_400_000 },
        });
        for (let n = 0; n < 50; n += 1) {
          await ctx.db.insert("events", { kind: "thread-needs-you", at: at + n + 1, provenance: { job: "needs-you" },
            subject: digestId, data: { n: 31 + n, key: `later-${d}-${n}` }, text: "z".repeat(2_000) });
        }
      }
      for (let n = 0; n < 40; n += 1) {
        await ctx.db.insert("events", { kind: "needs-you-opened", at: now - 3_600_000 + n, provenance: {},
          subject: `open-${n}`, data: { key: `open-${n}` }, text: "o".repeat(100_000) });
      }
    });
    let bytesRead = 0;
    const answer = await t.run(async (ctx) => appendDigestToThread(
      { ...ctx, db: dbCountingReturnedBytes(ctx.db, (bytes) => { bytesRead += bytes; }) } as MutationCtx));
    expect(answer).toMatchObject({ appended: true, day });
    expect(bytesRead).toBeLessThanOrEqual(DIGEST_READ_BOUND);
    expect(bytesRead).toBeGreaterThan(8 * MIB);
    const digest = await t.run(async (ctx) => (await ctx.db.query("events").collect())
      .find((row) => row.kind === "thread-digest" && row.subject === day));
    expect((digest?.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  // witness: the openings scan fetched its next row before it checked its
  // allotment, and a surfaced mark read its todo twice after one check, so
  // each could read two documents past its allotment.
  it("reads no opening and no surfaced todo more than one document past its allotment", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.UTC(2026, 8, 27, 10); // 06:00 New York
    vi.setSystemTime(now);
    const near = "x".repeat(1_000_000); // a document near Convex's 1 MiB
    const todoIds = await t.run(async (ctx) => {
      for (let n = 0; n < 3; n += 1) {
        await ctx.db.insert("events", { kind: "needs-you-opened", at: now - 3_600_000 + n, provenance: {},
          subject: `near-${n}`, data: { key: `near-${n}` }, text: near });
      }
      return await Promise.all([0, 1].map((n) => ctx.db.insert("todos", {
        statement: `near ${n}`, groundUpExplanation: near, readiness: "unprepared", status: "active",
        timingClass: "whenever", source: "synthetic", createdAt: now, updatedAt: now,
      } as never)));
    });
    let openingBytes = 0;
    await t.run(async (ctx) => appendDigestToThread({ ...ctx, db: dbCountingReturnedBytes(ctx.db, (bytes, doc) => {
      if (doc.kind === "needs-you-opened") openingBytes += bytes;
    }) } as MutationCtx));
    expect(openingBytes).toBeGreaterThan(0);
    expect(openingBytes).toBeLessThanOrEqual(THREAD_OWN_READS.openings.bytes + MAX_DOCUMENT_BYTES);
    let markBytes = 0;
    await t.run(async (ctx) => markSurfaced(
      { ...ctx, db: dbCountingReturnedBytes(ctx.db, (bytes) => { markBytes += bytes; }) } as MutationCtx,
      todoIds, "2026-09-27", ReadBudget.of(THREAD_OWN_READS.surfaced.bytes)));
    expect(markBytes).toBeGreaterThan(0);
    expect(markBytes).toBeLessThanOrEqual(THREAD_OWN_READS.surfaced.bytes + MAX_DOCUMENT_BYTES);
  });
});

describe("the digest lines a change earns", () => {
  it("puts a change to who or what can act on the digest's objection list, and nothing else", () => {
    expect(whoCanActLine(change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "sudoers", after: "/etc/sudoers.d/jarvis: jarvis ALL=(ALL) NOPASSWD: ALL" } })))
      .toBe("The box's sudo rules changed: now /etc/sudoers.d/jarvis: jarvis ALL=(ALL) NOPASSWD: ALL");
    expect(whoCanActLine(change({ source: "user", why: "state", command: undefined, user: "root", change: { what: "users", after: "useradd: new user: name=eve" } })))
      .toBe("An account changed on the box: useradd: new user: name=eve");
    expect(whoCanActLine(change({ command: "/usr/bin/tee /home/jarvis/.ssh/authorized_keys" }))).toBe("jarvis ran as root: /usr/bin/tee /home/jarvis/.ssh/authorized_keys");
    expect(whoCanActLine(change({ source: "systemd", why: "unit", command: undefined, user: "root", change: { what: "systemd-journald.service", after: "stop" } })))
      .toBe("The box's logging unit systemd-journald.service had a stop");
    expect(whoCanActLine(change())).toBeNull();
    expect(whoCanActLine(change({ source: "state", why: "state", command: undefined, change: { what: "packages", after: "jq 1.8" } }))).toBeNull();
    expect(whoCanActLine(change({ command: "read-only: cat ×2", count: 2 }))).toBeNull();
  });

  it("lists the decision line for a sudoers change and the broken line for a journal gap in the digest, and schedules no Slack post", async () => {
    const t = convexTest({ schema, modules });
    await postEvent(t, { kind: "box-change", data: change() });
    expect(await digestLines(t)).toHaveLength(0);
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "sudoers", after: `token ${TOKEN}` } }) });
    let lines = await digestLines(t);
    expect(lines).toHaveLength(1);
    const sudoers = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).find((row) => row.kind === "box-change" && (row.data as BoxChange).change?.what === "sudoers"),
    );
    expect(lines[0].subject).toBe(`box-change:${sudoers!._id}`);
    expect(lines[0].data).toMatchObject({
      section: "decisions",
      askId: `box-change:${sudoers!._id}`,
      reason: "it changes who or what can act on the Jarvis Box",
    });
    expect((lines[0].data as { decision: string }).decision).toMatch(/^The box's sudo rules changed: now token /);
    expect(JSON.stringify(lines[0])).not.toContain(TOKEN);
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "journal-gap", before: "2026-09-25T05:08:34.000Z", after: "2026-09-25T06:08:34.000Z" } }) });
    lines = await digestLines(t);
    expect(lines).toHaveLength(2);
    expect(lines[1].subject).toBe("box-watch:journal-gap");
    expect(lines[1].data).toMatchObject({
      section: "broken",
      job: "box-watch:journal-gap",
      statement: "The box's journal lost entries the box-change reader had not read, from 2026-09-25T05:08:34.000Z to 2026-09-25T06:08:34.000Z, so changes to the machine in that span are not in the record.",
      url: AGENTS_WINDOW_URL,
    });
    expect((await scheduled(t)).filter((job) => job.name.includes("ttsSync"))).toEqual([]);
  });
});

describe("the /agents read", () => {
  it("answers one agent's changes, oldest first, with their commands redacted, to Tom alone", async () => {
    const t = convexTest({ schema, modules });
    await postEvent(t, { kind: "box-change", key: AGENT, data: change({ agentId: AGENT, at: AT + 5, command: `/usr/bin/curl -H token\\ ${TOKEN} https://api.github.com` }) });
    await postEvent(t, { kind: "box-change", key: AGENT, data: change({ agentId: AGENT, at: AT, command: "read-only: cat ×2", count: 2 }) });
    await postEvent(t, { kind: "box-change", data: change() });
    const tom = await withTom(t);
    const rows = await tom.query(api.boxChanges.forAgent, { agentId: AGENT });
    expect(rows.map((row) => row.at)).toEqual([AT, AT + 5]);
    expect(rows[1].command).toContain("[redacted:github]");
    expect(rows[1].command).not.toContain(TOKEN);
    await expect(t.query(api.boxChanges.forAgent, { agentId: AGENT })).rejects.toThrow();
  });

  // witness: the read walked every row the agent wrote (events.by_agent_at)
  // and kept the box changes, so an agent with enough other rows passed the
  // query's read limit and its /agents chat failed to load.
  // convex-test counts only the rows a query returns toward the read limit,
  // where Convex counts every row a filter looked at, so the test records the
  // queries the read makes: an index range that is all box changes, with no
  // filter after it, is one whose rows read are the rows returned.
  it("reads an agent's box changes without reading the agent's other rows", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let n = 0; n < 700; n += 1) {
        await ctx.db.insert("events", { kind: "job-ok", at: AT - 1_000 + n, provenance: { agentId: AGENT }, subject: `j${n}`, data: {} });
      }
    });
    await recordEvent(t, eventOf(change({ agentId: AGENT })));
    const tom = await withTom(t);
    const runtime = globalThis as unknown as { Convex: { syscall: (op: string, args: string) => string } };
    const convexGlobal = runtime.Convex;
    const queries: { source: { indexName?: string; range?: unknown[] }; operators: Record<string, unknown>[] }[] = [];
    runtime.Convex = {
      get asyncSyscall() {
        return (convexGlobal as unknown as { asyncSyscall: unknown }).asyncSyscall;
      },
      get jsSyscall() {
        return (convexGlobal as unknown as { jsSyscall: unknown }).jsSyscall;
      },
      syscall: (op: string, args: string) => {
        if (op === "1.0/queryStream") queries.push((JSON.parse(args) as { query: (typeof queries)[number] }).query);
        return convexGlobal.syscall(op, args);
      },
    } as unknown as typeof convexGlobal;
    let rows;
    try {
      rows = await tom.query(api.boxChanges.forAgent, { agentId: AGENT });
    } finally {
      runtime.Convex = convexGlobal;
    }
    expect(rows.map((row) => row.at)).toEqual([AT]);
    const reads = queries.filter((query) => query.source.indexName?.startsWith("events."));
    expect(reads).toHaveLength(1);
    expect(reads[0].source.indexName).toBe("events.by_kind_agent_at");
    expect(JSON.stringify(reads[0].source.range)).toContain('"box-change"');
    expect(reads[0].operators.filter((operator) => "filter" in operator)).toEqual([]);
  });
});

describe("the digest's Box changes", () => {
  const changes: BoxChange[] = [
    change({ agentId: AGENT, command: "read-only: cat ×2, systemctl ×1", count: 3 }),
    change({ agentId: AGENT, at: AT + 1, command: "/usr/bin/apt-get install -y jq" }),
    change({ agentId: AGENT, at: AT + 2, command: "/usr/bin/systemctl restart nginx" }),
    change({ at: AT + 3 }),
    change({ source: "setup", why: "setup", command: "/usr/bin/bash worker/setup.sh", commit: "0123456789abcdef0123456789abcdef01234567", change: { what: "setup", after: "folded: 1 daemon reloads, 2 unit changes" } }),
    change({ source: "deploy", why: "deploy", command: undefined, commit: "888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b" }),
    change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "packages", before: "jq 1.7", after: "jq 1.8" } }),
    change({ source: "systemd", why: "unit", command: undefined, user: "root", change: { what: "tts-session-host.service", after: "stop" } }),
    change({ source: "ssh", why: "login", command: undefined, user: "jarvis", count: 2, change: { what: "login", after: "jarvis from 192.0.2.10 by publickey" } }),
    change({ source: "ssh", why: "login", command: undefined, user: "root", change: { what: "login", after: "root from 192.0.2.10 by publickey" } }),
  ];

  it("says one line per agent, per deploy and per setup run, and one per other kind of change", () => {
    const lines = boxChangeLines(changes, [{ at: AT, repo: "Jarvis", to: "888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b", commits: ["a", "b"] }]);
    expect(lines).toEqual([
      {
        id: `box:agent:${AGENT}`,
        text: "An agent ran 5 root commands, 2 changed the machine: apt-get install -y jq; systemctl restart nginx.",
        url: `https://tom.quest/agents?agent=${encodeURIComponent(AGENT)}`,
      },
      { id: "box:unmatched", text: "Root commands no agent was matched to: ran 1 root command, 1 changed the machine: tts-install-cron.", url: AGENTS_WINDOW_URL },
      { id: `box:deploy:888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b@${AT}`, text: "The box deployed Jarvis 888b43a, 2 commits.", url: AGENTS_WINDOW_URL },
      { id: `box:setup:0123456789abcdef0123456789abcdef01234567@${AT}`, text: "Setup ran as root at 0123456, 1 daemon reloads, 2 unit changes.", url: AGENTS_WINDOW_URL },
      { id: "box:state:packages", text: "The package list changed: jq 1.8.", url: AGENTS_WINDOW_URL },
      { id: "box:units", text: "Units changed outside a root command: tts-session-host.service stop.", url: AGENTS_WINDOW_URL },
      { id: "box:logins", text: "3 ssh logins reached the box: jarvis 2, root 1.", url: AGENTS_WINDOW_URL },
    ]);
  });

  it("gives two setup runs and two deploy markers at one commit their own ids", () => {
    const twice = [AT, AT + 60_000].flatMap((at) => [
      change({ source: "setup", why: "setup", command: undefined, commit: "0123456", at }),
      change({ source: "deploy", why: "deploy", command: undefined, commit: "abcdef0", at }),
    ]);
    const ids = boxChangeLines(twice).map((line) => line.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("is the digest's last run, and a written line citing one of its facts passes the verifier", () => {
    const boxChanges = boxChangeLines(changes);
    const facts: TodayFacts = {
      day: "2026-09-25",
      today: [],
      lateCount: 0,
      readyBeyond: 0,
      objections: [],
      needsYou: [],
      overnightByTodo: [],
      broken: [],
      boxChanges,
    };
    const message = composeToday(facts, { canReply: false });
    const box = message.lines.filter((line) => line.section === "box");
    expect(box[0]).toEqual({ role: "lead", section: "box", text: BOX_LEAD });
    expect(box.slice(1).map((line) => line.text)).toEqual(boxChanges.map((fact) => fact.text));
    expect(renderSlack(message)).toContain("An agent ran 5 root commands");

    const block = todayFactsBlock(facts, false);
    const agentFact = block.facts.find((fact) => fact.id === `box:agent:${AGENT}`);
    expect(agentFact?.numbers).toEqual(["5", "2"]);
  });
});

describe("the /agents window view's box lane", () => {
  it("returns box changes from events, whole but redacted, and the deploy rows' commits from dtsEvents", async () => {
    const t = convexTest({ schema, modules });
    vi.setSystemTime(AT + 30_000);
    await recordEvent(t, eventOf(change({ agentId: AGENT, command: `/usr/bin/env TOKEN=${TOKEN} true` })));
    await postEvent(t, { kind: "deploy", key: "Jarvis:888b43a0", data: { repo: "Jarvis", from: "1cdb2c2", to: "888b43a", commits: ["x"], setupNeeded: false } });
    const tom = await withTom(t);
    const win = { from: AT - 60_000, to: AT + 60_000, paginationOpts: { numItems: 50, cursor: null } };
    const record = await tom.query(api.observe.recordInWindow, win);
    const box = record.page.find((event) => event.kind === "box-change");
    expect(box?.data).toMatchObject({ source: "sudo", user: "jarvis", at: AT });
    expect(box?.agentId).toBe(AGENT);
    expect(JSON.stringify(box?.data)).not.toContain(TOKEN);
    // The deploy's home is still dtsEvents; its copy in events is not read twice.
    expect(record.page.find((event) => event.kind === "deploy")).toBeUndefined();
    const old = await tom.query(api.observe.eventsInWindow, win);
    expect(old.page.find((event) => event.kind === "box-change")).toBeUndefined();
    expect(old.page.find((event) => event.kind === "deploy")?.data).toEqual({ repo: "Jarvis", from: "1cdb2c2", to: "888b43a" });
  });
});

describe("the silence alarm", () => {
  const ok = (t: ReturnType<typeof convexTest>, job: string) =>
    t.fetch("/tts/job-ok", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ job, key: `${job}:read` }),
    });

  it("watches nothing until a job's first clean run", async () => {
    const t = convexTest({ schema, modules });
    // Before 6 a.m. New York, so the late-digest line is not due either.
    vi.setSystemTime(AT);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    expect(await scheduled(t)).toHaveLength(0);
  });

  // witness: the record sent "The write-slack job has not run clean" to Slack
  // each morning from 2026-09-30, and held a standing write-slack:silent
  // condition from 2026-10-04, for a job that Jarvis then deleted.
  it("does not watch write-slack, which Jarvis deleted, and sends nothing to Slack", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "C0TODAY");
    vi.setSystemTime(AT);
    await ok(t, "write-slack");
    vi.setSystemTime(AT + 60 * 60_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((row) => row.kind === "silence-alarm" || row.kind === "job-failed")).toEqual([]);
    expect(await scheduled(t)).toEqual([]);
    const slack = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === "slack-sent"));
    expect(slack).toEqual([]);
  });

  it("posts one line when a heartbeat is three intervals old, and writes the recovery when it beats again", async () => {
    const t = convexTest({ schema, modules });
    // The alarm's line goes to the Jarvis thread, with a web push.
    vi.setSystemTime(AT);
    await ok(t, "agents-sweep");
    await ok(t, "tick:pull-requests");
    // The heartbeat is the job-ok row itself (convex/jarvis/jobs.ts lastOkAt).
    const beats = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(beats.map((beat) => [beat.kind, beat.provenance.job, beat.at]).sort()).toEqual([
      ["job-ok", "agents-sweep", AT],
      ["job-ok", "tick:pull-requests", AT],
    ]);

    // Two intervals and a bit: quiet, not yet silent.
    vi.setSystemTime(AT + 2 * 2 * 60_000 + 30_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });

    // Past three of the sweep's two-minute intervals; the landing observer's five are not.
    vi.setSystemTime(AT + SILENCE_INTERVALS * 2 * 60_000 + 1_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["agents-sweep"], recovered: [] });
    // Said once, however many passes find it still silent.
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["agents-sweep"], recovered: [] });
    const failed = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(failed.filter((row) => row.kind === "job-failed").map((row) => row.subject)).toEqual(["agents-sweep:silent"]);
    const lines = failed.filter((row) => row.kind === "silence-alarm");
    expect(lines.map((row) => row.subject)).toEqual(["agents-sweep:silent"]);
    expect(lines[0].text).toContain("has not run clean for 6 minutes");
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("sendToAll");
    expect(jobs[0].args[0]).toMatchObject({ title: "Silence alarm", body: lines[0].text, url: "/thread" });

    await ok(t, "agents-sweep");
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: ["agents-sweep"] });
    const recovered = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(recovered.filter((row) => row.kind === "job-recovered").map((row) => row.subject)).toEqual(["agents-sweep:silent"]);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });

  // The landing observer is the record's pull-requests tick task; its job-ok
  // is written by tick.ts complete, under provenance.job `tick:pull-requests`.
  const landingObserverRanClean = async (t: ReturnType<typeof convexTest>, at: number) => {
    vi.setSystemTime(at);
    const leaseId = await t.run(async (ctx) =>
      ctx.db.insert("events", { kind: "tick-started", at, provenance: { job: "tick:pull-requests" }, subject: "tick:pull-requests", data: {} }));
    await t.mutation(internal.jarvis.tick.complete, { name: "pull-requests", leaseId });
  };

  it("raises the line when the landing observer's newest clean run is sixteen minutes old", async () => {
    const t = convexTest({ schema, modules });
    await landingObserverRanClean(t, AT);
    vi.setSystemTime(AT + 16 * 60_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["tick:pull-requests"], recovered: [] });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    const lines = rows.filter((row) => row.kind === "silence-alarm");
    expect(lines.map((row) => row.subject)).toEqual(["tick:pull-requests:silent"]);
    expect(lines[0].text).toBe(
      "The pull-requests task (the landing observer) has not run clean for 16 minutes (it runs every 5 minutes), so the open pull requests and their landings after that are not reaching the record.",
    );
  });

  it("stays quiet when the landing observer's newest clean run is four minutes old", async () => {
    const t = convexTest({ schema, modules });
    await landingObserverRanClean(t, AT);
    vi.setSystemTime(AT + 4 * 60_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((row) => row.kind === "silence-alarm" || row.kind === "job-failed")).toEqual([]);
  });
});
