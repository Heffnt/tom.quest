import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("Convex functions", () => {
  it("upserts serverHealth on success and failure", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.serverHealth.set, {
      serverName: "turing",
      reachable: true,
      lastChecked: 1000,
      lastSuccessAt: 1000,
    });
    let row = await t.query(api.serverHealth.get, { serverName: "turing" });
    expect(row?.reachable).toBe(true);
    expect(row?.lastSuccessAt).toBe(1000);

    await t.mutation(internal.serverHealth.set, {
      serverName: "turing",
      reachable: false,
      lastChecked: 2000,
      error: "boom",
    });
    row = await t.query(api.serverHealth.get, { serverName: "turing" });
    expect(row?.reachable).toBe(false);
    expect(row?.error).toBe("boom");
    // lastSuccessAt is preserved across a failed poll.
    expect(row?.lastSuccessAt).toBe(1000);
  });

  it("returns top symbol scores by hit count", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("symbolScores", { username: "tom", hits: 3 });
      await ctx.db.insert("symbolScores", { username: "friend", hits: 7 });
    });

    const scores = await t.query(api.symbolScores.topScores, { limit: 2 });

    expect(scores.map((score) => score.username)).toEqual(["friend", "tom"]);
    expect(scores.map((score) => score.hits)).toEqual([7, 3]);
  });

  // Regression guard for the rename: the stored rows carried the hit count in a
  // field named `timeMs` beside a `createdAt` nothing rendered. If either dead
  // field ever survives the backfill, the narrow step that deletes them from the
  // schema fails at deploy time against the surviving rows.
  it("backfills legacy symbol scores into the hits field and clears the dead ones", async () => {
    const t = convexTest({ schema, modules });
    const legacyId = await t.run(async (ctx) =>
      ctx.db.insert("symbolScores", { username: "tom", timeMs: 7, createdAt: 1 }),
    );
    const currentId = await t.run(async (ctx) =>
      ctx.db.insert("symbolScores", { username: "friend", hits: 3 }),
    );

    const first = await t.mutation(internal.symbolScores.backfillHits, {});
    expect(first).toEqual({ scanned: 2, rewritten: 1 });

    const rows = await t.run(async (ctx) => ({
      legacy: await ctx.db.get(legacyId),
      current: await ctx.db.get(currentId),
    }));
    expect(rows.legacy?.hits).toBe(7);
    expect(rows.legacy?.timeMs).toBeUndefined();
    expect(rows.legacy?.createdAt).toBeUndefined();
    expect(rows.current?.hits).toBe(3);

    // Idempotent: the hourly cron re-running rewrites nothing.
    expect(await t.mutation(internal.symbolScores.backfillHits, {})).toEqual({
      scanned: 2,
      rewritten: 0,
    });

    const scores = await t.query(api.symbolScores.topScores, { limit: 10 });
    expect(scores.map((score) => score.hits)).toEqual([7, 3]);
  });

  // The leaderboard must stay readable in the window between the deploy that
  // widens the schema and the first backfill run: un-backfilled rows have no
  // `hits` and sort last under by_hits, so the query falls back to `timeMs`.
  it("reads the hit count of a row the backfill has not reached yet", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("symbolScores", { username: "tom", timeMs: 7, createdAt: 1 });
    });

    const scores = await t.query(api.symbolScores.topScores, { limit: 10 });

    expect(scores).toHaveLength(1);
    expect(scores[0].hits).toBe(7);
  });

  it("scopes canvas queries and mutations to the viewer", async () => {
    const t = convexTest({ schema, modules });
    const aliceId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "alice", email: "alice@tom.quest", role: "user" }),
    );
    const bobId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "bob", email: "bob@tom.quest", role: "user" }),
    );
    const alice = t.withIdentity({ subject: aliceId });
    const bob = t.withIdentity({ subject: bobId });

    const { canvasId, chatId } = await alice.mutation(api.canvas.create, {});

    // Alice can list and read her own canvas.
    const aliceList = await alice.query(api.canvas.listMine, {});
    expect(aliceList).toHaveLength(1);
    const fetched = await alice.query(api.canvas.get, { id: canvasId });
    expect(fetched._id).toBe(canvasId);

    // Bob cannot list it or read it.
    const bobList = await bob.query(api.canvas.listMine, {});
    expect(bobList).toHaveLength(0);
    await expect(bob.query(api.canvas.get, { id: canvasId })).rejects.toThrow();
    await expect(
      bob.mutation(api.canvas.setHtml, { id: canvasId, html: "<x/>" }),
    ).rejects.toThrow();

    // Alice can append a message to her chat; Bob cannot.
    await alice.mutation(api.canvas.appendMessage, {
      chatId,
      kind: "user",
      content: "hello",
    });
    await expect(
      bob.mutation(api.canvas.appendMessage, {
        chatId,
        kind: "user",
        content: "should fail",
      }),
    ).rejects.toThrow();

    const messages = await alice.query(api.canvas.getMessages, { chatId });
    expect(messages.map((m) => m.content)).toEqual(["hello"]);
  });

  it("removing a canvas cascades to its chats and messages", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "user", email: "u@tom.quest", role: "user" }),
    );
    const u = t.withIdentity({ subject: userId });
    const { canvasId, chatId } = await u.mutation(api.canvas.create, {});
    await u.mutation(api.canvas.appendMessage, {
      chatId,
      kind: "user",
      content: "hi",
    });
    await u.mutation(api.canvas.remove, { id: canvasId });

    const counts = await t.run(async (ctx) => ({
      canvases: (await ctx.db.query("canvases").collect()).length,
      chats: (await ctx.db.query("canvasChats").collect()).length,
      messages: (await ctx.db.query("canvasMessages").collect()).length,
    }));
    expect(counts).toEqual({ canvases: 0, chats: 0, messages: 0 });
  });
});
