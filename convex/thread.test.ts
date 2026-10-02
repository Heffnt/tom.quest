import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
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
    expect(found[0]).toMatchObject({ id, text: "hello", reply: null });

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
});
