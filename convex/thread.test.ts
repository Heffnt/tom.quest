import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { AGENT_CHANGE_KINDS, agentChange } from "./thread";
import { insertTodo } from "../test/core-tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
}

type AgentChangeRow = Parameters<typeof agentChange>[0];

function row(kind: AgentChangeRow["kind"], data: unknown): AgentChangeRow {
  return { kind, at: 0, provenance: {}, data } as unknown as AgentChangeRow;
}

describe("AGENT_CHANGE_KINDS", () => {
  it("is the four agent-change kinds", () => {
    expect(AGENT_CHANGE_KINDS).toEqual(["merge", "deploy", "learning-change", "repo-proposal-applied"]);
  });
});

describe("agentChange", () => {
  it("renders a merge line and link", () => {
    const r = row("merge", { repo: "tom.quest", sha: "a1b2c3d4e5f6", subject: "the delegate lands" });
    expect(agentChange(r)).toEqual({
      line: "Merged tom.quest a1b2c3d: the delegate lands",
      href: "https://github.com/Heffnt/tom.quest/commit/a1b2c3d4e5f6",
    });
  });

  it("renders a deploy line and compare link", () => {
    const r = row("deploy", { repo: "tom.quest", from: "aaaa1111", to: "bbbb2222", commits: ["one", "two"] });
    expect(agentChange(r)).toEqual({
      line: "Deployed tom.quest aaaa111..bbbb222, 2 commit(s)",
      href: "https://github.com/Heffnt/tom.quest/compare/aaaa1111...bbbb2222",
    });
  });

  it("renders a learning change with a section and a WikiTom commit link", () => {
    const r = row("learning-change", { file: "model-of-tom/areas/climbing.md", section: "rope", modelOfTomCommit: "cafebabe" });
    expect(agentChange(r)).toEqual({
      line: "Changed model-of-tom/areas/climbing.md § rope",
      href: "https://github.com/Heffnt/WikiTom/commit/cafebabe",
    });
  });

  it("renders a learning change with no section, and null link when its commit is absent", () => {
    const r = row("learning-change", { file: "model-of-tom/areas/climbing.md", section: "", modelOfTomCommit: null });
    expect(agentChange(r)).toEqual({
      line: "Changed model-of-tom/areas/climbing.md",
      href: null,
    });
  });

  it("renders an applied repo proposal line and link", () => {
    const r = row("repo-proposal-applied", { repo: "tom.quest", file: "app/AGENTS.md", appliedLine: "a rule", commit: "deadbeef" });
    expect(agentChange(r)).toEqual({
      line: "Added a rule to tom.quest app/AGENTS.md: a rule",
      href: "https://github.com/Heffnt/tom.quest/commit/deadbeef",
    });
  });
});

