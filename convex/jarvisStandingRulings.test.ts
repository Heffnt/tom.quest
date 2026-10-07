import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("standing rulings", () => {
  it("records a validated standing ruling as one event", async () => {
    vi.stubEnv("JARVIS_KEY", "key");
    const t = convexTest({ schema, modules });
    const messageId = await t.run((ctx) => ctx.db.insert("events", {
      kind: "thread-message", at: Date.now(), provenance: { user: "tom" }, data: {}, text: "Keep deployment manual.",
    }));
    const response = await t.fetch("/jarvis/standing-ruling", {
      method: "POST",
      headers: { "X-Jarvis-Key": "key", "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all", sentence: "Keep deployment manual.", question: "Who deploys?", provenance: { threadMessageId: messageId } }),
    });
    expect(response.status).toBe(200);
    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "ruling")).collect());
    expect(rows).toHaveLength(1);
  });
});
