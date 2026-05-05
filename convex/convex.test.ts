import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("Convex functions", () => {
  it("registers and exposes Turing connections", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.turing.registerConnectionFromWorker, {
      connectionKey: "test-key",
      tunnelUrl: "https://example.com",
      now: Date.now(),
    });

    const docs = await t.run(async (ctx) => {
      return await ctx.db.query("turingConnections").collect();
    });

    expect(docs).toHaveLength(1);
    expect(docs[0].connectionKey).toBe("test-key");
  });

  it("auto-links worker registrations to Tom when available", async () => {
    const t = convexTest({ schema, modules });
    const tomId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        name: "Tom",
        email: "tom@tom.quest",
        role: "tom",
      });
    });

    await t.mutation(internal.turing.registerConnectionFromWorker, {
      connectionKey: "tom-key",
      tunnelUrl: "https://example.com",
      now: Date.now(),
    });

    const connection = await t.run(async (ctx) => {
      return await ctx.db
        .query("turingConnections")
        .withIndex("by_connection_key", (q) => q.eq("connectionKey", "tom-key"))
        .unique();
    });

    expect(connection?.userId).toBe(tomId);
  });

  it("returns top symbol scores", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("symbolScores", {
        username: "tom",
        timeMs: 3,
        createdAt: 1,
      });
      await ctx.db.insert("symbolScores", {
        username: "friend",
        timeMs: 7,
        createdAt: 2,
      });
    });

    const scores = await t.query(api.symbolScores.topScores, { limit: 2 });

    expect(scores.map((score) => score.username)).toEqual(["friend", "tom"]);
  });
});
