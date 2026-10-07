import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = "worker-key";

const ask = (over: Record<string, unknown> = {}) => ({
  askId: "3f9c1a22",
  job: "poll-gmail",
  question: "Move the appointment?",
  options: ["Move it.", "Leave it."],
  recommendation: "Move it.",
  fallback: "Leave it.",
  decision: "Move it.",
  reason: "The earlier time is available.",
  refused: false,
  refusedBecause: null,
  model: "fable",
  ms: 100,
  promptSha: "9c1a22b0",
  ...over,
});

const post = (t: ReturnType<typeof convexTest>, body: Record<string, unknown>) =>
  t.fetch("/tts/ask", {
    method: "POST",
    headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /tts/ask", () => {
  it("records the delegate decision and its event row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await post(t, ask({ waitedMs: 7_200_000, waitNote: "Tom did not answer" }))).status).toBe(200);
    const decisions = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ subject: "3f9c1a22", data: { decision: "Move it.", waitedMs: 7_200_000 } });
  });

  it("refuses a removed Tom-answer transport", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await post(t, ask({ decidedBy: "tom", needsTomId: "delegate-ask:3f9c1a22" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('decidedBy, when given, is "delegate"');
  });
});
