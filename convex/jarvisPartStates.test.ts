import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";
import {
  derivePartState,
  readPartStates,
  IN_USE_DAYS,
  touches,
  WORKING_AFTER_DAYS,
  type IssueRow,
  type PartRows,
  type Received,
  type UseRow,
} from "./jarvis/partStates";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const landing = (id: string, at: number): Received => ({ id, kind: "merge", at, receivedAt: at });
const jobOk = (id: string, at: number, receivedAt = at): Received => ({ id, kind: "job-ok", at, receivedAt });
const use = (id: string, at: number, by: string, working = false, receivedAt = at): UseRow => ({ id, kind: "use", at, by, working, receivedAt });
const issue = (id: string, at: number, resolves = false, receivedAt = at): IssueRow => ({ id, kind: "issue", at, text: "broken", resolves, receivedAt });
const rows = (r: Partial<PartRows>): PartRows => ({ landings: [], jobOk: null, uses: [], issues: [], ...r });
const state = (r: Partial<PartRows>) => derivePartState(rows(r), NOW);

describe("derivePartState", () => {
  it("is unverified with no row, and after a landing with nothing since, resting on the landing", () => {
    expect(state({})).toEqual({ state: "unverified", row: null });
    expect(state({ landings: [landing("L", NOW - DAY)] })).toEqual({ state: "unverified", row: { id: "L", kind: "merge", at: NOW - DAY } });
  });

  it("is unverified when the only run and use came before the newest landing", () => {
    const r = { landings: [landing("L", NOW - DAY)], jobOk: jobOk("J", NOW - 2 * DAY), uses: [use("U", NOW - 2 * DAY, "tom")] };
    expect(state(r).state).toBe("unverified");
  });

  it("is run on a job-ok since the landing, or a job's use row", () => {
    expect(state({ landings: [landing("L", NOW - 2 * DAY)], jobOk: jobOk("J", NOW - DAY) })).toEqual({ state: "run", row: { id: "J", kind: "job-ok", at: NOW - DAY } });
    // A job-ok dated after the landing but received before it is about the old code.
    expect(state({ landings: [landing("L", NOW - 2 * DAY)], jobOk: jobOk("J", NOW - DAY, NOW - 3 * DAY) }).state).toBe("unverified");
    expect(state({ uses: [use("U", NOW - DAY, "job")] }).state).toBe("run");
  });

  it("is run, not in use, when the last use by Tom or an agent is older than the in-use window", () => {
    expect(state({ uses: [use("U", NOW - (IN_USE_DAYS + 1) * DAY, "tom")] }).state).toBe("run");
  });

  it("is in use on a use by Tom or an agent within the window, resting on the newest", () => {
    expect(state({ uses: [use("A", NOW - 3 * DAY, "agent"), use("T", NOW - DAY, "tom")] })).toEqual({ state: "in use", row: { id: "T", kind: "use", at: NOW - DAY } });
  });

  it("is working once the first use since the landing is the working span old, with no issue in it", () => {
    const old = use("U1", NOW - WORKING_AFTER_DAYS * DAY, "tom");
    const recent = use("U2", NOW - DAY, "agent");
    expect(state({ uses: [old, recent] })).toEqual({ state: "working", row: { id: "U2", kind: "use", at: NOW - DAY } });
    // An issue inside the span restarts it, even once closed.
    const closed = [issue("I", NOW - 3 * DAY), issue("R", NOW - 2 * DAY, true)];
    expect(state({ uses: [old, recent], issues: closed }).state).toBe("in use");
  });

  it("counts Tom's no-issues row and the working span within the in-use window only", () => {
    // A "no issues" received more than IN_USE_DAYS ago, with nothing since, is a run.
    expect(state({ uses: [use("W", NOW - (IN_USE_DAYS + 1) * DAY, "tom", true)] }).state).toBe("run");
    // Use 40 days ago and again 2 days ago is two days of use in the window: in use, not working.
    expect(state({ uses: [use("A", NOW - 40 * DAY, "tom"), use("B", NOW - 2 * DAY, "tom")] }).state).toBe("in use");
  });

  it("is working at once on Tom's no-issues row since the landing", () => {
    const said = use("W", NOW - 60_000, "tom", true);
    expect(state({ landings: [landing("L", NOW - DAY)], uses: [said] })).toEqual({ state: "working", row: { id: "W", kind: "use", at: NOW - 60_000 } });
    // Before the landing it says nothing about the code since.
    expect(state({ landings: [landing("L", NOW - DAY)], uses: [use("W", NOW - 2 * DAY, "tom", true)] }).state).toBe("unverified");
    // An agent's row with state working is not his sentence.
    expect(state({ uses: [use("W", NOW - 60_000, "agent", true)] }).state).toBe("in use");
  });

  it("is issue on an open issue, over every other state, resting on the newest open one", () => {
    const r = { uses: [use("W", NOW - 5 * DAY, "tom", true)], issues: [issue("I1", NOW - 3 * DAY), issue("I2", NOW - DAY)] };
    expect(state(r)).toEqual({ state: "issue", row: { id: "I2", kind: "issue", at: NOW - DAY, text: "broken" } });
  });

  it("closes issues by the time the record received the closing row, not its writer's at", () => {
    // Tom's "no issues" dated five minutes ahead by its writer, received at NOW - 10 min;
    // an issue reported a minute after receipt stays open.
    const said = use("W", NOW - 5 * 60_000, "tom", true, NOW - 10 * 60_000);
    expect(state({ uses: [said], issues: [issue("I", NOW - 9 * 60_000)] })).toMatchObject({ state: "issue", row: { id: "I" } });
    // An issue before receipt is closed.
    expect(state({ uses: [said], issues: [issue("I", NOW - 11 * 60_000)] }).state).toBe("working");
    // The same for a resolution.
    const resolved = issue("R", NOW - 5 * 60_000, true, NOW - 10 * 60_000);
    expect(state({ issues: [resolved, issue("I", NOW - 9 * 60_000)] }).state).toBe("issue");
  });

  it("closes an issue by a later resolving issue row, or by Tom's later no-issues row", () => {
    const opened = issue("I", NOW - 3 * DAY);
    expect(state({ issues: [opened, issue("R", NOW - DAY, true)], landings: [landing("L", NOW - DAY)] }).state).toBe("unverified");
    // A resolution closes the issues at or before it, never one opened after it.
    expect(state({ issues: [issue("R", NOW - 4 * DAY, true), opened] })).toMatchObject({ state: "issue", row: { id: "I" } });
    expect(state({ issues: [opened], uses: [use("W", NOW - DAY, "tom", true)] }).state).toBe("working");
    // A no-issues row before the issue does not close it.
    expect(state({ issues: [opened], uses: [use("W", NOW - 4 * DAY, "tom", true)] }).state).toBe("issue");
  });
});