async function activeTodo(t: ReturnType<typeof convexTest>, statement = "Do the synthetic task") {
  return await t.run(async (ctx) =>
    insertTodo(ctx, {
      statement,
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function threadDigest(
  t: ReturnType<typeof convexTest>,
  items: Array<{ n: number; key: string; text: string; todoId?: string; job?: string }>,
  objectionAskIds: string[] = [],
) {
  return await t.run(async (ctx) => ctx.db.insert("events", {
    kind: "thread-digest",
    at: Date.now(),
    provenance: { job: "digest" },
    subject: "2026-10-02",
    data: {
      day: "2026-10-02",
      since: Date.now() - 86_400_000,
      windowEnd: Date.now(),
      truncated: false,
      surfacedTodoIds: [],
      objectionAskIds,
      items,
    },
    text: "Synthetic daily digest.",
  }));
}

describe("thread", () => {
  it("writes one events row with the text byte-identical and no subject", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const text = "  leading spaces and a\nnewline";
    const { id } = await viewer.mutation(api.thread.send, { text });
    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "thread-message")).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: id, kind: "thread-message", provenance: { user: "tom" }, text, data: {} });
    expect(rows[0]).not.toHaveProperty("subject");
  });

  it("refuses a non-Tom user and empty text", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const viewer = t.withIdentity({ subject: userId });
    await expect(viewer.mutation(api.thread.send, { text: "hello" })).rejects.toThrow("Thread access is restricted to Tom");
    await expect(viewer.query(api.thread.messages, {})).rejects.toThrow("Thread access is restricted to Tom");
    await expect(viewer.query(api.thread.changes, {})).rejects.toThrow("Thread access is restricted to Tom");

    const tomViewer = await tom(t);
    await expect(tomViewer.mutation(api.thread.send, { text: "" })).rejects.toThrow("A message cannot be empty");
    await expect(tomViewer.mutation(api.thread.send, { text: "   \n " })).rejects.toThrow("A message cannot be empty");
  });

  it("returns messages oldest first, with reply null until a thread-reply exists", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const { id } = await viewer.mutation(api.thread.send, { text: "hello" });
    let found = (await viewer.query(api.thread.messages, {})).entries;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "message", id, text: "hello", reply: null, subject: null });

    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "thread-reply",
        at: Date.now(),
        provenance: { job: "thread" },
        subject: id,
        data: { kind: "todo" },
        text: "a todo, waiting for a session",
      });
    });

    found = (await viewer.query(api.thread.messages, {})).entries;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "message",
      id,
      text: "hello",
      reply: { text: "a todo, waiting for a session", kind: "todo" },
    });
  });

  it("returns a deploy event under changes with its line and href", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "deploy",
        at: Date.now(),
        provenance: { job: "deploy" },
        data: { repo: "tom.quest", from: "aaaa1111", to: "bbbb2222", commits: ["one"], setupNeeded: false },
      }),
    );
    const found = await viewer.query(api.thread.changes, {});
    expect(found).toEqual([
      {
        id,
        at: expect.any(Number),
        kind: "deploy",
        line: "Deployed tom.quest aaaa111..bbbb222, 1 commit(s)",
        href: "https://github.com/Heffnt/tom.quest/compare/aaaa1111...bbbb2222",
      },
    ]);
  });

  it("leaves malformed change events out without hiding a valid neighboring event", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const validId = await t.run(async (ctx) => {
      const at = Date.now();
      await ctx.db.insert("events", {
        kind: "deploy",
        at,
        provenance: { job: "deploy" },
        data: { repo: "tom.quest", from: "aaaa1111", to: "bbbb2222" },
      });
      await ctx.db.insert("events", {
        kind: "merge",
        at,
        provenance: { job: "merge" },
        data: { repo: "unknown", sha: "cccc3333", subject: "unknown repo" },
      });
      return await ctx.db.insert("events", {
        kind: "merge",
        at,
        provenance: { job: "merge" },
        data: { repo: "tom.quest", sha: "dddd4444", subject: "valid change" },
      });
    });

    const found = await viewer.query(api.thread.changes, {});
    expect(found).toEqual([
      {
        id: validId,
        at: expect.any(Number),
        kind: "merge",
        // A merge row written before the landing carried its pull request
        // keeps today's line.
        line: "Merged tom.quest dddd444: valid change",
        href: "https://github.com/Heffnt/tom.quest/commit/dddd4444",
        repo: "tom.quest",
        sha: "dddd4444",
        pull: null,
        claim: null,
        diff: null,
        parts: [],
        checksAlone: false,
        explanation: null,
      },
    ]);
  });

  it("send with a change subject writes a thread-message naming it, and messages returns it", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const deployId = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "deploy",
        at: Date.now() - 60_000,
        provenance: { job: "deploy" },
        data: { repo: "tom.quest", from: "aaaa1111", to: "bbbb2222", commits: ["one"] },
      }),
    );
    const { id } = await viewer.mutation(api.thread.send, { text: "objecting", subject: deployId });
    const found = (await viewer.query(api.thread.messages, {})).entries;
    const message = found.find((m) => m.id === id);
    expect(message).toMatchObject({ kind: "message", id, text: "objecting", subject: deployId, reply: null });
  });

  it("refuses a reply naming a thread-message event", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const msgId = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "thread-message",
        at: Date.now(),
        provenance: { user: "tom" },
        data: {},
        text: "a plain message",
      }),
    );
    await expect(viewer.mutation(api.thread.send, { text: "reply", subject: msgId })).rejects.toThrow(
      "A reply names a digest, a change, a decision, a suggestion, a check, a diagnosis or a session's question",
    );
  });

  it("routes a numbered todo answer and records an answer reply", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const todoId = await activeTodo(t);
    const digestId = await threadDigest(t, [
      { n: 1, key: "todo-answer", text: "Finish the synthetic task.", todoId },
    ]);
    const { id: messageId } = await viewer.mutation(api.thread.send, { text: "1 done", subject: digestId });
    expect((await t.run((ctx) => ctx.db.get(todoId)))?.status).toBe("done");
    const reply = await t.run((ctx) => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", messageId))
      .first());
    expect(reply).toMatchObject({
      data: { kind: "answer", outcome: "done", n: 1 },
      text: "Item 1: its todo is marked done.",
    });
    const [answered] = await t.run((ctx) => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) =>
        q.eq("kind", "needs-tom-answered").eq("subject", "todo-answer"))
      .collect());
    expect(answered).toMatchObject({
      provenance: { user: "tom" },
      subject: "todo-answer",
      data: { answer: "done", via: "thread" },
    });
    expect(await t.run((ctx) => ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "slack-event"))
      .collect())).toEqual([]);
  });

  it("routes a numbered answer to a thread-needs-you item and returns that item as its own entry", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const todoId = await activeTodo(t);
    const digestId = await threadDigest(t, []);
    const itemId = await t.run(async (ctx) => ctx.db.insert("events", {
      kind: "thread-needs-you",
      at: Date.now(),
      provenance: { job: "needs-you" },
      subject: digestId,
      data: { n: 3, key: "late-todo", todoId },
      text: "Finish the late synthetic task.",
    }));

    await viewer.mutation(api.thread.send, { text: "3 done", subject: digestId });
    expect((await t.run((ctx) => ctx.db.get(todoId)))?.status).toBe("done");
    const found = (await viewer.query(api.thread.messages, {})).entries;
    expect(found).toContainEqual({
      kind: "item",
      id: itemId,
      at: expect.any(Number),
      digestId,
      day: "2026-10-02",
      n: 3,
      text: "Finish the late synthetic task.",
    });
  });

  it("keeps a numbered job answer as a tom-note and records an answer reply", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const digestId = await threadDigest(t, [
      { n: 2, key: "job-answer", text: "Settle the synthetic job.", job: "calendar" },
    ]);
    const { id: messageId } = await viewer.mutation(api.thread.send, { text: "2", subject: digestId });
    const notes = await t.run((ctx) => ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "tom-note"))
      .collect());
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toMatchObject({
      text: "2",
      subject: { kind: "job", id: "calendar" },
      threadDigestId: digestId,
      threadMessageId: messageId,
    });
    const reply = await t.run((ctx) => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", messageId))
      .first());
    expect(reply).toMatchObject({
      data: { kind: "answer", outcome: "tom-note", n: 2 },
      text: "Item 2: your reply is a note on the calendar job.",
    });
    const answered = await t.run((ctx) => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) =>
        q.eq("kind", "needs-tom-answered").eq("subject", "job-answer"))
      .first());
    expect(answered?.data).toEqual({ answer: "2", via: "thread" });
  });

  it("keeps an unnumbered digest reply as a note on that day", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const digestId = await threadDigest(t, []);
    const { id: messageId } = await viewer.mutation(api.thread.send, { text: "Remember this context.", subject: digestId });
    const notes = await t.run((ctx) => ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "tom-note"))
      .collect());
    expect(notes[0].data).toMatchObject({
      text: "Remember this context.",
      day: "2026-10-02",
      subject: { kind: "today", day: "2026-10-02" },
      threadDigestId: digestId,
      threadMessageId: messageId,
    });
    const reply = await t.run((ctx) => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", messageId))
      .first());
    expect(reply).toMatchObject({ data: { kind: "fact" }, text: "Kept as a note on the 2026-10-02 digest." });
  });

  it("refuses a reply whose subject names an ordinary thread message", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const { id } = await viewer.mutation(api.thread.send, { text: "ordinary message" });
    await expect(viewer.mutation(api.thread.send, { text: "not a digest reply", subject: id }))
      .rejects.toThrow("A reply names a digest, a change, a decision, a suggestion, a check, a diagnosis or a session's question");
  });

  it("returns a digest with its items and replies nested, never as top-level messages", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const digestId = await threadDigest(t, [
      { n: 4, key: "nested-job", text: "Answer the nested job.", job: "nested" },
    ]);
    const { id: messageId } = await viewer.mutation(api.thread.send, { text: "4 noted", subject: digestId });
    const found = (await viewer.query(api.thread.messages, {})).entries;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "digest",
      id: digestId,
      day: "2026-10-02",
      text: "Synthetic daily digest.",
      items: [{ n: 4, text: "Answer the nested job." }],
      replies: [{
        id: messageId,
        text: "4 noted",
        reply: { kind: "answer", text: "Item 4: your reply is a note on the nested job." },
      }],
    });
    expect(found.some((entry) => entry.id === messageId)).toBe(false);
  });

  it("returns a line of the silence alarm as its own entry from Jarvis", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    vi.useFakeTimers();
    // 07:00 New York (EDT): past the late-digest hour, with no thread digest.
    vi.setSystemTime(Date.UTC(2026, 9, 2, 11, 0));
    try {
      await t.mutation(internal.ttsJobs.internalCheckSilence, {});
      const found = (await viewer.query(api.thread.messages, {})).entries;
      expect(found).toEqual([expect.objectContaining({
        kind: "alarm",
        text: "Today's digest (2026-10-02) is not on the thread: the record's digest cron has not appended it.",
        href: "https://tom.quest/agents?view=window",
      })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a reply to a line printed with an empty id as a note, as the Slack route does", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const digestId = await threadDigest(t, [
      { n: 3, key: "placeholder-job", text: "Answer the synthetic job.", job: "synthetic" },
    ], ["", "ask-2"]);
    const { id: revertId } = await viewer.mutation(api.thread.send, { text: "revert 1", subject: digestId });
    const { id: sentenceId } = await viewer.mutation(api.thread.send, { text: "1: leave it", subject: digestId });
    const objections = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect())
      .filter((row) => row.kind === "delegate-objection"));
    expect(objections).toEqual([]);
    const replies = await t.run(async (ctx) => (await ctx.db.query("events").collect())
      .filter((row) => row.kind === "thread-reply"));
    expect(replies.find((row) => row.subject === revertId)).toMatchObject({ text: "Kept as a note on the 2026-10-02 digest." });
    expect(replies.find((row) => row.subject === sentenceId))
      .toMatchObject({ text: "Kept as a note on the 2026-10-02 digest; no item is numbered 1." });
  });

  it("records a numbered objection to a digest line, and routes a number past the objection lines to its item", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    await t.run(async (ctx) => {
      for (const askId of ["ask-1", "ask-2"]) {
        await ctx.db.insert("events", {
          kind: "decision", at: Date.now(), provenance: { job: "delegate" }, subject: askId,
          data: { askId, decision: `Synthetic decision ${askId}.` },
        });
      }
    });
    const digestId = await threadDigest(t, [
      { n: 3, key: "objection-job", text: "Answer the synthetic job.", job: "synthetic" },
    ], ["ask-1", "ask-2"]);

    const { id: revertId } = await viewer.mutation(api.thread.send, { text: "revert 2", subject: digestId });
    const { id: sentenceId } = await viewer.mutation(api.thread.send, { text: "1: leave it until Friday", subject: digestId });
    const { id: itemId } = await viewer.mutation(api.thread.send, { text: "3: noted", subject: digestId });

    const objections = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect())
      .filter((row) => row.kind === "delegate-objection"));
    expect(objections.map((row) => row.data)).toEqual([
      expect.objectContaining({ askId: "ask-2", n: 2, day: "2026-10-02", revert: true, sentence: null, channel: "thread", ts: revertId, threadTs: digestId }),
      expect.objectContaining({ askId: "ask-1", n: 1, revert: false, sentence: "leave it until Friday", ts: sentenceId }),
    ]);
    const replies = await t.run(async (ctx) => (await ctx.db.query("events").collect())
      .filter((row) => row.kind === "thread-reply"));
    const replyTo = (id: string) => replies.find((row) => row.subject === id);
    expect(replyTo(revertId)).toMatchObject({ text: "Line 2: your objection is recorded.", data: { kind: "answer", outcome: "objection", n: 2 } });
    expect(replyTo(sentenceId)).toMatchObject({ text: "Line 1: your objection is recorded." });
    expect(replyTo(itemId)).toMatchObject({ text: "Item 3: your reply is a note on the synthetic job." });
  });
  it("loads 60 digests of near-cap replies under its read budget and reports the read it stopped", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const reply = "r".repeat(4_000);
    await t.run(async (ctx) => {
      for (let d = 0; d < 60; d += 1) {
        const digestId = await ctx.db.insert("events", {
          kind: "thread-digest", at: Date.now() - (60 - d) * 3_600_000, provenance: { job: "digest" }, subject: `day-${d}`,
          data: { day: `day-${d}`, objectionAskIds: [], items: [] }, text: "Synthetic daily digest.",
        });
        for (let r = 0; r < 10; r += 1) {
          await ctx.db.insert("events", {
            kind: "thread-message", at: Date.now() - (60 - d) * 3_600_000 + r + 1, provenance: { user: "tom" },
            subject: digestId, text: reply, data: {},
          });
        }
      }
    });
    const page = await viewer.query(api.thread.messages, {});
    const digests = page.entries.filter((entry) => entry.kind === "digest");
    expect(digests).toHaveLength(60);
    const replies = digests.reduce((sum, digest) => sum + (digest.kind === "digest" ? digest.replies.length : 0), 0);
    expect(replies).toBeGreaterThan(0);
    expect(replies).toBeLessThan(600);
    expect(page.cuts).toEqual([expect.stringMatching(/^Thread messages: \d+ read, stopped at the (row limit|byte budget)\.$/)]);
  });
});

