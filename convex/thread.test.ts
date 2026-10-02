import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { AGENT_CHANGE_KINDS, agentChange } from "./thread";

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
    let found = await viewer.query(api.thread.messages, {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id, text: "hello", reply: null, subject: null });

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

    found = await viewer.query(api.thread.messages, {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
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
    const found = await viewer.query(api.thread.messages, {});
    const message = found.find((m) => m.id === id);
    expect(message).toMatchObject({ id, text: "objecting", subject: deployId, reply: null });
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
      "A reply names a change Jarvis reported",
    );
  });
});
