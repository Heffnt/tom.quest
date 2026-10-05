import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { SETTLED_LEAD } from "./ttsCompose";
import { insertTodo } from "../test/core-tables";

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
    expect((await unknown.json()).error).toContain("planner, capture, ask, learning, weekly, simplify");
    const old = await t.fetch("/tts/learning-input?until=5&since=9", { headers: KEY });
    const moved = await t.fetch("/jarvis/context?for=learning&until=5&since=9", { headers: KEY });
    expect(moved.status).toBe(400);
    expect(await moved.text()).toBe(await old.text());
  });

  it("serves the same bytes under both spellings for a reader with no clock in it", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const old = await t.fetch("/tts/ask-context?job=planner", { headers: KEY });
    const moved = await t.fetch("/jarvis/context?for=ask&job=planner", { headers: KEY });
    expect(old.status).toBe(200);
    expect(await moved.text()).toBe(await old.text());
  });
});

describe("jarvis/intent", () => {
  it("shows decisions on the thread with the settlement he made, and refuses a stranger", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await event(t, "decision", "86f2f341", DECISION, now - 2_000);
    await event(t, "decision", "14606c4b", { ...DECISION, askId: "14606c4b", decision: "Two." }, now - 1_000);
    const tom = await asTom(t);
    const shown = async () => (await tom.query(api.thread.messages, {})).entries.flatMap((one) => one.kind === "decision" ? [one] : []);
    const before = await shown();
    expect(before.map((one) => one.askId)).toEqual(["86f2f341", "14606c4b"]);
    expect(before[0].restedOn).toEqual(DECISION.restedOn);
    expect(before[0].settled).toBeNull();

    await tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "approve" });
    const after = await shown();
    expect(after[0].settled?.verdict).toBe("approve");
    const settled = await t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "disagreement-settled")).collect());
    expect(settled).toHaveLength(1);
    expect(settled[0].provenance).toEqual({ user: "tom" });
    expect(settled[0].subject).toBe("decision:86f2f341");
    expect(settled[0].text).toContain("accepted");

    await expect(tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "revise" })).rejects.toThrow("sentence");
    await expect(tom.mutation(api.jarvis.intent.settle, { subject: "decision:nope", verdict: "approve" })).rejects.toThrow("no decision");
    const stranger = await t.run(async (ctx) => ctx.db.insert("users", { name: "x", email: "x@x", role: "user" }));
    await expect(t.withIdentity({ subject: stranger }).mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "approve" })).rejects.toThrow();
  });

  it("takes no accept on a refused or unanswered decision, and writes no ruling for one", async () => {
    const t = convexTest({ schema, modules });
    const todoId = await t.run(async (ctx) =>
      insertTodo(ctx, {
        statement: "a todo",
        status: "active",
        readiness: "prepared",
        timingClass: "whenever",
        source: "tom",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await event(t, "decision", "refused1", { ...DECISION, askId: "refused1", todoId, decision: null, refused: true, refusedBecause: "money" });
    await event(t, "decision", "unanswered1", { ...DECISION, askId: "unanswered1", todoId, decision: null });
    const tom = await asTom(t);
    for (const askId of ["refused1", "unanswered1"]) {
      await expect(tom.mutation(api.jarvis.intent.settle, { subject: `decision:${askId}`, verdict: "approve" })).rejects.toThrow(
        "nothing to accept",
      );
    }
    const objected = await tom.mutation(api.jarvis.intent.settle, { subject: "decision:refused1", verdict: "revise", sentence: "Ask me." });
    expect(objected.rulingId).not.toBeNull();
    const rulings = await t.run(async (ctx) => ctx.db.query("rulings").withIndex("by_todo", (q) => q.eq("todoId", todoId)).collect());
    expect(rulings.map((row) => row.verdict)).toEqual(["revise"]);
  });

  it("writes his ruling on the todo when the decision was about one", async () => {
    const t = convexTest({ schema, modules });
    const todoId = await t.run(async (ctx) =>
      insertTodo(ctx, {
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
    const rulings = await t.run(async (ctx) => ctx.db.query("rulings").withIndex("by_todo", (q) => q.eq("todoId", todoId)).collect());
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
    const failing = byName["rule/ruling-758ddm40"];
    await tom.mutation(api.jarvis.intent.settle, { subject: `eval:${failing.runId}:${failing.name}`, verdict: "revise", sentence: "Archive it." });
    const again = await tom.query(api.jarvis.intent.evalItems, {});
    expect(again.find((item) => item.name === "rule/ruling-758ddm40")?.settled).toMatchObject({ verdict: "revise", sentence: "Archive it." });

    // witness: a settlement keyed by the item alone kept a later failure of
    // the same item settled, so a recurrence could not be ruled on.
    await run(3, [{ name: "rule/ruling-758ddm40", pass: false, note: "expected archive, got session" }]);
    const recurred = (await tom.query(api.jarvis.intent.evalItems, {})).find((item) => item.name === "rule/ruling-758ddm40");
    expect(recurred?.settled).toBeNull();
    expect(recurred?.runId).not.toBe(failing.runId);
    // A settlement names a run that reported the item, or none is written.
    await expect(tom.mutation(api.jarvis.intent.settle, { subject: "eval:rule/ruling-758ddm40", verdict: "approve" })).rejects.toThrow();
    await expect(tom.mutation(api.jarvis.intent.settle, { subject: `eval:${failing.runId}:rule/nope`, verdict: "approve" })).rejects.toThrow("no eval run");
  });

  it("keeps identically named eval items from different sets separate", async () => {
    const t = convexTest({ schema, modules });
    await event(t, "eval-run", "rule", {
      set: "rule",
      model: "opus",
      items: [{ name: "shared/item", pass: true, note: "rule result" }],
    }, 1);
    await event(t, "eval-run", "wall", {
      set: "wall",
      model: "opus",
      items: [{ name: "shared/item", pass: false, note: "wall result" }],
    }, 2);
    const tom = await asTom(t);
    const items = (await tom.query(api.jarvis.intent.evalItems, {}))
      .filter((item) => item.name === "shared/item")
      .sort((left, right) => left.set.localeCompare(right.set));
    expect(items).toMatchObject([
      { set: "rule", pass: true, passed: 1, runs: 1, note: "rule result" },
      { set: "wall", pass: false, passed: 0, runs: 1, note: "wall result" },
    ]);
  });

  it("files a decision under its row's subject and skips one without", async () => {
    const t = convexTest({ schema, modules });
    await event(t, "decision", "filed1", { ...DECISION, askId: "a-different-spelling" }, Date.now());
    await t.run(async (ctx) => ctx.db.insert("events", { kind: "decision", at: Date.now(), provenance: {}, data: { ...DECISION, askId: "unfiled" } }));
    const tom = await asTom(t);
    const shown = (await tom.query(api.thread.messages, {})).entries.flatMap((one) => one.kind === "decision" ? [one.askId] : []);
    expect(shown).toEqual(["filed1"]);
  });
});

// witness: settle wrote its line only as a disagreement-settled event, which
// no reader of the digest looked at, so the settlement text the page promised
// never reached him.
describe("the digest's settled run", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints a settlement made in its window, one line each, and none made before it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = Date.UTC(2026, 8, 26, 3);
    const since = Date.UTC(2026, 8, 26, 9);
    const inside = Date.UTC(2026, 8, 26, 20);
    const now = Date.UTC(2026, 8, 27, 9, 30);
    const t = convexTest({ schema, modules });
    await event(t, "decision", "0ld5e771", { ...DECISION, askId: "0ld5e771", decision: "Three." }, before - 1_000);
    const decisionRow = await event(t, "decision", "86f2f341", DECISION, since + 1_000);
    const tom = await asTom(t);
    vi.setSystemTime(before);
    await tom.mutation(api.jarvis.intent.settle, { subject: "decision:0ld5e771", verdict: "approve" });
    vi.setSystemTime(inside);
    const settled = await tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "revise", sentence: "Two, in worktrees." });
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, { day: "2026-09-27", now, since });
    const lines = text.split("\n");
    const lead = lines.findIndex((line) => line.includes(SETTLED_LEAD));
    expect(lead).toBeGreaterThan(-1);
    const line = `Tom objected to the delegate's decision "One." (86f2f341): Two, in worktrees.`;
    expect(lines[lead + 1]).toContain(line);
    // Settled on the thread: the line links the decision's row there.
    expect(lines[lead + 1]).toContain(`https://tom.quest/thread#${decisionRow}`);
    expect(text).not.toContain("intent page");
    expect(text).not.toContain("0ld5e771");
    expect((facts as { facts: { id: string; text: string }[] }).facts.filter((one) => one.id.startsWith("settled:"))).toEqual([
      expect.objectContaining({ id: `settled:${settled.id}`, text: line }),
    ]);
  });

  // witness: the link was built from a read of the decision under the
  // digest's lookup budget, and a spent budget linked a decision to /intent.
  it("links each settlement from its own row, with no read of the decision", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const since = Date.UTC(2026, 8, 26, 9);
    const now = Date.UTC(2026, 8, 27, 9, 30);
    const t = convexTest({ schema, modules });
    const decisionRow = await event(t, "decision", "86f2f341", DECISION, since + 1_000);
    const tom = await asTom(t);
    vi.setSystemTime(since + 2_000);
    await tom.mutation(api.jarvis.intent.settle, { subject: "decision:86f2f341", verdict: "approve" });
    // Nothing the digest could read names the decision any more.
    await t.run(async (ctx) => ctx.db.delete(decisionRow));
    // A decision's settlement from before the row carried decisionId, and an eval item's.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", { kind: "disagreement-settled", at: since + 3_000, provenance: { user: "tom" },
        subject: "decision:0ld5e771", data: { subject: "decision:0ld5e771", verdict: "approve", sentence: null, rulingId: null },
        text: "Tom accepted an older decision." });
      await ctx.db.insert("events", { kind: "disagreement-settled", at: since + 4_000, provenance: { user: "tom" },
        subject: "eval:run1:rule/a", data: { subject: "eval:run1:rule/a", verdict: "approve", sentence: null, rulingId: null },
        text: "Tom let the ruling behind eval item rule/a stand." });
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, { day: "2026-09-27", now, since });
    const lines = text.split("\n");
    const of = (needle: string) => lines.find((one) => one.includes(needle)) ?? "";
    expect(of("accepted the delegate's decision")).toContain(`https://tom.quest/thread#${decisionRow}`);
    expect(of("an older decision")).toContain("<https://tom.quest/thread|");
    expect(of("eval item rule/a")).toContain("https://tom.quest/intent");
  });
});