async function insertEventRow(
  t: ReturnType<typeof convexTest>,
  row: { kind: string; at?: number; subject?: string; data?: unknown; text?: string },
) {
  return await t.run(async (ctx) => ctx.db.insert("events", {
    kind: row.kind, at: row.at ?? Date.now(), provenance: {},
    ...(row.subject === undefined ? {} : { subject: row.subject }),
    data: row.data ?? {},
    ...(row.text === undefined ? {} : { text: row.text }),
  }));
}

async function digestOn(
  t: ReturnType<typeof convexTest>,
  day: string,
  at: number,
  items: Array<{ n: number; key: string; text: string; todoId?: string; job?: string }>,
) {
  return await insertEventRow(t, { kind: "thread-digest", at, subject: day, text: `Digest of ${day}.`,
    data: { day, since: at - 86_400_000, windowEnd: at, truncated: false, surfacedTodoIds: [], objectionAskIds: [], items } });
}

async function liveSession(t: ReturnType<typeof convexTest>, status: "idle" | "ended" = "idle") {
  return await t.run(async (ctx) => ctx.db.insert("claudeSessions", {
    title: "the synthetic session", kind: "focus-item", repo: "none", status,
    statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(),
  }));
}

const DECISION_DATA = {
  question: "One session or two?", options: ["One.", "Two."], decision: "One.", reason: "His pages say one.",
  restedOn: ["ruling:abc"], wouldChange: null, refused: false, refusedBecause: null, caller: "job:proof", model: "opus",
};

