import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// From the convex root, as every other test: convex-test names modules by
// their path under convex/, so a glob from a subdirectory finds none of them.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// EVERY FIXTURE HERE IS INVENTED. His pages are private to WikiTom and this
// repository is public.

const KEY = { "X-Jarvis-Key": "k" };

async function asTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

async function event(t: ReturnType<typeof convexTest>, kind: string, subject: string, data: unknown, at = 1_700_000_000_000) {
  return await t.run(async (ctx) => ctx.db.insert("events", { kind, at, provenance: {}, subject, data }));
}

const DECISION = {
  askId: "86f2f341",
  caller: "job:proof",
  question: "One session or two?",
  options: ["One.", "Two."],
  decision: "One.",
  reason: "His pages say one.",
  restedOn: ["model-of-tom/intent.md#What to protect", "ruling:abc"],
  wouldChange: "If the queue fell behind.",
  refused: false,
  refusedBecause: null,
  model: "opus",
};

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /jarvis/context", () => {
  it("names the callers on an unknown one, and answers as the old route does on a bad parameter", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    expect((await t.fetch("/jarvis/context?for=planner")).status).toBe(401);
    const unknown = await t.fetch("/jarvis/context?for=nope", { headers: KEY });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("planner, capture, ask, learning, weekly, simplify, prelude-delivery, golden, label");
    const old = await t.fetch("/tts/learning-input?until=5&since=9", { headers: KEY });
    const moved = await t.fetch("/jarvis/context?for=learning&until=5&since=9", { headers: KEY });
    expect(moved.status).toBe(400);
    expect(await moved.text()).toBe(await old.text());
  });

  it("serves the same bytes under both spellings for a reader with no clock in it", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const old = await t.fetch("/tts/golden-input?limitPerPartition=2", { headers: KEY });
    const moved = await t.fetch("/jarvis/context?for=golden&limitPerPartition=2", { headers: KEY });
    expect(old.status).toBe(200);
    expect(await moved.text()).toBe(await old.text());
  });
});

describe("jarvis/intent", () => {
  it("lists decisions newest first with the settlement he made, and refuses a stranger", async () => {
    const t = convexTest({ schema, modules });
    await event(t, "decision", "86f2f341", DECISION, 1_700_000_000_000);
    await event(t, "decision", "14606c4b", { ...DECISION, askId: "14606c4b", decision: "Two." }, 1_700_000_001_000);
    const tom = await asTom(t);
    const before = await tom.query(api.jarvis.intent.decisions, {});
    expect(before.map((one) => one.askId)).toEqual(["14606c4b", "86f2f341"]);
    expect(before[1].restedOn).toEqual(DECISION.restedOn);
    expect(before[1].settled).toBeNull();

    await tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "approve" });
    const after = await tom.query(api.jarvis.intent.decisions, {});
    expect(after[1].settled?.verdict).toBe("approve");
    expect(after[1].settled?.rulingId).toBeNull();
    const settled = await t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "disagreement-settled")).collect());
    expect(settled).toHaveLength(1);
    expect(settled[0].provenance).toEqual({ user: "tom" });
    expect(settled[0].subject).toBe("decision:86f2f341");
    expect(settled[0].text).toContain("accepted");

    await expect(tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "revise" })).rejects.toThrow("sentence");
    await expect(tom.mutation(api.jarvis.intent.settle, { subject: "decision:nope", verdict: "approve" })).rejects.toThrow("no decision");
    const stranger = await t.run(async (ctx) => ctx.db.insert("users", { name: "x", email: "x@x", role: "user" }));
    await expect(t.withIdentity({ subject: stranger }).query(api.jarvis.intent.decisions, {})).rejects.toThrow();
  });

  it("writes his ruling on the todo when the decision was about one", async () => {
    const t = convexTest({ schema, modules });
    const todoId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "a todo",
        status: "active",
        readiness: "prepared",
        timingClass: "whenever",
        source: "tom",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await event(t, "decision", "aa11bb22", { ...DECISION, askId: "aa11bb22", todoId });
    const tom = await asTom(t);
    const answer = await tom.mutation(api.jarvis.intent.settle, { subject: "decision:aa11bb22", verdict: "revise", sentence: "Two, in worktrees." });
    expect(answer.rulingId).not.toBeNull();
    const rulings = await t.run(async (ctx) => ctx.db.query("dtsRulings").withIndex("by_todo", (q) => q.eq("todoId", todoId)).collect());
    expect(rulings).toHaveLength(1);
    expect(rulings[0].verdict).toBe("revise");
    expect(rulings[0].sentence).toBe("Two, in worktrees.");
  });

  it("folds eval runs into one row per item with its pass count over the runs", async () => {
    const t = convexTest({ schema, modules });
    const run = (at: number, items: { name: string; pass: boolean | null; note: string }[]) =>
      event(t, "eval-run", "rule", { set: "rule", model: "opus", items, passed: 0, failed: 0, total: items.length }, at);
    await run(1, [{ name: "rule/ruling-758ddm40", pass: true, note: "" }, { name: "rule/ruling-td8dkhd8", pass: true, note: "" }]);
    await run(2, [{ name: "rule/ruling-758ddm40", pass: false, note: "expected archive, got session" }, { name: "rule/ruling-td8dkhd8", pass: null, note: "" }]);
    const tom = await asTom(t);
    const items = await tom.query(api.jarvis.intent.evalItems, {});
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));
    expect(byName["rule/ruling-758ddm40"]).toMatchObject({ pass: false, note: "expected archive, got session", passed: 1, runs: 2, at: 2, settled: null });
    expect(byName["rule/ruling-td8dkhd8"]).toMatchObject({ pass: null, passed: 1, runs: 1 });
    await tom.mutation(api.jarvis.intent.settle, { subject: "eval:rule/ruling-758ddm40", verdict: "revise", sentence: "Archive it." });
    const again = await tom.query(api.jarvis.intent.evalItems, {});
    expect(again.find((item) => item.name === "rule/ruling-758ddm40")?.settled).toMatchObject({ verdict: "revise", sentence: "Archive it." });
  });
});
