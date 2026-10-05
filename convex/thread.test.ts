import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
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
        line: "Merged tom.quest dddd444: valid change",
        href: "https://github.com/Heffnt/tom.quest/commit/dddd4444",
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
      "A reply names a change Jarvis reported or a digest",
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
      .rejects.toThrow("A reply names a change Jarvis reported or a digest");
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
