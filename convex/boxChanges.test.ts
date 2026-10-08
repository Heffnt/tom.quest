// Box changes on the record's side (plan-root T1 and T3): the shape the door
// holds a box-change row to, the resends it answers with the row that stands,
// the /agents read, the history page's box-change lines, and the silence alarm
// over the box jobs' heartbeats.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  boxChangeFaults,
  boxChangeLines,
  type BoxChange,
} from "./boxChanges";
import { SILENCE_INTERVALS } from "./ttsJobs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const AT = Date.UTC(2026, 8, 25, 5, 8, 34);
const AGENT = "claude:box:bc34b0d6-a223-4529-bfb0-af12442b8c6a";
const TOKEN = `ghp_${"a1B2".repeat(9)}`;
/** Where the history page links a box change no one agent owns. */
const AGENTS_WINDOW_URL = "/agents?view=window";

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

describe("the history page's box-change lines", () => {
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
    change({ source: "state", why: "state", command: undefined, user: "unknown", at: AT + 4, change: { what: "journal-gap", before: "2026-09-25T05:08:34.000Z", after: "2026-09-25T06:08:34.000Z" } }),
    change({ source: "state", why: "state", command: undefined, user: "unknown", at: AT + 5, change: { what: "journal-gap" } }),
  ];

  it("says one line per agent, per deploy, per setup run and per journal gap, and one per other kind of change", () => {
    const lines = boxChangeLines(changes, [{ at: AT, repo: "Jarvis", to: "888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b", commits: ["a", "b"] }]);
    expect(lines).toEqual([
      {
        id: `box:agent:${AGENT}`,
        text: "An agent ran 5 root commands, 2 changed the machine: apt-get install -y jq; systemctl restart nginx.",
        url: `/agents?agent=${encodeURIComponent(AGENT)}`,
      },
      { id: "box:unmatched", text: "Root commands no agent was matched to: ran 1 root command, 1 changed the machine: tts-install-cron.", url: AGENTS_WINDOW_URL },
      { id: `box:deploy:888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b@${AT}`, text: "The box deployed Jarvis 888b43a, 2 commits.", url: AGENTS_WINDOW_URL },
      { id: `box:setup:0123456789abcdef0123456789abcdef01234567@${AT}`, text: "Setup ran as root at 0123456, 1 daemon reloads, 2 unit changes.", url: AGENTS_WINDOW_URL },
      { id: "box:state:packages", text: "The package list changed: jq 1.8.", url: AGENTS_WINDOW_URL },
      {
        id: `box:journal-gap:${AT + 4}`,
        text: "The journal lost entries the reader had not read, from 2026-09-25T05:08:34.000Z to 2026-09-25T06:08:34.000Z; the record has a gap there.",
        url: AGENTS_WINDOW_URL,
      },
      { id: `box:journal-gap:${AT + 5}`, text: "The journal lost entries the reader had not read; the record has a gap there.", url: AGENTS_WINDOW_URL },
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
    vi.setSystemTime(AT);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    expect(await scheduled(t)).toHaveLength(0);
  });

  // witness: the record sent "The write-slack job has not run clean" each
  // morning from 2026-09-30, and held a standing write-slack:silent
  // condition from 2026-10-04, for a job that Jarvis then deleted.
  it("does not watch write-slack, which Jarvis deleted", async () => {
    const t = convexTest({ schema, modules });
    vi.setSystemTime(AT);
    await ok(t, "write-slack");
    vi.setSystemTime(AT + 60 * 60_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((row) => row.kind === "silence-alarm" || row.kind === "job-failed")).toEqual([]);
    expect(await scheduled(t)).toEqual([]);
  });

  it("posts one line when a heartbeat is three intervals old, and writes the recovery when it beats again", async () => {
    const t = convexTest({ schema, modules });
    // The alarm's row links to /sessions, and its web push opens it.
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
    expect(lines[0].data).toMatchObject({ job: "agents-sweep", href: "/sessions" });
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("sendToAll");
    expect(jobs[0].args[0]).toMatchObject({ title: "Silence alarm", body: lines[0].text, url: "/sessions" });

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
