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
  boxChangeFaults,
  boxChangeLines,
  whoCanActLine,
  type BoxChange,
} from "./boxChanges";
import { SILENCE_INTERVALS } from "./ttsJobs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const AT = Date.UTC(2026, 8, 25, 5, 8, 34);
const AGENT = "claude:box:bc34b0d6-a223-4529-bfb0-af12442b8c6a";
const TOKEN = `ghp_${"a1B2".repeat(9)}`;

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
    expect(await (await postEvent(t, { kind: "box-change", key: AGENT, data: change({ agentId: AGENT }) })).json()).toMatchObject({ duplicate: false });
    expect(await (await recordEvent(t, eventOf({ agentId: AGENT, ...change() }))).json()).toMatchObject({ duplicate: true });
    expect(await (await recordEvent(t, eventOf(change({ agentId: AGENT, command: "/usr/bin/true" })))).json()).toMatchObject({ duplicate: false });
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(2);
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

  it("names every fault of a malformed body", () => {
    expect(boxChangeFaults(change())).toEqual([]);
    expect(boxChangeFaults({ ...change(), count: 0, commit: "not-hex", change: { what: "" } })).toEqual([
      "data.commit must be a hex commit",
      "data.count must be a positive integer",
      "data.change.what must be a non-empty string",
    ]);
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
      { id: "box:deploy:888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b", text: "The box deployed Jarvis 888b43a, 2 commits.", url: AGENTS_WINDOW_URL },
      { id: "box:setup:0123456789abcdef0123456789abcdef01234567", text: "Setup ran as root at 0123456, 1 daemon reloads, 2 unit changes.", url: AGENTS_WINDOW_URL },
      { id: "box:state:packages", text: "The package list changed: jq 1.8.", url: AGENTS_WINDOW_URL },
      { id: "box:units", text: "Units changed outside a root command: tts-session-host.service stop.", url: AGENTS_WINDOW_URL },
      { id: "box:logins", text: "3 ssh logins reached the box: jarvis 2, root 1.", url: AGENTS_WINDOW_URL },
    ]);
  });

  it("is the digest's last run, and a written line citing one of its facts passes the verifier", () => {
    const boxChanges = boxChangeLines(changes);
    const facts: TodayFacts = {
      day: "2026-09-25",
      today: [],
      lateCount: 0,
      readyBeyond: 0,
      calendar: [],
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

  it("posts one line when a heartbeat is three intervals old, and writes the recovery when it beats again", async () => {
    const t = convexTest({ schema, modules });
    // The alarm's line goes to the one output channel.
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "C0TODAY");
    vi.setSystemTime(AT);
    await ok(t, "box-watch");
    await ok(t, "box-state");
    // The heartbeat is the job-ok row itself (convex/jarvis/jobs.ts lastOkAt).
    const beats = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(beats.map((beat) => [beat.kind, beat.provenance.job, beat.at]).sort()).toEqual([
      ["job-ok", "box-state", AT],
      ["job-ok", "box-watch", AT],
    ]);

    // Two intervals and a bit: quiet, not yet silent.
    vi.setSystemTime(AT + 2 * 2 * 60_000 + 30_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });

    // Past three of box-watch's two-minute intervals; box-state's ten are not.
    vi.setSystemTime(AT + SILENCE_INTERVALS * 2 * 60_000 + 1_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["box-watch"], recovered: [] });
    // Said once, however many passes find it still silent.
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["box-watch"], recovered: [] });
    const failed = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(failed.filter((row) => row.kind === "job-failed").map((row) => row.subject)).toEqual(["box-watch:silent"]);
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("sendSlack");
    expect(jobs[0].args[0]).toMatchObject({ channel: "C0TODAY", subject: { kind: "job", id: "box-watch:silent" } });
    expect(String((jobs[0].args[0] as { text: string }).text)).toContain("has not run clean for 6 minutes");

    await ok(t, "box-watch");
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: ["box-watch"] });
    const recovered = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(recovered.filter((row) => row.kind === "job-recovered").map((row) => row.subject)).toEqual(["box-watch:silent"]);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });
});