describe("thread.open", () => {
  it("returns the open needs-you items numbered by their digests, newest digest first, and omits the answered, the done and the unnumbered", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const now = Date.now();
    const todoA = await activeTodo(t, "Today's item");
    const todoB = await activeTodo(t, "Yesterday's item");
    const todoDone = await activeTodo(t, "A finished item");
    await t.run(async (ctx) => ctx.db.patch(todoDone, { status: "done" }));
    const yesterday = await digestOn(t, "2026-10-03", now - 86_000_000, [{ n: 1, key: "k-yesterday", text: "Item k-yesterday.", todoId: todoB }]);
    const today = await digestOn(t, "2026-10-04", now - 2_000, [
      { n: 1, key: "k-answered", text: "Item k-answered.", todoId: todoA },
      { n: 2, key: "k-today", text: "Item k-today.", todoId: todoA },
      { n: 3, key: "k-done", text: "Item k-done.", todoId: todoDone },
    ]);
    // The digest writes each listed opening's number and digest on it.
    for (const [key, todoId, at, numbered] of [
      ["k-today", todoA, now - 3_000, { n: 2, digestId: today }], ["k-yesterday", todoB, now - 90_000_000, { n: 1, digestId: yesterday }],
      ["k-answered", todoA, now - 4_000, { n: 1, digestId: today }], ["k-done", todoDone, now - 5_000, { n: 3, digestId: today }],
      ["k-unnumbered", todoA, now - 1_000, {}],
    ] as const) {
      await insertEventRow(t, { kind: "needs-you-opened", at, subject: key, data: { key, todoId, ...numbered }, text: `Item ${key}.` });
    }
    await insertEventRow(t, { kind: "needs-tom-answered", subject: "k-answered", data: { answer: "done", via: "thread" } });
    const { needsYou } = await viewer.query(api.thread.open, {});
    expect(needsYou.map((item) => [item.key, item.n, item.day])).toEqual([
      ["k-today", 2, "2026-10-04"],
      ["k-yesterday", 1, "2026-10-03"],
    ]);
    expect(needsYou[0]).toMatchObject({ digestId: today, todoId: todoA, statement: "Today's item" });
  });

  it("lists an old open item behind 600 newer openings: no newest-N read", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const now = Date.now();
    const todo = await activeTodo(t, "The old item");
    const digest = await digestOn(t, "2026-08-01", now - 70 * 86_400_000, [{ n: 1, key: "k-old", text: "Old.", todoId: todo }]);
    await insertEventRow(t, { kind: "needs-you-opened", at: now - 70 * 86_400_000, subject: "k-old",
      data: { key: "k-old", todoId: todo, n: 1, digestId: digest }, text: "Old." });
    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i += 1) {
        await ctx.db.insert("events", { kind: "needs-you-opened", at: now - 1_000 + i, provenance: {}, subject: `k-new-${i}`,
          data: { key: `k-new-${i}`, job: "synthetic" }, text: `New ${i}.` });
      }
    });
    expect((await viewer.query(api.thread.open, {})).needsYou.map((item) => item.key)).toEqual(["k-old"]);
  });

  it("closes what stopped waiting on him in a sweep, and leaves what still waits", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const open = await activeTodo(t, "Open");
    const done = await activeTodo(t, "Done");
    await t.run(async (ctx) => ctx.db.patch(done, { status: "done" }));
    const opening = (key: string, data: Record<string, unknown>, at = now) =>
      insertEventRow(t, { kind: "needs-you-opened", at, subject: key, data: { key, ...data }, text: key });
    const stays = await opening("k-open", { todoId: open, n: 1, digestId: "d" });
    const doneOpening = await opening("k-done", { todoId: done, n: 2, digestId: "d" });
    const lapsed = await opening("k-lapsed", { job: "synthetic" }, now - 4 * 86_400_000);
    const settledElsewhere = await insertEventRow(t, { kind: "decision", subject: "5e771ed1", data: { ...DECISION_DATA, askId: "5e771ed1" } });
    await insertEventRow(t, { kind: "disagreement-settled", subject: "decision:5e771ed1", data: { verdict: "approve" } });
    const waiting = await insertEventRow(t, { kind: "decision", subject: "0pen0001", data: { ...DECISION_DATA, askId: "0pen0001" } });
    const answered = await insertEventRow(t, { kind: "suggestion", subject: "log-page",
      data: { class: "deletion", built: false, answer: { at: 1, text: "yes", messageId: "m" } }, text: "Delete it." });
    expect(await t.mutation(internal.thread.internalCloseOpenItems, {})).toEqual({ closed: 4 });
    const closedAt = async (id: Id<"events">) => (await t.run((ctx) => ctx.db.get(id)))?.data.closedAt;
    expect(await closedAt(stays)).toBeUndefined();
    expect(await closedAt(waiting)).toBeUndefined();
    for (const id of [doneOpening, lapsed, settledElsewhere, answered]) expect(await closedAt(id)).toEqual(expect.any(Number));
  });

  it("reads on past a slice of open decisions to close a stale one after it, in a chained run", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      const big = (askId: string, at: number) => insertEventRow(t, { kind: "decision", at, subject: askId,
        data: { ...DECISION_DATA, askId, reason: "x".repeat(900_000) } });
      const now = Date.now();
      await big("0pen0001", now - 3_000);
      await big("0pen0002", now - 2_000);
      const stale = await insertEventRow(t, { kind: "decision", at: now - 1_000, subject: "ref00001",
        data: { ...DECISION_DATA, askId: "ref00001", decision: null, refused: true, refusedBecause: "money" } });
      // The first run's decisions slice ends at the second open row.
      expect(await t.mutation(internal.thread.internalCloseOpenItems, {})).toEqual({ closed: 0 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await t.run((ctx) => ctx.db.get(stale)))?.data.closedAt).toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a live session's question until he answers it here, in the session, or the session ends", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const sessionId = await liveSession(t);
    const pause = (at: number) => insertEventRow(t, { kind: "pause", at, subject: sessionId,
      data: { reason: "awaiting you, present", sessionId, question: "Ship it?" }, text: "Ship it?" });
    const first = await pause(Date.now() - 10_000);
    expect((await viewer.query(api.thread.open, {})).questions).toEqual([{
      id: first, at: expect.any(Number), sessionId, title: "the synthetic session", question: "Ship it?",
      href: `/agents?session=${sessionId}`,
    }]);
    await insertEventRow(t, { kind: "thread-message", subject: first, text: "yes" });
    expect((await viewer.query(api.thread.open, {})).questions).toEqual([]);

    await pause(Date.now() - 5_000);
    expect((await viewer.query(api.thread.open, {})).questions).toHaveLength(1);
    // An agent's turn and a stop are no answer of his.
    await t.run(async (ctx) => {
      await ctx.db.insert("claudeInbound", { sessionId, kind: "user-turn", text: "go on", author: "agent", status: "pending", createdAt: Date.now() });
      await ctx.db.insert("claudeInbound", { sessionId, kind: "stop", status: "pending", createdAt: Date.now() });
    });
    expect((await viewer.query(api.thread.open, {})).questions).toHaveLength(1);
    await t.run(async (ctx) => ctx.db.insert("claudeInbound", {
      sessionId, kind: "user-turn", text: "yes", author: "tom", status: "pending", createdAt: Date.now(),
    }));
    expect((await viewer.query(api.thread.open, {})).questions).toEqual([]);

    await pause(Date.now() + 1_000);
    expect((await viewer.query(api.thread.open, {})).questions).toHaveLength(1);
    await t.run(async (ctx) => ctx.db.patch(sessionId, { status: "ended" }));
    expect((await viewer.query(api.thread.open, {})).questions).toEqual([]);
  });

  it("reads a session's turns only after its pause, by status, so a long history before it neither answers nor exceeds the read", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const sessionId = await liveSession(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i += 1) {
        await ctx.db.insert("claudeInbound", { sessionId, kind: "user-turn", text: "earlier", author: "tom", status: "done", createdAt: Date.now() });
      }
    });
    vi.useFakeTimers({ now: Date.now() + 1_000 });
    try {
      await insertEventRow(t, { kind: "pause", at: Date.now() - 500, subject: sessionId,
        data: { reason: "awaiting you, present", sessionId, question: "Ship it?" }, text: "Ship it?" });
      expect((await viewer.query(api.thread.open, {})).questions).toHaveLength(1);
      await t.run(async (ctx) => ctx.db.insert("claudeInbound", {
        sessionId, kind: "user-turn", text: "yes", author: "tom", status: "done", createdAt: Date.now(),
      }));
      expect((await viewer.query(api.thread.open, {})).questions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a live session's question behind 250 newer pauses of other sessions", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const sessionId = await liveSession(t);
    const question = await insertEventRow(t, { kind: "pause", at: Date.now() - 60_000, subject: sessionId,
      data: { reason: "awaiting you, present", sessionId, question: "Ship it?" }, text: "Ship it?" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i += 1) {
        await ctx.db.insert("events", { kind: "pause", at: Date.now() - 1_000 + i, provenance: {}, subject: `other-${i}`,
          data: { reason: "slot at cap", sessionId: `other-${i}`, liftsAt: 1 }, text: "slot at cap" });
      }
    });
    expect((await viewer.query(api.thread.open, {})).questions.map((one) => one.id)).toEqual([question]);
  });

  it("counts the open loop runs from each part's newest check, and leaves out a count with no rows", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    await liveSession(t);
    expect((await viewer.query(api.thread.open, {})).counts).toEqual({ liveSessions: 1 });
    const parts = ["digest", "thread", "box", "p0", "p1", "p2", "p3", "p4", "p5"];
    await insertEventRow(t, { kind: "registry", subject: "Jarvis@abc", data: { repo: "Jarvis", sha: "abc", parts: parts.map((id) => ({ id })), count: parts.length } });
    const check = (part: string, name: string, result: string, at: number) => insertEventRow(t, {
      kind: "quality-check", at, subject: part, data: { part, check: name, measure: 3, target: 1, result, pass: "tick" } });
    await check("digest", "size", "failed", Date.now() - 3_000);
    await check("thread", "size", "failed", Date.now() - 3_000);
    await check("thread", "size", "green", Date.now() - 1_000);
    // A part's newest check, of any check, says whether its run is open: an
    // older failed size check under a newer green lint check is closed.
    await check("box", "size", "failed", Date.now() - 3_000);
    await check("box", "lint", "green", Date.now() - 1_000);
    // 600 newer checks of other parts do not hide the digest's old failure.
    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i += 1) {
        const part = `p${i % 6}`;
        await ctx.db.insert("events", { kind: "quality-check", at: Date.now() - 500 + i, provenance: {}, subject: part,
          data: { part, check: "size", measure: 1, target: 2, result: "green", pass: "tick" } });
      }
    });
    expect((await viewer.query(api.thread.open, {})).counts).toEqual({ openLoopRuns: 1, liveSessions: 1 });
  });

  it("lists every unanswered suggestion whatever its age, and none answered", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const old = Date.now() - 61 * 86_400_000;
    const aged = await insertEventRow(t, { kind: "suggestion", at: old, subject: "log-page",
      data: { class: "deletion", built: false }, text: "Delete it." });
    await insertEventRow(t, { kind: "suggestion", subject: "push-page", data: { class: "deletion", built: true,
      answer: { at: 1, text: "yes", messageId: "m" } }, text: "Deleted it." });
    expect((await viewer.query(api.thread.open, {})).suggestions).toEqual([{
      id: aged, at: old, class: "deletion", built: false, text: "Delete it.", subject: "log-page", href: "/design#log-page",
    }]);
    await viewer.mutation(api.thread.send, { text: "yes", subject: aged });
    expect((await viewer.query(api.thread.open, {})).suggestions).toEqual([]);
  });

  it("lists every unsettled delegate decision whatever its age, and none settled, refused or his own", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const old = Date.now() - 61 * 86_400_000;
    const aged = await insertEventRow(t, { kind: "decision", at: old, subject: "0ld00001", data: { ...DECISION_DATA, askId: "0ld00001" } });
    await insertEventRow(t, { kind: "decision", at: old, subject: "5e771ed1", data: { ...DECISION_DATA, askId: "5e771ed1" } });
    await insertEventRow(t, { kind: "decision", subject: "ref00001",
      data: { ...DECISION_DATA, askId: "ref00001", decision: null, refused: true, refusedBecause: "money" } });
    await insertEventRow(t, { kind: "decision", subject: "70m00001", data: { ...DECISION_DATA, askId: "70m00001", decidedBy: "tom" } });
    await viewer.mutation(api.jarvis.intent.settle, { subject: "decision:5e771ed1", verdict: "approve" });
    expect((await viewer.query(api.thread.open, {})).decisions).toEqual([{
      id: aged, at: old, askId: "0ld00001", question: "One session or two?", decision: "One.",
      reason: "His pages say one.", wouldChange: null,
    }]);
    // Outside the stream's 60 days, so only the open items carry its controls.
    expect((await viewer.query(api.thread.messages, {})).entries.some((one) => one.id === aged)).toBe(false);
    await viewer.mutation(api.thread.send, { text: "Two.", subject: aged });
    expect((await viewer.query(api.thread.open, {})).decisions).toEqual([]);
  });
});

