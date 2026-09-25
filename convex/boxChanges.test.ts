// Box changes on the record's side (plan-root T1 and T3): the shape the door
// holds a box-change row to, the Slack lines a change earns, the /agents read,
// the digest's "Box changes" section, the /observe events read, and the
// silence alarm over the box jobs' heartbeats.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  BOX_LEAD,
  composeToday,
  renderSlack,
  todayFactsBlock,
  verifyDraft,
  type TodayFacts,
} from "./ttsCompose";
import {
  OBSERVE_URL,
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TTS_WORKER_KEY", "s3cret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the box-change door", () => {
  it("takes the fixed shape and files it under the agent it names", async () => {
    const t = convexTest({ schema, modules });
    const res = await postEvent(t, { kind: "box-change", key: AGENT, data: change({ agentId: AGENT }) });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "box-change", key: AGENT, data: change({ agentId: AGENT }) });
  });

  it("refuses a body without the shape, and a key that is not its agent", async () => {
    const t = convexTest({ schema, modules });
    expect((await postEvent(t, { kind: "box-change", data: { source: "root", why: "ran-as-root", user: "jarvis", at: AT } })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", data: change({ at: Number.NaN as unknown as number }) })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", key: "claude:box:other", data: change({ agentId: AGENT }) })).status).toBe(400);
    expect((await postEvent(t, { kind: "box-change", key: AGENT, data: change() })).status).toBe(400);
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

describe("the Slack lines a change earns", () => {
  it("puts a change to who or what can act in #tts-decisions, and nothing else", () => {
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

  it("schedules the decision line for a sudoers change and the broken line for a journal gap", async () => {
    const t = convexTest({ schema, modules });
    await postEvent(t, { kind: "box-change", data: change() });
    expect(await scheduled(t)).toHaveLength(0);
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "sudoers", after: `token ${TOKEN}` } }) });
    let jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("sendDecision");
    expect(JSON.stringify(jobs[0].args)).not.toContain(TOKEN);
    await postEvent(t, { kind: "box-change", data: change({ source: "state", why: "state", command: undefined, user: "unknown", change: { what: "journal-gap", before: "2026-09-25T05:08:34.000Z", after: "2026-09-25T06:08:34.000Z" } }) });
    jobs = await scheduled(t);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].name).toContain("sendBroken");
    expect(jobs[1].args[0]).toMatchObject({ job: "box-watch:journal-gap" });
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
      { id: "box:unmatched", text: "Root commands no agent was matched to: ran 1 root command, 1 changed the machine: tts-install-cron.", url: OBSERVE_URL },
      { id: "box:deploy:888b43a0e41c5d3b0f3c9f1e0a1b2c3d4e5f6a7b", text: "The box deployed Jarvis 888b43a, 2 commits.", url: OBSERVE_URL },
      { id: "box:setup:0123456789abcdef0123456789abcdef01234567", text: "Setup ran as root at 0123456, 1 daemon reloads, 2 unit changes.", url: OBSERVE_URL },
      { id: "box:state:packages", text: "The package list changed: jq 1.8.", url: OBSERVE_URL },
      { id: "box:units", text: "Units changed outside a root command: tts-session-host.service stop.", url: OBSERVE_URL },
      { id: "box:logins", text: "3 ssh logins reached the box: jarvis 2, root 1.", url: OBSERVE_URL },
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
      runners: [],
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
    const draft = {
      firstLine: "Nothing is dated today and nothing is late.",
      firstLineSources: [],
      lines: [
        { role: "lead" as const, text: "What ran as root on the box.", sources: [] },
        { role: "item" as const, text: "An agent ran 5 root commands; 2 of them changed the machine.", url: agentFact!.urls[0], sources: [agentFact!.id] },
      ],
    };
    expect(verifyDraft(draft, block).filter((fault) => fault.includes("box") || fault.includes("number") || fault.includes("link"))).toEqual([]);
  });
});

describe("the /observe box lane", () => {
  it("returns box changes whole but redacted, and the deploy rows' commits", async () => {
    const t = convexTest({ schema, modules });
    await postEvent(t, { kind: "box-change", data: change({ command: `/usr/bin/env TOKEN=${TOKEN} true` }) });
    await postEvent(t, { kind: "deploy", key: "Jarvis:888b43a0", data: { repo: "Jarvis", from: "1cdb2c2", to: "888b43a", commits: ["x"], setupNeeded: false } });
    const tom = await withTom(t);
    const now = Date.now();
    const page = await tom.query(api.observe.eventsInWindow, { from: now - 60_000, to: now + 60_000, paginationOpts: { numItems: 50, cursor: null } });
    const box = page.page.find((event) => event.kind === "box-change");
    expect(box?.data).toMatchObject({ source: "sudo", user: "jarvis", at: AT });
    expect(JSON.stringify(box?.data)).not.toContain(TOKEN);
    expect(page.page.find((event) => event.kind === "deploy")?.data).toEqual({ repo: "Jarvis", from: "1cdb2c2", to: "888b43a" });
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
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });
    expect(await scheduled(t)).toHaveLength(0);
  });

  it("posts one line when a heartbeat is three intervals old, and writes the recovery when it beats again", async () => {
    const t = convexTest({ schema, modules });
    vi.setSystemTime(AT);
    await ok(t, "box-watch");
    await ok(t, "box-state");
    const beats = await t.run(async (ctx) => ctx.db.query("jobHeartbeats").collect());
    expect(beats.map((beat) => [beat.job, beat.lastOkAt]).sort()).toEqual([["box-state", AT], ["box-watch", AT]]);

    // Two intervals and a bit: quiet, not yet silent.
    vi.setSystemTime(AT + 2 * 2 * 60_000 + 30_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: [] });

    // Past three of box-watch's two-minute intervals; box-state's ten are not.
    vi.setSystemTime(AT + SILENCE_INTERVALS * 2 * 60_000 + 1_000);
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["box-watch"], recovered: [] });
    // Said once, however many passes find it still silent.
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: ["box-watch"], recovered: [] });
    const failed = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(failed.filter((row) => row.kind === "job-failed").map((row) => row.key)).toEqual(["box-watch:silent"]);
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("sendBroken");
    expect(jobs[0].args[0]).toMatchObject({ job: "box-watch:silent" });
    expect(String((jobs[0].args[0] as { statement: string }).statement)).toContain("has not run clean for 6 minutes");

    await ok(t, "box-watch");
    expect(await t.mutation(internal.ttsJobs.internalCheckSilence, {})).toEqual({ silent: [], recovered: ["box-watch"] });
    const recovered = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(recovered.filter((row) => row.kind === "job-recovered").map((row) => row.key)).toEqual(["box-watch:silent"]);
  });
});