describe("the mapping by registry fields", () => {
  it("touches a part when a landing's files hold its file, or a file under it", () => {
    expect(touches({ id: "deploy", file: "worker/jobs/deploy.mjs" }, ["worker/jobs/deploy.mjs"])).toBe(true);
    expect(touches({ id: "cron", file: "worker/cron" }, ["worker/cron/jobs.txt"])).toBe(true);
    expect(touches({ id: "deploy", file: "worker/jobs/deploy.mjs" }, ["worker/jobs/deploy.mjs.bak", "worker/jobs/deploy.test.mjs"])).toBe(false);
    expect(touches({ id: "record", file: null }, ["anything"])).toBe(false);
  });
});

const JSON_HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": "k" };
const post = (t: ReturnType<typeof convexTest>, body: unknown) =>
  t.fetch("/jarvis/event", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * Store event rows as the record would have received them: each at its own
 * `at`, which here is its receipt time (convex-test sets _creationTime from the
 * clock and never moves it back, so rows go in in time order, before anything
 * at NOW). Sets the clock back to NOW.
 */
async function storeAsReceived(t: ReturnType<typeof convexTest>, docs: Omit<Doc<"events">, "_id" | "_creationTime">[]) {
  const ids = await t.run(async (ctx) => {
    const out = [];
    for (const doc of docs) {
      vi.setSystemTime(doc.at);
      out.push(await ctx.db.insert("events", doc));
    }
    return out;
  });
  vi.setSystemTime(NOW);
  return ids;
}

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
}

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the rows through the route and the thread", () => {
  it("POST /jarvis/event takes the rows Jarvis #247 posts and refuses a malformed one", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const prov = { job: "thread-reply" };
    const bodies = [
      { kind: "issue", provenance: prov, subject: "digest", data: { part: "digest", threadMessageId: "m1" }, text: "the digest is broken" },
      { kind: "issue", provenance: prov, data: { part: null, threadMessageId: "m2" }, text: "something is off" },
      { kind: "use", provenance: prov, subject: "digest", data: { part: "digest", state: "working", threadMessageId: "m3" }, text: "the digest works." },
      { kind: "presence", provenance: prov, subject: "tom", data: { away: true, threadMessageId: "m4" }, text: "ill check in in the morning." },
    ];
    for (const body of bodies) expect((await post(t, body)).status).toBe(200);
    const bad = await post(t, { kind: "use", provenance: prov, subject: "digest", data: { part: "deploy", state: "working" }, text: "x" });
    expect(bad.status).toBe(400);
    const stored = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "use").eq("subject", "digest")).collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].data).toMatchObject({ by: "tom", what: "the digest works." });
  });

  it("a second post with the same data.id answers the first row, marked duplicate, and writes nothing", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const prov = { job: "thread-reply" };
    const bodies = [
      { kind: "issue", provenance: prov, subject: "digest", data: { id: "thread-reply:m1:issue", part: "digest", threadMessageId: "m1" }, text: "the digest is broken" },
      { kind: "use", provenance: prov, subject: "digest", data: { id: "thread-reply:m2:no-issues", part: "digest", state: "working", threadMessageId: "m2" }, text: "the digest works." },
      { kind: "presence", provenance: prov, subject: "tom", data: { id: "thread-reply:m3:back", away: false, threadMessageId: "m3" }, text: "im back" },
    ];
    for (const body of bodies) {
      const first = await (await post(t, body)).json();
      const second = await (await post(t, body)).json();
      expect(first).toMatchObject({ ok: true, duplicate: false });
      expect(second).toMatchObject({ ok: true, id: first.id, duplicate: true });
    }
    const stored = await t.run((ctx) => ctx.db.query("events").collect());
    expect(stored.map((row) => row.kind).sort()).toEqual(["issue", "presence", "use"]);
  });

  it("a resolving row posted through the route is dated by the record and closes only the issues before it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    const prov = { job: "loop" };
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", at: NOW - 2 * DAY, data: { part: "deploy" }, text: "deploy failed" })).status).toBe(200);
    // A backdated or future resolution is refused, so it cannot reach past the
    // record's clock to close the wrong issues.
    for (const resolvedAt of [NOW - 3 * DAY, NOW + 3 * DAY]) {
      expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", data: { part: "deploy", resolvedBy: "L1", resolvedAt }, text: "fixed" })).status).toBe(400);
    }
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", at: NOW - 3 * DAY, data: { part: "deploy", resolvedBy: "L1" }, text: "fixed" })).status).toBe(400);
    const parts = [{ id: "deploy", schedule: null, file: null }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0].state).toBe("issue");
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", data: { part: "deploy", resolvedBy: "L1" }, text: "fixed by #250" })).status).toBe(200);
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0].state).toBe("unverified");
    vi.setSystemTime(NOW + DAY);
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", data: { part: "deploy" }, text: "deploy failed again" })).status).toBe(200);
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "issue", row: { text: "deploy failed again" } });
  });

  it("reads a part's whole use history back to its landing: Tom's \"no issues\" under 149 later rows still counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    await storeAsReceived(t, [
      { kind: "use", at: NOW - 20 * DAY, provenance: { user: "tom" }, subject: "deploy", data: { part: "deploy", by: "tom", state: "working", what: "deploy works" } },
      ...Array.from({ length: 149 }, (_, i) => ({ kind: "use", at: NOW - 10 * DAY + i * 60_000, provenance: { job: "deploy" }, subject: "deploy", data: { part: "deploy", by: "job", what: "ran" } })),
    ]);
    const viewer = await tom(t);
    const parts = [{ id: "deploy", schedule: null, file: "worker/jobs/deploy.mjs" }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "working", row: { at: NOW - 20 * DAY }, capped: false });
    // Under a budget of 100 rows the read stops at the newest 100 and says so, instead of answering run as if that were the whole history.
    const small = await t.run(async (ctx) => await readPartStates(ctx, parts, [], NOW, { left: 100 }));
    expect(small[0]).toMatchObject({ part: "deploy", state: "run", capped: true });
    // A landing after it starts the part over: the 49 job rows after the landing make it run, and the rows before it are about the old code.
    const landings = [{ repo: "Jarvis", pullRequest: 251, headSha: "fff", landedAt: NOW - 10 * DAY + 100 * 60_000, files: ["worker/jobs/deploy.mjs"] }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts, landings }))[0].state).toBe("run");
  });

  it("takes a caller's landing as given and reads its row by key, however many landings came after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    const [, landingId] = await storeAsReceived(t, [
      { kind: "job-ok", at: NOW - 3 * DAY, provenance: { job: "deploy" }, subject: "deploy:run", data: {} },
      {
        kind: "merge", at: NOW - 2 * DAY, provenance: {}, subject: "Jarvis:abc",
        data: { repo: "Jarvis", sha: "abc", subject: "deploy: one pass", mainCheck: "abc is the head of pull request #250, merged into main" },
      },
      ...Array.from({ length: 501 }, (_, i) => ({
        kind: "merge", at: NOW - DAY + i, provenance: {}, subject: `Jarvis:later${i}`,
        data: { repo: "Jarvis", sha: `later${i}`, subject: "other", mainCheck: `later${i} is the head of pull request #${1000 + i}, merged into main` },
      })),
    ]);
    const viewer = await tom(t);
    const parts = [
      { id: "deploy", schedule: "deploy", file: "worker/jobs/deploy.mjs" },
      { id: "sweep", schedule: null, file: "worker/agents/sweep.mjs" },
    ];
    const landings = [
      { repo: "Jarvis", pullRequest: 250, headSha: "abc", landedAt: NOW - 2 * DAY, files: ["worker/jobs/deploy.mjs"] },
      // A landing the record holds no row for (past the gate) still starts the part over.
      { repo: "Jarvis", pullRequest: 252, headSha: "none", landedAt: NOW - DAY, files: ["worker/agents/sweep.mjs"] },
    ];
    const states = await viewer.query(api.jarvis.partStates.partStates, { parts, landings });
    expect(states[0]).toEqual({ part: "deploy", state: "unverified", row: { id: landingId, kind: "merge", at: NOW - 2 * DAY }, capped: false });
    expect(states[1]).toEqual({ part: "sweep", state: "unverified", row: { id: "Jarvis#252", kind: "landing", at: NOW - DAY, text: "pull request #252" }, capped: false });
  });

  it("reads the last-received issue as open, and closes it by Tom's later \"no issues\" under 120 later uses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const issues = [
      { kind: "issue", at: NOW - 30 * DAY, provenance: {}, subject: "deploy", text: "old", data: { part: "deploy", by: "tom" } },
      { kind: "issue", at: NOW - 20 * DAY, provenance: {}, subject: "deploy", text: "newest", data: { part: "deploy", by: "tom" } },
    ];
    const parts = [{ id: "deploy", schedule: null, file: null }];
    const open = convexTest({ schema, modules });
    await storeAsReceived(open, issues);
    expect((await (await tom(open)).query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "issue", row: { text: "newest" } });
    const closed = convexTest({ schema, modules });
    await storeAsReceived(closed, [
      ...issues,
      { kind: "use", at: NOW - 15 * DAY, provenance: { user: "tom" }, subject: "deploy", data: { part: "deploy", by: "tom", state: "working", what: "fine now" } },
      ...Array.from({ length: 120 }, (_, i) => ({ kind: "use", at: NOW - 12 * DAY + i * 60_000, provenance: { job: "deploy" }, subject: "deploy", data: { part: "deploy", by: "job", what: "ran" } })),
    ]);
    expect((await (await tom(closed)).query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "working", row: { at: NOW - 15 * DAY } });
  });

  it("closes an issue by a resolution the record received after it, though its writer dated it earlier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const prov = { job: "loop" };
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", data: { part: "deploy" }, text: "deploy failed" })).status).toBe(200);
    // Received four minutes later, dated a minute before the issue (within the five minutes the validator allows).
    vi.setSystemTime(NOW + 4 * 60_000);
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", at: NOW - 60_000, data: { part: "deploy", resolvedBy: "L1" }, text: "fixed by #250" })).status).toBe(200);
    vi.setSystemTime(NOW + 10 * 60_000);
    const viewer = await tom(t);
    const parts = [{ id: "deploy", schedule: null, file: null }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0].state).toBe("unverified");
  });

  it("reads one use row of a part with no issue and only old uses, leaving the budget for the parts after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    await storeAsReceived(t, [
      ...Array.from({ length: 200 }, (_, i) => ({ kind: "use", at: NOW - 60 * DAY + i * 60_000, provenance: { job: "sweep" }, subject: "sweep", data: { part: "sweep", by: "job", what: "ran" } })),
      { kind: "use", at: NOW - DAY, provenance: { user: "tom" }, subject: "deploy", data: { part: "deploy", by: "tom", state: "working", what: "deploy works" } },
    ]);
    const parts = [
      { id: "sweep", schedule: null, file: null },
      { id: "deploy", schedule: null, file: null },
    ];
    const budget = { left: 5 };
    const states = await t.run(async (ctx) => await readPartStates(ctx, parts, [], NOW, budget));
    expect(states).toMatchObject([
      { part: "sweep", state: "run", capped: false },
      { part: "deploy", state: "working", capped: false },
    ]);
    expect(budget.left).toBe(3);
  });

  it("a \"no issues\" row postdated five minutes does not close an issue reported a minute after the record received it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    const prov = { job: "thread-reply" };
    const said = { kind: "use", provenance: prov, subject: "deploy", at: NOW + 5 * 60_000, data: { part: "deploy", state: "working", threadMessageId: "m1" }, text: "deploy works" };
    expect((await post(t, said)).status).toBe(200);
    vi.setSystemTime(NOW + 60_000);
    expect((await post(t, { kind: "issue", provenance: prov, subject: "deploy", data: { part: "deploy", threadMessageId: "m2" }, text: "deploy broke" })).status).toBe(200);
    vi.setSystemTime(NOW + 10 * 60_000);
    const parts = [{ id: "deploy", schedule: null, file: null }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "issue", row: { text: "deploy broke" } });
  });

  it("Tom reports an issue and then no issues on a part from the thread; nobody else can", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    await viewer.mutation(api.thread.reportOnPart, { part: "deploy", report: "issue", text: "the deploy did not run" });
    const parts = [{ id: "deploy", schedule: "deploy", file: "worker/jobs/deploy.mjs" }];
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ part: "deploy", state: "issue", row: { kind: "issue", text: "the deploy did not run" } });
    await viewer.mutation(api.thread.reportOnPart, { part: "deploy", report: "no-issues", text: "deploy works now" });
    expect((await viewer.query(api.jarvis.partStates.partStates, { parts }))[0]).toMatchObject({ state: "working", row: { kind: "use" } });
    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "use")).collect());
    expect(rows[0]).toMatchObject({ provenance: { user: "tom" }, data: { part: "deploy", by: "tom", state: "working", what: "deploy works now" } });

    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const reader = t.withIdentity({ subject: userId });
    await expect(reader.mutation(api.thread.reportOnPart, { part: "deploy", report: "issue", text: "x" })).rejects.toThrow("Thread access is restricted to Tom");
    await expect(reader.query(api.jarvis.partStates.partStates, { parts })).rejects.toThrow("Jarvis access is restricted to Tom");
    await expect(viewer.mutation(api.thread.reportOnPart, { part: " ", report: "issue", text: "x" })).rejects.toThrow("subject, when given, is a non-empty string");
    await expect(viewer.mutation(api.thread.reportOnPart, { part: "deploy", report: "issue", text: " " })).rejects.toThrow("an issue event names its text");
    await expect(viewer.mutation(api.thread.reportOnPart, { part: "deploy", report: "no-issues", text: " " })).rejects.toThrow("a use event names data.what or its text");
  });

  it("partStates maps job-ok rows by schedule and landing rows by file, per part the caller passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    await storeAsReceived(t, [
      { kind: "job-ok", at: NOW - 3 * DAY, provenance: { job: "deploy" }, subject: "deploy:run", data: {} },
      { kind: "job-ok", at: NOW - 3 * DAY + 1, provenance: { job: "sweep" }, subject: "sweep:run", data: {} },
      // Jarvis #250 landed after sweep's last clean run and changed sweep's file.
      {
        kind: "merge",
        at: NOW - DAY,
        provenance: {},
        subject: "Jarvis:abc",
        data: { repo: "Jarvis", sha: "abc", subject: "sweep: one pass", mainCheck: "abc is the head of pull request #250, merged into main as def" },
      },
    ]);
    const viewer = await tom(t);
    const parts = [
      { id: "deploy", schedule: "deploy", file: "worker/jobs/deploy.mjs" },
      { id: "sweep", schedule: "sweep", file: "worker/agents/sweep.mjs" },
      { id: "redaction", schedule: null, file: "worker/agents/secret-values.mjs" },
    ];
    const landings = [{ repo: "Jarvis", pullRequest: 250, headSha: "abc", landedAt: NOW - DAY, files: ["worker/agents/sweep.mjs"] }];
    const states = await viewer.query(api.jarvis.partStates.partStates, { parts, landings });
    expect(states.map((s) => [s.part, s.state, s.row?.kind ?? null])).toEqual([
      ["deploy", "run", "job-ok"],
      ["sweep", "unverified", "merge"],
      ["redaction", "unverified", null],
    ]);
    // Without the files of #250 the landing touches nothing, and sweep reads as run.
    const unmapped = await viewer.query(api.jarvis.partStates.partStates, { parts });
    expect(unmapped[1]).toMatchObject({ part: "sweep", state: "run" });
  });
});