describe("thread.messages, the stream's new rows", () => {
  it("reads his settlements under the page's budget and says a cut of them", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("events", { kind: "disagreement-settled", at: Date.now() - i, provenance: {}, subject: `decision:${i}`,
          data: { verdict: "approve" } });
      }
    });
    expect((await viewer.query(api.thread.messages, {})).cuts).toEqual(["His settlements: 500 read, stopped at the row limit."]);
  });

  it("returns a decision unsettled, then settled, and omits a refused one", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const id = await insertEventRow(t, { kind: "decision", subject: "86f2f341", data: { ...DECISION_DATA, askId: "86f2f341" } });
    await insertEventRow(t, { kind: "decision", subject: "refused1",
      data: { ...DECISION_DATA, askId: "refused1", decision: null, refused: true, refusedBecause: "money" } });
    const decisions = async () => (await viewer.query(api.thread.messages, {})).entries.filter((one) => one.kind === "decision");
    expect(await decisions()).toEqual([{
      kind: "decision", id, at: expect.any(Number), askId: "86f2f341", question: "One session or two?", decision: "One.",
      reason: "His pages say one.", restedOn: ["ruling:abc"], wouldChange: null, caller: "job:proof", model: "opus",
      todoId: null, decidedByTom: false, waitedMs: null, settled: null,
    }]);
    await viewer.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "approve" });
    expect((await decisions())[0]).toMatchObject({ settled: { verdict: "approve", sentence: null } });
  });

  it("returns suggestions, failed checks and diagnoses with their fields, and omits a green check", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const suggestion = await insertEventRow(t, { kind: "suggestion", subject: "tom.quest@abcdef1", text: "Landed the fix.",
      data: { class: "landing", built: true, restsOn: { text: "fix it", source: "ruling r1" } } });
    const failed = await insertEventRow(t, { kind: "quality-check", subject: "size:digest", text: "digest size failed",
      data: { part: "digest", check: "size", measure: 9, target: null, result: "failed", pass: "tick", agentHref: "/agents?session=s" } });
    await insertEventRow(t, { kind: "quality-check", subject: "size:thread", text: "thread size green",
      data: { part: "thread", check: "size", measure: 1, target: 2, result: "green", pass: "tick" } });
    const diagnosis = await insertEventRow(t, { kind: "diagnosis", subject: failed, text: "One. Two. Three.",
      data: { part: "digest", causes: [{ n: 1, class: "code", sentence: "One." }], fixLanding: "m1", restsOn: [] } });
    const found = (await viewer.query(api.thread.messages, {})).entries;
    expect(found.filter((one) => one.kind === "suggestion")).toEqual([{
      kind: "suggestion", id: suggestion, at: expect.any(Number), subject: "tom.quest@abcdef1",
      href: "https://github.com/Heffnt/tom.quest/commit/abcdef1", class: "landing", built: true,
      restsOn: { text: "fix it", source: "ruling r1" }, answer: null, text: "Landed the fix.",
    }]);
    expect(found.filter((one) => one.kind === "check")).toEqual([{
      kind: "check", id: failed, at: expect.any(Number), part: "digest", check: "size", measure: 9, target: null,
      agentHref: "/agents?session=s",
    }]);
    expect(found.filter((one) => one.kind === "diagnosis")).toEqual([{
      kind: "diagnosis", id: diagnosis, at: expect.any(Number), part: "digest", text: "One. Two. Three.",
      causes: [{ n: 1, class: "code", sentence: "One." }], fixLanding: "m1", preventionLanding: null,
    }]);
  });
});

/** A complete registry row, as Jarvis worker/parts.json holds one. */
const registryRow = (id: string, name: string) => ({
  id, name, type: "program", file: null, starts: [], reads: [], writes: [], refuses: [], routes: [], schedule: null,
  fate: { type: "kept", by: null }, serves: [{ guarantee: "G4" }], designed_by: "outcomes", note: `The ${id} part.`,
});

describe("thread.changes, the return of a landing", () => {
  it("returns a merge row's claim, pull request, registry diff, parts and whether it passed on the checks alone", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    await insertEventRow(t, { kind: "merge", subject: `tom.quest:${sha}`, data: { repo: "tom.quest", sha, subject: "thread: one page",
      pull: { number: 341, title: "thread: one page" }, claim: "The thread is the one page." } });
    await insertEventRow(t, { kind: "merge", subject: `tom.quest:${other}`, data: { repo: "tom.quest", sha: other, subject: "other" } });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "tests-run", key: `tom.quest@${sha}`,
        data: { ok: true, registryDiff: { base: "bbbbbbb", added: ["thread-page"], changed: ["digest"], removed: ["log-page"],
          rows: { "thread-page": registryRow("thread-page", "The thread page"), digest: registryRow("digest", "The digest") } } } });
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "audit-verdict", key: `tom.quest@${sha}`, data: { verdict: "APPROVED", model: "none" } });
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "audit-verdict", key: `tom.quest@${other}`, data: { verdict: "APPROVED", model: "opus" } });
    });
    const merges = (await viewer.query(api.thread.changes, {})).filter((one) => one.kind === "merge");
    const landed = merges.find((one) => "sha" in one && one.sha === sha);
    expect(landed).toMatchObject({
      line: "Merged tom.quest #341: thread: one page",
      pull: { number: 341, title: "thread: one page" },
      claim: "The thread is the one page.",
      diff: { added: ["thread-page"], changed: ["digest"], removed: ["log-page"] },
      parts: [
        { id: "thread-page", name: "The thread page", fate: "added" },
        { id: "digest", name: "The digest", fate: "changed" },
        { id: "log-page", name: "log-page", fate: "removed" },
      ],
      checksAlone: true,
    });
    expect(merges.find((one) => "sha" in one && one.sha === other)).toMatchObject({
      line: `Merged tom.quest ${other.slice(0, 7)}: other`, pull: null, claim: null, diff: null, parts: [], checksAlone: false,
    });
  });
});

describe("thread.send, a reply per row type", () => {
  it("writes his objection under a decision as the revise settlement and his ruling on its todo", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const todoId = await activeTodo(t);
    const decision = await insertEventRow(t, { kind: "decision", subject: "86f2f341", data: { ...DECISION_DATA, askId: "86f2f341", todoId } });
    const { id } = await viewer.mutation(api.thread.send, { text: "Two, not one.", subject: decision });
    const settled = await t.run(async (ctx) => ctx.db.query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "disagreement-settled").eq("subject", "decision:86f2f341")).collect());
    expect(settled).toHaveLength(1);
    expect(settled[0].data).toMatchObject({ verdict: "revise", sentence: "Two, not one." });
    const rulings = await t.run(async (ctx) => ctx.db.query("rulings").withIndex("by_todo", (q) => q.eq("todoId", todoId)).collect());
    expect(rulings).toHaveLength(1);
    expect(rulings[0]).toMatchObject({ verdict: "revise" });
    const message = await t.run(async (ctx) => ctx.db.get(id));
    expect(message).toMatchObject({ kind: "thread-message", subject: decision, text: "Two, not one." });
  });

  it("writes his answer onto a suggestion", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const suggestion = await insertEventRow(t, { kind: "suggestion", subject: "log-page", data: { class: "deletion", built: false }, text: "Delete it." });
    const { id } = await viewer.mutation(api.thread.send, { text: "yes", subject: suggestion });
    const row = await t.run(async (ctx) => ctx.db.get(suggestion));
    expect(row?.data).toEqual({ class: "deletion", built: false, answer: { at: expect.any(Number), text: "yes", messageId: id },
      closedAt: expect.any(Number) });
  });

  it("sends his answer to a session's question as a turn of that session", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const sessionId = await liveSession(t);
    const pause = await insertEventRow(t, { kind: "pause", subject: sessionId,
      data: { reason: "awaiting you, present", sessionId, question: "Ship it?" }, text: "Ship it?" });
    await viewer.mutation(api.thread.send, { text: "Ship it.", subject: pause });
    const inbound = await t.run(async (ctx) => ctx.db.query("claudeInbound")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId)).collect());
    expect(inbound).toMatchObject([{ kind: "user-turn", text: "Ship it.", author: "tom", status: "pending" }]);
  });

  it("routes a numbered message with no target to the newest digest's item, and leaves an unmatched number an ordinary message", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const todoId = await activeTodo(t);
    const digestId = await threadDigest(t, [{ n: 2, key: "k-two", text: "Item two.", todoId }]);
    const { id } = await viewer.mutation(api.thread.send, { text: "2 done" });
    expect((await t.run((ctx) => ctx.db.get(todoId)))?.status).toBe("done");
    expect((await t.run((ctx) => ctx.db.get(id)))?.subject).toBe(digestId);
    const { id: seven } = await viewer.mutation(api.thread.send, { text: "7 done" });
    const message = await t.run((ctx) => ctx.db.get(seven));
    expect(message).not.toHaveProperty("subject");
  });

  it("refuses a reply naming a row no reply answers", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const ok = await insertEventRow(t, { kind: "job-ok", subject: "digest" });
    await expect(viewer.mutation(api.thread.send, { text: "hm", subject: ok as Id<"events"> })).rejects.toThrow(
      "A reply names a digest, a change, a decision, a suggestion, a check, a diagnosis or a session's question",
    );
  });
});

describe("the thread's row types and POST /tts/event", () => {
  it("refuses the four types the thread trusts, so a malformed one cannot break the stream", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    try {
      const t = convexTest({ schema, modules });
      const viewer = await tom(t);
      const post = (body: unknown) => t.fetch("/tts/event", {
        method: "POST", headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      for (const kind of ["pause", "suggestion", "quality-check", "diagnosis"]) {
        expect((await post({ kind, key: "digest", data: { part: "digest" } })).status).toBe(403);
      }
      expect(await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "diagnosis")).collect())).toEqual([]);
      expect((await viewer.query(api.thread.messages, {})).entries).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
