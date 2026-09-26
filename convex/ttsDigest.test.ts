import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DELEGATE_DECISION } from "./ttsAsk";
import { MERGE } from "./ttsMerge";
import { REMOVAL_LOOP_PR, SIMPLIFY_PROPOSAL } from "./ttsSimplify";
import { EVAL_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import {
  DIGEST_SENT,
  ROLLOVER_NOTE,
  calendarLeadText,
  gatherTodayFacts,
  isPassedWithoutOutcome,
  latenessText,
  objectionRank,
  stripNarrowListId,
} from "./ttsDigest";
import { MESSAGE_MAX_CHARS, TAB_EVERYTHING } from "./ttsCompose";
import { nyCalendarDayBoundsUtc, ttsItemLink, ttsSessionLink } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const DAY = 86_400_000;
// 2026-09-05 05:00 EDT — the digest's instant; its day key is 2026-09-05.
const FIVE_AM = Date.UTC(2026, 8, 5, 9);
const DAY_KEY = "2026-09-05";

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}


describe("the missed rollover", () => {
  it("names a passed date with no outcome, and nothing else", () => {
    const { start } = nyCalendarDayBoundsUtc(DAY_KEY);
    const passed = Date.UTC(2026, 8, 4, 16);
    expect(isPassedWithoutOutcome({ status: "active", dueAt: passed }, start)).toBe(true);
    // Today's date has not passed at 5 a.m.
    expect(
      isPassedWithoutOutcome({ status: "active", dueAt: Date.UTC(2026, 8, 5, 16) }, start),
    ).toBe(false);
    expect(isPassedWithoutOutcome({ status: "done", dueAt: passed }, start)).toBe(false);
    expect(isPassedWithoutOutcome({ status: "active" }, start)).toBe(false);
    expect(
      isPassedWithoutOutcome(
        {
          status: "active",
          dueAt: passed,
          dateOutcomes: [{ dueAt: passed, outcome: "missed", recordedAt: 1 }],
        },
        start,
      ),
    ).toBe(false);
  });

  it("records missed once, keeps the date, and a rerun records nothing", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16); // yesterday noon NY
    const late = await tom.mutation(api.tts.createTodo, {
      statement: "pay rent",
      dueAt: passed,
    });
    const today = await tom.mutation(api.tts.createTodo, {
      statement: "call the bank",
      dueAt: Date.UTC(2026, 8, 5, 16),
    });
    const met = await tom.mutation(api.tts.createTodo, {
      statement: "submit form",
      dueAt: passed,
    });
    await tom.mutation(api.tts.setStatus, { id: met, status: "done" });
    // An undated row sorts before every date in the (status, dueAt) index; the
    // range the rollover reads must leave it out.
    const undated = await tom.mutation(api.tts.createTodo, { statement: "someday" });

    const first = await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY });
    expect(first).toEqual([late]);
    const second = await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY });
    expect(second).toEqual([]);

    const todos = await tom.query(api.tts.listTodos, {});
    const rolled = todos.find((x) => x._id === late)!;
    expect(rolled.dueAt).toBe(passed); // the original date is kept
    expect(rolled.status).toBe("active");
    expect(rolled.dateOutcomes).toEqual([
      { dueAt: passed, outcome: "missed", recordedAt: expect.any(Number), note: ROLLOVER_NOTE },
    ]);
    expect(todos.find((x) => x._id === today)!.dateOutcomes).toBeUndefined();
    expect(todos.find((x) => x._id === undated)!.dateOutcomes).toBeUndefined();
    // The met date resolved as done when the item completed; the rollover
    // left it alone.
    expect(todos.find((x) => x._id === met)!.dateOutcomes).toEqual([
      { dueAt: passed, outcome: "done", recordedAt: expect.any(Number) },
    ]);
    const events = await tom.query(api.tts.listRecentEvents, {});
    const outcomes = events.filter((e) => e.kind === "date-outcome" && e.todoId === late);
    expect(outcomes).toHaveLength(1);
    // The row says it is the rollover's, so the weekly gather never reads it
    // as Tom touching the item (convex/ttsWeekly.ts isTomTouch).
    expect(outcomes[0].data).toMatchObject({ outcome: "missed", rollover: true });
  });

  // Ruling 14 keeps the DATE, not a kind for it, and the mark is an annotation
  // by a cron: bumping updatedAt would resurface every already-ruled gate
  // through the needs-me ruledAt<updatedAt predicate.
  it("changes neither dateKind nor updatedAt", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16);
    const external = await tom.mutation(api.tts.createTodo, {
      statement: "renew the passport",
      dueAt: passed,
      dateKind: "external",
    });
    // A legacy row carrying a date and no dateKind at all — the row the old
    // applyDateOutcome path silently relabelled "self-imposed".
    const unlabelled = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "file the form",
        status: "active",
        readiness: "unprepared",
        timingClass: "dated",
        source: "tom",
        dueAt: passed,
        createdAt: passed,
        updatedAt: passed,
      }),
    );

    const before = await t.run(async (ctx) => ({
      external: (await ctx.db.get(external))!.updatedAt,
      unlabelled: (await ctx.db.get(unlabelled))!.updatedAt,
    }));
    expect(await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY })).toEqual(
      expect.arrayContaining([external, unlabelled]),
    );

    const after = await t.run(async (ctx) => ({
      external: (await ctx.db.get(external))!,
      unlabelled: (await ctx.db.get(unlabelled))!,
    }));
    expect(after.external.dateKind).toBe("external");
    expect(after.unlabelled.dateKind).toBeUndefined();
    expect(after.external.updatedAt).toBe(before.external);
    expect(after.unlabelled.updatedAt).toBe(before.unlabelled);
    // The date and the mark are both on record.
    expect(after.unlabelled.dueAt).toBe(passed);
    expect(after.unlabelled.dateOutcomes).toEqual([
      { dueAt: passed, outcome: "missed", recordedAt: expect.any(Number), note: ROLLOVER_NOTE },
    ]);
  });

  it("leaves a date renegotiated before the rollover alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 4, 12)); // 08:00 EDT on the 4th
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const original = Date.UTC(2026, 8, 4, 20); // 16:00 NY, still ahead
    const moved = Date.UTC(2026, 8, 8, 16);
    const todo = await tom.mutation(api.tts.createTodo, {
      statement: "call the plumber",
      dueAt: original,
    });
    await tom.mutation(api.tts.recordDateOutcome, {
      id: todo,
      outcome: "renegotiated",
      newDueAt: moved,
    });

    vi.setSystemTime(FIVE_AM);
    expect(await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY })).toEqual([]);
    const row = await t.run(async (ctx) => (await ctx.db.get(todo))!);
    expect(row.dueAt).toBe(moved);
    expect(row.dateOutcomes).toEqual([
      { dueAt: original, outcome: "renegotiated", recordedAt: expect.any(Number) },
    ]);
    vi.useRealTimers();
  });

  // DST: the rollover's window is the NY CALENDAR day, and both transition
  // nights shift the UTC instant of local midnight by an hour. A date at the
  // very end of the passed day is inside the passed day on both of them.
  it("rolls across both daylight-saving nights", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    // Spring forward: 2026-03-08 (EST → EDT). 2026-03-07 23:59 NY = 04:59 UTC
    // on the 8th, still the 7th on a New York clock.
    const springLate = Date.UTC(2026, 2, 8, 4, 59);
    const spring = await tom.mutation(api.tts.createTodo, {
      statement: "spring item",
      dueAt: springLate,
    });
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-03-07" }),
    ).toEqual([]); // its own day has not passed yet
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-03-08" }),
    ).toEqual([spring]);

    // Fall back: 2026-11-01 (EDT → EST). 2026-10-31 23:59 NY = 03:59 UTC on
    // the 1st.
    const fallLate = Date.UTC(2026, 10, 1, 3, 59);
    const fall = await tom.mutation(api.tts.createTodo, {
      statement: "fall item",
      dueAt: fallLate,
    });
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-10-31" }),
    ).toEqual([]);
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-11-01" }),
    ).toEqual([fall]);
  });

  it("treats 23:59 New York as that day, not the next", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const lastMinute = Date.UTC(2026, 8, 5, 3, 59); // 2026-09-04 23:59 EDT
    const todo = await tom.mutation(api.tts.createTodo, {
      statement: "midnight deadline",
      dueAt: lastMinute,
    });
    // The 5 a.m. rollover of the day it is due leaves it alone…
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-09-04" }),
    ).toEqual([]);
    // …and it is still listed as due that day.
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: "2026-09-04",
      now: Date.UTC(2026, 8, 4, 9),
    });
    expect(text).toContain("|Midnight deadline.");
    // The next morning's rollover marks it once.
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY }),
    ).toEqual([todo]);
  });
});

// ── The pure helpers this file still owns ──────────────────────────────────

describe("latenessText", () => {
  it("spells the countdown as a sentence, with small numbers as words", () => {
    const now = FIVE_AM;
    expect(latenessText(now, now)).toBe("Due today.");
    expect(latenessText(now + DAY, now)).toBe("Due tomorrow.");
    expect(latenessText(now + 4 * DAY, now)).toBe("Due in four days.");
    expect(latenessText(now - DAY, now)).toBe("One day late.");
    expect(latenessText(now - 10 * DAY, now)).toBe("Ten days late.");
    // Past the words, numerals: "six hundred and sixty-seven" is not scanned.
    expect(latenessText(now - 40 * DAY, now)).toBe("40 days late.");
  });
});

describe("calendarLeadText", () => {
  it("names the shape of the day in one sentence, never a list of times", () => {
    expect(
      calendarLeadText([
        { start: Date.UTC(2026, 8, 5, 20), end: Date.UTC(2026, 8, 5, 21), allDay: false },
        { start: Date.UTC(2026, 8, 6, 3), end: Date.UTC(2026, 8, 6, 3, 30), allDay: false },
      ]),
    ).toBe("Your day is committed from 16:00 to 23:30.");
    expect(calendarLeadText([{ start: 0, end: 0, allDay: true }])).toBe(
      "Your day carries one entry that runs all day and nothing timed.",
    );
  });
});

describe("the objection list's order and its narrow-list ids", () => {
  it("puts a refusal on a dated item first, then any refusal, then a missing answer", () => {
    const dated = new Set(["ph-due"]);
    const ready = new Set(["ph-ready"]);
    expect(objectionRank({ refused: true, todoId: "ph-due", decision: "x" }, ready, dated)).toBe(0);
    expect(objectionRank({ refused: true, todoId: "ph-other", decision: "x" }, ready, dated)).toBe(1);
    expect(objectionRank({ todoId: "ph-other", decision: null }, ready, dated)).toBe(2);
    expect(objectionRank({ todoId: "ph-due", decision: "x" }, ready, dated)).toBe(3);
    expect(objectionRank({ todoId: "ph-ready", decision: "x" }, ready, dated)).toBe(4);
    expect(objectionRank({ todoId: "ph-other", decision: "x" }, ready, dated)).toBe(5);
    expect(objectionRank({ decision: "x" }, ready, dated)).toBe(6);
  });

  it("drops the narrow list's id and keeps the sentence", () => {
    expect(stripNarrowListId("message-in-his-name — a message to another human in your name")).toBe(
      "a message to another human in your name",
    );
    expect(stripNarrowListId("a sentence with no id at all")).toBe("a sentence with no id at all");
  });
});

describe("internalComposeToday", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reads the rollover's mark, the night's outcomes, and what broke", async () => {
    // Pinned: "One day late." is a fact about the gap between the due date and
    // the reading clock, so a wall-clock run stops matching the day after it
    // was written.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16);
    const late = await tom.mutation(api.tts.createTodo, {
      statement: "pay rent",
      entryAction: "open the bank app",
      dueAt: passed,
    });
    await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY });
    const ready = await tom.mutation(api.tts.createTodo, { statement: "sign the form" });
    await t.run(async (ctx) => {
      await ctx.db.patch(ready, { readiness: "prepared" });
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: "poll-gmail-failed",
        data: { job: "poll-gmail", error: "token expired" },
      });
    });
    const { text, surfacedTodoIds, facts } = await t.query(
      internal.ttsDigest.internalComposeToday,
      { day: DAY_KEY, now: Date.now() + 1 },
    );
    expect(text).toContain(`- <${ttsItemLink(late)}|Pay rent: open the bank app. One day late.>`);
    // The ready count is a whole sentence, not a section and not a "+N more".
    expect(text).toContain("1 other todo is ready, and not one of them is dated.");
    expect(text).not.toContain("missed: reply done");
    expect(text).not.toContain("+1 more");
    // What broke says what it MEANS for him, not the event kind.
    expect(text).toContain("Nothing has been captured from email since the poller started failing.");
    expect(text).not.toContain("poll-gmail-failed");
    // Only the printed items are surfaced; the ready ones are a count.
    expect(surfacedTodoIds).toEqual([late]);
    // THE FACTS BLOCK, for the transcript and for the writer.
    expect(facts.kind).toBe("today");
    expect(facts.facts.map((f: { id: string }) => f.id)).toContain(`todo:${late}`);
  });

  // The ready count is ttsShared.isReadyForTom, each conjunct on its own row:
  // an unprepared row (a raw capture is never ready), a prepared row with a
  // need still open, and a prepared row asleep until tomorrow. None counts.
  it("counts no unprepared row, no row with an open need, and no sleeping row as ready", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const half = await tom.mutation(api.tts.createTodo, { statement: "half written up" });
    const need = await tom.mutation(api.tts.createTodo, { statement: "the need" });
    const blocked = await tom.mutation(api.tts.createTodo, { statement: "waits on the need" });
    const asleep = await tom.mutation(api.tts.createTodo, { statement: "asleep till tomorrow" });
    const plain = await tom.mutation(api.tts.createTodo, { statement: "sign the form" });
    await t.run(async (ctx) => {
      await ctx.db.patch(half, { readiness: "unprepared" });
      await ctx.db.patch(blocked, { readiness: "prepared", needs: [need] });
      await ctx.db.patch(asleep, { readiness: "prepared", wakeAt: Date.now() + DAY });
      await ctx.db.patch(plain, { readiness: "prepared" });
    });
    const first = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: Date.now() + 1,
    });
    expect(first.text).toContain("1 other todo is ready");
    // The need closes and the sleep passes: both count.
    await t.run(async (ctx) => {
      await ctx.db.patch(need, { status: "done", doneAt: Date.now() });
      await ctx.db.patch(asleep, { wakeAt: Date.now() - 1 });
    });
    const later = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: Date.now() + 1,
    });
    expect(later.text).toContain("3 other todos are ready");
  });

  // A CAPTURE FROM EMAIL IS NOT ITS OWN SECTION any more (§4.3): one that is
  // dated is a dated line, one that is ready is part of the count, and one
  // that is neither is a row, not a line.
  // Tom, 2026-09-21: workers "should not reach me at all directly". A mail the
  // triage judged to need him today opens no thread; the morning message
  // names it with its reason, as a fact the writer's verifier holds it to.
  it("names every mail capture judged to need him today, with its reason, and a fact for each", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const urgent = await t.mutation(internal.tts.internalCapture, {
      statement: "Pay the lab deposit invoice",
      source: "email",
      needsTomToday: { why: "the invoice is due tomorrow" },
    });
    const done = await t.mutation(internal.tts.internalCapture, {
      statement: "Answer the registrar",
      source: "email",
      needsTomToday: { why: "a person is waiting" },
    });
    await t.mutation(internal.tts.internalCapture, { statement: "Read the newsletter", source: "email" });
    await t.run(async (ctx) => ctx.db.patch(done, { status: "done" }));
    vi.setSystemTime(FIVE_AM);
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text).toContain("One captured todo needs you today");
    expect(text).toContain("Pay the lab deposit invoice, which needs you today because the invoice is due tomorrow.");
    expect(text).toContain(ttsItemLink(urgent));
    expect(text).not.toContain("Answer the registrar");
    expect(text).not.toContain("Read the newsletter");
    expect(facts.facts.map((f) => f.id)).toContain(`needs-you-today:${urgent}`);
    expect(facts.facts.find((f) => f.id === "needs-you-today:count")?.numbers).toContain("1");
    expect(facts.facts.map((f) => f.id)).not.toContain(`needs-you-today:${done}`);
  });

  it("says a flagged capture that is also dated once, in the needs-you run, with its reason and lateness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const dated = await t.mutation(internal.tts.internalCapture, {
      statement: "Pay the lab deposit invoice",
      source: "email",
      needsTomToday: { why: "the invoice is due tomorrow" },
    });
    await t.run(async (ctx) => ctx.db.patch(dated, { timingClass: "dated", dueAt: Date.UTC(2026, 8, 4, 16), dateKind: "external" }));
    vi.setSystemTime(FIVE_AM);
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    expect(text.split("Pay the lab deposit invoice")).toHaveLength(2);
    // Said in the needs-you run, with its reason and its lateness, and its
    // one fact is the needs-you one.
    expect(text).toContain("Pay the lab deposit invoice, which needs you today because the invoice is due tomorrow. One day late.");
    expect(facts.facts.map((f) => f.id)).toContain(`needs-you-today:${dated}`);
    expect(facts.facts.map((f) => f.id)).not.toContain(`todo:${dated}`);
    expect(facts.facts.find((f) => f.id === "needs-you-today:count")?.numbers).toContain("1");
  });

  it("does not count a flagged item among the other ready items it prints", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const flagged = await t.mutation(internal.tts.internalCapture, {
      statement: "Pay the lab deposit invoice", source: "email", needsTomToday: { why: "the invoice is due tomorrow" },
    });
    const plain = await t.mutation(internal.tts.internalCapture, { statement: "Read the newsletter", source: "slack-capture" });
    await t.run(async (ctx) => {
      await ctx.db.patch(flagged, { readiness: "prepared", entryAction: "open the invoice" });
      await ctx.db.patch(plain, { readiness: "prepared", entryAction: "open it" });
    });
    vi.setSystemTime(FIVE_AM);
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    const ready = facts.facts.find((f) => f.id === "ready:beyond");
    expect(text).toContain("Pay the lab deposit invoice, which needs you today");
    expect(ready?.numbers).toContain("1");
    expect(ready?.numbers).not.toContain("2");
  });

  it("marks every flagged item it prints as surfaced, once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const flagged = await t.mutation(internal.tts.internalCapture, {
      statement: "Pay the lab deposit invoice", source: "email", needsTomToday: { why: "the invoice is due tomorrow" },
    });
    await t.run(async (ctx) => ctx.db.patch(flagged, { timingClass: "dated", dueAt: Date.UTC(2026, 8, 4, 16), dateKind: "external" }));
    const undated = await t.mutation(internal.tts.internalCapture, {
      statement: "Answer the registrar", source: "email", needsTomToday: { why: "a person is waiting" },
    });
    vi.setSystemTime(FIVE_AM);
    const { surfacedTodoIds } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    expect(surfacedTodoIds.filter((id) => id === flagged)).toHaveLength(1);
    expect(surfacedTodoIds).toContain(undated);
  });

  it("marks as surfaced only the flagged items the fitted message printed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const ids = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push(await t.mutation(internal.tts.internalCapture, {
        statement: `Answer the registrar about enrolment form number ${i} before the office closes on Friday afternoon`,
        source: "email",
        needsTomToday: { why: "a person in the registrar's office is waiting on your reply" },
      }));
    }
    vi.setSystemTime(FIVE_AM);
    const { text, surfacedTodoIds } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    const printed = ids.filter((id) => text.includes(ttsItemLink(id)));
    expect(printed.length).toBeLessThan(40);
    expect(ids.filter((id) => surfacedTodoIds.includes(id)).sort()).toEqual(printed.sort());
  });

  it("brings a flagged item whose line was dropped for length back the next morning, and never repeats one shown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const ids = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push(await t.mutation(internal.tts.internalCapture, {
        statement: `Answer the registrar about enrolment form number ${i} before the office closes on Friday afternoon`,
        source: "email",
        needsTomToday: { why: "a person in the registrar's office is waiting on your reply" },
      }));
    }
    vi.setSystemTime(FIVE_AM);
    const first = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    // The box records the digest it posted; the hook marks what it showed.
    await t.mutation(internal.jarvis.events.record, {
      kind: "digest-sent",
      data: { day: DAY_KEY, surfacedTodoIds: first.surfacedTodoIds, windowEnd: FIVE_AM + 1, truncated: first.truncated },
    });
    const shownFirst = ids.filter((id) => first.text.includes(ttsItemLink(id)));
    expect(shownFirst.length).toBeLessThan(40);
    vi.setSystemTime(FIVE_AM + DAY);
    const second = await t.query(internal.ttsDigest.internalComposeToday, { day: "2026-09-06", now: FIVE_AM + DAY + 1 });
    const shownSecond = ids.filter((id) => second.text.includes(ttsItemLink(id)));
    expect(shownSecond.length).toBeGreaterThan(0);
    expect(shownSecond.some((id) => shownFirst.includes(id))).toBe(false);
  });

  it("keeps the flagged item the first line names, however many flagged dated items overflow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const ids = [];
    for (let i = 0; i < 40; i += 1) {
      vi.setSystemTime(FIVE_AM - 3_600_000 + i * 1000);
      const id = await t.mutation(internal.tts.internalCapture, {
        statement: `Answer the registrar about enrolment form number ${i} before the office closes on Friday afternoon`,
        source: "email",
        needsTomToday: { why: "a person in the registrar's office is waiting on your reply" },
      });
      // The LAST captured carries the OLDEST date, so capture order and date order disagree.
      await t.run(async (ctx) => ctx.db.patch(id, { timingClass: "dated", dueAt: Date.UTC(2026, 7, 1, 16) + (39 - i) * 3_600_000, dateKind: "external" }));
      ids.push(id);
    }
    vi.setSystemTime(FIVE_AM);
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    const firstLine = text.split("\n")[0];
    const named = ids.find((id, i) => firstLine.toLowerCase().includes(`form number ${i} `));
    expect(named).toBeDefined();
    expect(text).toContain(ttsItemLink(named!));
  });

  it("does not mark a dated flagged item surfaced when the fitted message dropped its line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const ids = [];
    for (let i = 0; i < 40; i += 1) {
      const id = await t.mutation(internal.tts.internalCapture, {
        statement: `Answer the registrar about enrolment form number ${i} before the office closes on Friday afternoon`,
        source: "email",
        needsTomToday: { why: "a person in the registrar's office is waiting on your reply" },
      });
      await t.run(async (ctx) => ctx.db.patch(id, { timingClass: "dated", dueAt: Date.UTC(2026, 8, 4, 16), dateKind: "external" }));
      ids.push(id);
    }
    vi.setSystemTime(FIVE_AM);
    const { text, surfacedTodoIds } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM + 1 });
    const printed = ids.filter((id) => text.includes(ttsItemLink(id)));
    expect(printed.length).toBeLessThan(40);
    expect(ids.filter((id) => surfacedTodoIds.includes(id)).sort()).toEqual(printed.sort());
  });

  it("stores the triage's reason with secrets redacted", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.tts.internalCapture, {
      statement: "Rotate the leaked key",
      source: "email",
      needsTomToday: { why: "the mail quotes ghp_abcdefghijklmnopqrstuvwxyz0123456789 in full" }, // gitleaks:allow
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.needsTomToday?.why).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789"); // gitleaks:allow
  });

  it("lists a dated email capture once, under today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const dated = await tom.mutation(api.tts.createTodo, {
      statement: "reply to Ana",
      dueAt: Date.UTC(2026, 8, 5, 16),
    });
    const undated = await tom.mutation(api.tts.createTodo, { statement: "read the newsletter" });
    await t.run(async (ctx) => {
      await ctx.db.patch(dated, { source: "email" });
      await ctx.db.patch(undated, { source: "email" });
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text.split("Reply to Ana")).toHaveLength(2); // one line only
    expect(text).not.toContain("Captured from email");
    expect(text).not.toContain("read the newsletter");
  });

  // OUTCOMES, NEVER LOGGED EVENTS, ONE LINE PER TODO (Tom, 2026-09-24: no
  // batches). Two sessions on one todo are one sentence about that todo,
  // linking it; a session on no todo joins the tail, linking the session.
  it("turns a night of sessions into one line per todo, linking the todo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const { todo, ended, live, loose } = await t.run(async (ctx) => {
      const todo = await ctx.db.insert("dtsTodos", {
        statement: "walk the research critical path",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        kind: "task",
        actor: "tom",
        source: "manual",
        createdAt: FIVE_AM - DAY,
        updatedAt: FIVE_AM - DAY,
      });
      const base = { repo: "none", repos: [], nextSeq: 0, createdAt: FIVE_AM - 7200_000 };
      const ended = await ctx.db.insert("claudeSessions", { ...base, title: "one", kind: "gate", todoId: todo, status: "ended", statusChangedAt: FIVE_AM - 3600_000 });
      const live = await ctx.db.insert("claudeSessions", { ...base, title: "two", kind: "gate", todoId: todo, status: "running", statusChangedAt: FIVE_AM - 3600_000 });
      const loose = await ctx.db.insert("claudeSessions", { ...base, title: "three", kind: "adhoc", status: "ended", statusChangedAt: FIVE_AM - 3600_000 });
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3600_000, kind: "session-outcome", todoId: todo, data: { sessionId: ended, outcome: "completed" } });
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3500_000, kind: "session-created", todoId: todo, data: { sessionId: live } });
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3400_000, kind: "session-outcome", data: { sessionId: loose, outcome: "completed" } });
      return { todo, ended, live, loose };
    });
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text).toContain(
      `- <${ttsItemLink(todo)}|Walk the research critical path: 1 session on it ended and one is still running.>`,
    );
    expect(text).toContain(`- <${ttsSessionLink(loose)}|1 session on no todo ended.>`);
    expect(text).not.toContain("tab=batches");
    const ids = facts.facts.map((f) => f.id);
    expect(ids).toContain(`overnight-todo:${todo}`);
    expect(ids).toContain("overnight-todo:none");
    expect(ids).not.toContain(`overnight-todo:${ended}`);
    expect(ids).not.toContain(`overnight-todo:${live}`);
  });

  // A "graph-stored" row from before batches were removed names only its
  // batch; the digest makes no fact and no line of it.
  // witness: read "graph-stored" rows into the overnight facts again.
  it("makes nothing of an old plan-pass row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const batchId = "k570000000000000000000000000batch";
    await t.run(async (ctx) => {
      for (const counts of [{ created: 3, retired: 1 }, {}, { created: 1 }, { updated: 2 }]) {
        await ctx.db.insert("dtsEvents", {
          at: FIVE_AM - 3600_000,
          kind: "graph-stored",
          data: { batchId, ...counts },
        });
      }
    });
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    // The plan pass that wrote "graph-stored" rows is gone, and the digest
    // reads none: an old row names only a batch, and no fact comes of it.
    expect(facts.facts.some((f) => f.id.startsWith("batch:") || f.id === "overnight:count")).toBe(false);
    expect(facts.facts.flatMap((f) => f.urls).some((url) => url.includes("tab=batches"))).toBe(false);
    expect(text).not.toContain("The research critical path");
    expect(text.toLowerCase()).not.toContain("batch");
    for (const word of ["plan stored", "created", "retired", "session opened", "worker event"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  // THE FAMILY CALENDAR NEVER APPEARS IN ANYTHING SENT TO HIM (Tom
  // 2026-09-09). The rows stay in the record — scheduling still knows he is
  // busy — and no message, and no facts block, names one.
  it("drops every row from a feed marked private, and keeps the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsCalendarEvents", {
        feed: "google",
        uid: "u1",
        title: "PT",
        start: Date.UTC(2026, 8, 5, 20),
        end: Date.UTC(2026, 8, 5, 21),
        allDay: false,
        syncedAt: FIVE_AM,
      });
      await ctx.db.insert("ttsCalendarEvents", {
        feed: "family",
        uid: "u2",
        title: "Dinner with the family",
        start: Date.UTC(2026, 8, 6, 0),
        end: Date.UTC(2026, 8, 6, 1),
        allDay: false,
        syncedAt: FIVE_AM,
      });
    });
    vi.stubEnv(
      "TTS_ICS_FEEDS",
      JSON.stringify([
        { name: "google", url: "https://example.invalid/g.ics" },
        { name: "family", url: "https://example.invalid/f.ics", private: true },
      ]),
    );
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text).toContain("PT runs 16:00 to 17:00.");
    expect(text).not.toContain("Dinner with the family");
    expect(text).not.toContain("private");
    expect(JSON.stringify(facts)).not.toContain("Dinner with the family");
    // The row is still there: the schedule knows he is busy.
    const rows = await t.run(async (ctx) => ctx.db.query("ttsCalendarEvents").collect());
    expect(rows).toHaveLength(2);
  });

  it("treats an unreadable TTS_ICS_FEEDS as every feed being private", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsCalendarEvents", {
        feed: "google",
        uid: "u1",
        title: "PT",
        start: Date.UTC(2026, 8, 5, 20),
        end: Date.UTC(2026, 8, 5, 21),
        allDay: false,
        syncedAt: FIVE_AM,
      });
    });
    vi.stubEnv("TTS_ICS_FEEDS", "{not json");
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text).not.toContain("PT runs");
  });

  // The delegate is built on branch uac/delegate. Its rows are read BY KIND if
  // they are there, and nothing is printed when they are not.
  it("renders the objection list from delegate rows, numbered in printed order", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "renew the passport" });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: DELEGATE_DECISION,
        key: "ask-1",
        todoId,
        data: {
          askId: "ask-1",
          decision: "moved the passport appointment to Thursday",
          reason: "the consulate shuts on Wednesdays this month",
          refused: false,
        },
      });
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1800_000,
        kind: DELEGATE_DECISION,
        key: "ask-2",
        data: {
          askId: "ask-2",
          decision: "emailed the landlord chasing the deposit",
          refused: true,
          refusedBecause: "message-in-his-name — a message to another human in your name",
        },
      });
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    // The refusal ranks first, so it is number 1 in PRINTED order.
    expect(text).toContain(
      "1. REFUSED and parked: it would have emailed the landlord chasing the deposit — a message to another human in your name.",
    );
    expect(text).toContain(
      "2. Moved the passport appointment to Thursday, because the consulate shuts on Wednesdays this month.",
    );
    // The narrow list's id is for the record, not for a morning read.
    expect(text).not.toContain("message-in-his-name");
    expect(objectionAskIds).toEqual(["ask-2", "ask-1"]);
    expect(text).toContain('reply "revert 2", or "2: what to do instead".');
  });

  // A merge is reported for objection too, and its wording never assigns it to
  // the delegate: nothing was decided in Tom's name, three checks passed.
  it("reports a mechanically gated merge in the same list, under its own key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1800_000,
        kind: MERGE,
        key: "tom.quest:a1b2c3d4e5f6",
        data: {
          repo: "tom.quest",
          sha: "a1b2c3d4e5f6",
          subject: "the mechanical merge gate",
        },
      });
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(text).toContain("1. Merged tom.quest@a1b2c3d: the mechanical merge gate.");
    // Its number names the merge's own key: "revert 1" objects to the merge,
    // as a reply in its #tts-decisions thread did before there was one channel.
    expect(objectionAskIds).toEqual(["tom.quest:a1b2c3d4e5f6"]);
  });

  // A MESSAGE SENT IN HIS NAME on his own sign-off (convex/ttsSignoff.ts) is
  // listed with the decisions taken in his name, and the lead credits it to
  // him rather than to the delegate or the gates.
  it("lists a message sent in his name on his sign-off, credited to neither the delegate nor the gates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1800_000,
        kind: "sent-as-tom",
        data: {
          recipient: "Sarah Chen",
          channel: "slack:C0SARAH01",
          sha256: "ab".repeat(32),
          signedAt: FIVE_AM - 1800_000,
        },
      });
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(text).toContain("One message went out on your sign-off.");
    expect(text).toMatch(/1\. Sent as you to Sarah Chen on Slack C0SARAH01, signed at \d\d:\d\d\./);
    expect(text).not.toContain("decided in your name");
    expect(objectionAskIds).toEqual([""]);
  });

  // THE WEEKLY SIMPLIFICATION PASS reports each line it means to remove in
  // #tts-decisions as it records it; this list is the last call on the same
  // row. Unlike a merge its number DOES name an askId — the proposal's key is
  // the askId of its own thread — so "revert 1" in the morning resolves the
  // same row a reply in that thread would.
  it("lists a simplification proposal, names its key, and leaves a dry run out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1800_000,
        kind: SIMPLIFY_PROPOSAL,
        key: "simplify:s1",
        data: {
          id: "s1",
          sentence: "removed the three roll-out shims from convex/http.ts",
          evidence: "nothing has posted to them in six weeks",
        },
      });
      // A dry run proves the path and removes nothing, so there is nothing to
      // object to and it is not a morning line.
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1200_000,
        kind: SIMPLIFY_PROPOSAL,
        key: "simplify:s2",
        data: { id: "s2", sentence: "removed a line nobody proposed for real", dryRun: true },
      });
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(text).toContain(
      "1. Removed the three roll-out shims from convex/http.ts, because nothing has posted to them in six weeks.",
    );
    expect(text).not.toContain("nobody proposed for real");
    expect(objectionAskIds).toEqual(["simplify:s1"]);
  });

  // THE REMOVAL LOOP's pull request closes its window on "a digest sent a day
  // after it", so the digest carries it, keyed like its #tts-simplify thread.
  it("lists a removal-loop pull request under its thread's key, and leaves a dry run out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1800_000,
        kind: REMOVAL_LOOP_PR,
        key: "loop:7",
        data: {
          pr: 7,
          url: "https://github.com/Heffnt/tom.quest/pull/7",
          subject: "removed the second copy of the tick formatter",
          ruleId: "duplicated-helper",
          path: "app/boolback/components/plot-surface.tsx",
        },
      });
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1200_000,
        kind: REMOVAL_LOOP_PR,
        key: "loop:8",
        data: { pr: 8, url: "https://github.com/Heffnt/tom.quest/pull/8", subject: "removed nothing for real", dryRun: true },
      });
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(text).toContain(
      "1. Removed the second copy of the tick formatter, because duplicated-helper in app/boolback/components/plot-surface.tsx.",
    );
    expect(text).not.toContain("nothing for real");
    expect(objectionAskIds).toEqual(["loop:7"]);
  });

  // THE CAP AND THE NUMBERING ARE ONE INVARIANT: a number Tom types must name
  // a line he could see, so the askIds recorded are exactly the ones printed.
  // ttsCompose SECTION_CAPS.objections is what cuts the list; this asserts the
  // two agree, which is the only reason "revert 12" means what it says.
  it("prints twelve of fifteen, says where the rest are, and records only the twelve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      for (let n = 0; n < 15; n += 1) {
        await ctx.db.insert("dtsEvents", {
          at: FIVE_AM - (15 - n) * 60_000,
          kind: DELEGATE_DECISION,
          key: `ask-${n}`,
          data: { askId: `ask-${n}`, decision: `took decision ${n}`, refused: false },
        });
      }
    });
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(objectionAskIds).toHaveLength(12);
    expect(text).toContain("12. Took decision");
    expect(text).not.toContain("13. ");
    expect(text).toContain("3 more decisions are on the page.");
  });

  // witness: the record's decisions were read oldest first before the cap,
  // and their reasons went out unredacted.
  it("reads the record's decisions newest first and redacts the model's words", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"; // gitleaks:allow
    await t.run(async (ctx) => {
      for (let n = 0; n < 201; n += 1) {
        await ctx.db.insert("events", {
          kind: "decision",
          at: FIVE_AM - 3 * 3600_000 + n * 1_000,
          provenance: { job: "decide" },
          subject: `d-${n}`,
          data: { question: "q", decision: `took decision ${n}`, refused: false },
        });
      }
      await ctx.db.insert("events", {
        kind: "decision", at: FIVE_AM - 60_000, provenance: { job: "decide" }, subject: "d-secret",
        data: { question: "q", decision: `used ${secret}`, reason: `because ${secret}`, refused: true, refusedBecause: `it holds ${secret}` },
      });
    });
    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, { day: DAY_KEY, now: FIVE_AM, since: FIVE_AM - 86_400_000 }));
    const askIds = facts.objections.map((o) => o.askId);
    expect(askIds).toContain("d-200");
    expect(askIds).not.toContain("d-0");
    expect(JSON.stringify(facts.objections)).not.toContain(secret);
    expect(askIds).toContain("d-secret");
  });

  // witness: a failed flush wrote session-ended (failed) and session-outcome
  // (errored) for one session, and the digest grouped every session failure
  // under one key: one failure counted twice, and one session's link beside
  // another's detail.
  it("gives each failed session one line with its own link and detail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3600_000, kind: "session-ended", data: { sessionId: "sess-a", status: "failed", endedReason: "flush failed" } });
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3590_000, kind: "session-outcome", data: { sessionId: "sess-a", outcome: "errored", summary: "the flush broke" } });
      await ctx.db.insert("dtsEvents", { at: FIVE_AM - 3000_000, kind: "session-ended", data: { sessionId: "sess-b", status: "failed", endedReason: "out of memory" } });
    });
    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, { day: DAY_KEY, now: FIVE_AM, since: FIVE_AM - 86_400_000 }));
    const sessions = facts.broken.filter((row) => row.url?.includes("sess-"));
    expect(sessions).toHaveLength(2);
    expect(sessions.map((row) => [row.url, row.detail, row.count])).toEqual([
      [ttsSessionLink("sess-a"), "flush failed", 1],
      [ttsSessionLink("sess-b"), "out of memory", 1],
    ]);
  });

  // THE SAME INVARIANT, ON THE OTHER CUT. ttsCompose.fit reduces a whole run to
  // its lead plus one "N more lines are on the page" line when the message will
  // not fit, and the objection list is the second-to-last ranked run, so a busy
  // today section takes it. The askIds are read off the FITTED message for
  // exactly this: recorded from the pre-fit facts, "revert 2" would revert a
  // decision Tom was never shown.
  it("records no askId for an objection list the fit reduced away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const filler = "which is a whole sentence about something that takes up most of one line";
    for (let n = 0; n < 12; n += 1) {
      await tom.mutation(api.tts.createTodo, {
        statement: `A dated thing number ${n} ${filler}`,
        entryAction: `open the page and start on it ${filler}`,
        dueAt: Date.UTC(2026, 8, 4, 16),
      });
    }
    await t.run(async (ctx) => {
      for (let n = 0; n < 12; n += 1) {
        await ctx.db.insert("dtsEvents", {
          at: FIVE_AM - (12 - n) * 60_000,
          kind: DELEGATE_DECISION,
          key: `ask-${n}`,
          data: {
            // No comma anywhere: ttsCompose.statement cuts at the last clause
            // boundary, and a "because" clause would shorten every line to
            // half a Slack line and leave the message under the cap.
            askId: `ask-${n}`,
            decision: `took decision ${n} ${filler} and then went on doing rather more of the same until the line was full`,
            refused: false,
          },
        });
      }
    });
    const { text, truncated, objectionAskIds } = await t.query(
      internal.ttsDigest.internalComposeToday,
      { day: DAY_KEY, now: FIVE_AM },
    );
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    // The today run — nearest him — kept every one of its twelve lines, and the
    // objection list is the run that went.
    expect(text).toContain("A dated thing number 0");
    expect(text).toContain("12 more lines are on the page.");
    expect(text).not.toContain("1. Took decision");
    // Nothing he could see, so nothing a number can name: every reply of
    // "revert N" falls through to the ordinary paths (ttsSlack.namedObjection
    // treats an empty or missing entry as naming no printed line).
    expect(objectionAskIds).toEqual([]);
  });

  // These two cases exist only because the morning message narrowed: the
  // delivery check and the evals result used to have a section of their own,
  // and now a PROBLEM in either is a #tts-broken line while a clean run is the
  // weekly's fact. Both halves are asserted, because "prints nothing" is the
  // half that goes wrong silently.
  it("reports a stale prelude delivery as broken, and says nothing about a clean one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const clean = convexTest(schema, modules);
    await withTom(clean);
    await clean.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: PRELUDE_DELIVERY,
        data: { current: 14, stale: [], missing: [] },
      });
    });
    const quiet = await clean.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(quiet.text).not.toContain("model-of-tom");

    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: PRELUDE_DELIVERY,
        data: {
          current: 1,
          stale: [{ id: "j57abc", title: "weekly agenda", had: "7fc21ab4c1de", behindDays: 2 }],
          missing: [{ id: "j57ghi", title: "adhoc" }],
        },
      });
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).toContain("Sessions ran without the model-of-tom they should have had");
    expect(text).toContain("1 from an older commit");
    expect(text).toContain("1 from none at all");
    expect(text).toContain("weekly agenda");
  });

  // witness: the digest read only the legacy evals-run rows in dtsEvents,
  // and the runner writes eval-run rows to events, so a failed set never
  // reached the broken section.
  it("reports a set whose newest eval run failed items as broken, and says nothing about a clean set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const run = (at: number, set: string, items: { name: string; pass: boolean | null; note: string }[]) => ({
      kind: EVAL_RUN,
      at,
      provenance: { job: "evals" },
      subject: set,
      data: {
        set,
        items,
        passed: items.filter((item) => item.pass === true).length,
        failed: items.filter((item) => item.pass === false).length,
        skipped: items.filter((item) => item.pass === null).length,
        total: items.filter((item) => item.pass !== null).length,
      },
    });
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", run(FIVE_AM - 7200_000, "wall", [{ name: "wall/redaction", pass: false, note: "leaked" }]));
      await ctx.db.insert("events", run(FIVE_AM - 3600_000, "wall", [{ name: "wall/redaction", pass: true, note: "" }]));
      await ctx.db.insert("events", run(FIVE_AM - 3600_000, "rule", [
        { name: "rule/ruling-758ddm40", pass: false, note: "expected archive, got session" },
        { name: "rule/ruling-td8dkhd8", pass: true, note: "" },
      ]));
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: FIVE_AM });
    expect(text).toContain("The rule evals failed 1 of 2 items in their newest run.");
    expect(text).toContain("rule/ruling-758ddm40");
    expect(text).not.toContain("The wall evals");
  });

  it("renders nothing at all when there are no delegate rows", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).not.toContain("decided in your name");
    expect(objectionAskIds).toEqual([]);
  });

  // THE ONE CONFIG CHECK (§5.2). Every reply invitation in every message is
  // conditional on this and on nothing else.
  it("invites a reply only when the caller says the route is live", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    await tom.mutation(api.tts.createTodo, {
      statement: "pay rent",
      dueAt: Date.UTC(2026, 8, 4, 16),
    });
    const dead = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: false,
    });
    expect(dead.text).not.toContain("reply");
    const live = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
      canReply: true,
    });
    expect(live.text).toContain('reply "done" on a line, or give it a new date.');
  });

  // The window starts where the last one ENDED. Composing and posting take
  // seconds; anything recorded in them would be reported by neither morning if
  // the window started at the row's own `at`.
  it("starts the window at the last send's windowEnd, not the row's time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const windowEnd = FIVE_AM - DAY;
    const rowAt = windowEnd + 90_000; // the send finished 90s after composing
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: rowAt,
        kind: DIGEST_SENT,
        data: { day: "2026-09-04", windowEnd },
      });
      // A failure recorded inside those 90 seconds.
      await ctx.db.insert("dtsEvents", {
        at: windowEnd + 30_000,
        kind: "poll-gmail-failed",
        data: { job: "poll-gmail", error: "token expired" },
      });
    });
    const { since, text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(windowEnd);
    expect(text).toContain("Nothing has been captured from email");
  });

  // Rows from before windowEnd existed are August's, from the digest's first
  // life. Naming their `at` as the next window's start would open a weeks-wide
  // window on the first morning after the deploy, so they are ignored and the
  // window is the ordinary last day.
  it("covers the last day when the newest row predates windowEnd", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 7 * DAY,
        kind: DIGEST_SENT,
        data: { day: "2026-08-29" },
      });
    });
    const { since } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(FIVE_AM - DAY);
  });

  // A day the morning never went out widens the next one's window instead of
  // losing the day: the window is [last send, now], not a fixed 24 hours.
  it("widens the window over a skipped day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const twoDaysBack = FIVE_AM - 2 * DAY;
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: twoDaysBack,
        kind: DIGEST_SENT,
        data: { day: "2026-09-03", windowEnd: twoDaysBack },
      });
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1.5 * DAY,
        kind: "job-failed",
        data: { job: "poll-canvas", error: "canvas token expired" },
      });
    });
    const { since, text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(twoDaysBack);
    expect(text).toContain("Canvas assignments have stopped reaching your list.");
  });

  // The box's jobs report their failures as "job-failed" through POST
  // /tts/job-failed, so the kind alone does not say which job broke — the row
  // names it, and the line has to say what THAT job stopping means for him.
  it("says what a named job's failure means for him, never the event kind", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: "job-failed",
        data: { job: "poll-canvas", error: "Canvas rejected the access token (HTTP 401)" },
      });
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).toContain("Canvas assignments have stopped reaching your list.");
    expect(text).toContain("Canvas rejected the access token (HTTP 401).");
    expect(text).not.toContain("job-failed");
  });

  // A JOB'S `error` IS ITS OWN STDERR. worker/jobs/nightly.mjs reports git's
  // verbatim, and git names its remote with the token in it — so the string
  // goes through redactSecrets (the one choke point, convex/ttsSearch.ts and
  // worker/session-host use the same helper) before it is a line, and before
  // todayFactsBlock turns it into the `broken:<n>` fact a model is handed.
  it("takes a credential out of a job's error before it is a line or a fact", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: "job-failed",
        data: {
          job: "nightly",
          error: "fatal: could not read ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com",
        },
      });
    });
    const { text, facts } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).not.toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(text).toContain("[redacted:github]");
    const broken = facts.facts.filter((f: { id: string }) => f.id.startsWith("broken:"));
    expect(broken).toHaveLength(1);
    expect(broken[0].text).not.toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
  });
});

// ── What the channels carried is a section of the digest ─────────────────────
// One output channel (Tom, 2026-09-26): a producer whose fact the digest reads
// from a row of its own posts nothing; one whose fact it does not puts a line
// on the next digest (convex/jarvis/outbox.ts listForDigest), and the digest
// prints it in the objection list or the broken section.
describe("the channels' lines, in the digest", () => {
  const COMPOSE_AT = FIVE_AM + 60_000;
  const compose = (t: ReturnType<typeof convexTest>) =>
    t.query(internal.ttsDigest.internalComposeToday, { day: DAY_KEY, now: COMPOSE_AT, since: FIVE_AM - DAY });

  it("a model-of-Tom line and a failed learning night are lines on the digest, and nothing is posted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "learning-change",
      key: "not-a-key",
      data: { id: "a1b2c3d4e5f6", file: "model-of-tom/week.md", before: "", after: "climbing is on Tuesdays", evidence: "his message of 09-20" },
    });
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "learning-check-failed",
      data: { baseline: false, changes: 2 },
    });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("ttsSync"))).toEqual([]);

    const { text, objectionAskIds } = await compose(t);
    expect(text).toContain("odel-of-tom/week.md now says climbing is on Tuesdays [a1b2c3d4e5f6]");
    expect(objectionAskIds).toContain("learning:a1b2c3d4e5f6");
    expect(text).toContain("took every one back");
    // The row's own generic failure line is not printed a second time.
    expect(text).not.toContain("The learning-check job failed");
    vi.useRealTimers();
  });

  it("a removal-loop pull request posts nothing: the objection list reads its row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIVE_AM - 3_600_000);
    const t = convexTest(schema, modules);
    const pr = { pr: 7, url: "https://github.com/Heffnt/tom.quest/pull/7", subject: "removed a copy", ruleId: "dead-export", path: "app/a.ts" };
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, { kind: REMOVAL_LOOP_PR, key: "loop:7", data: { ...pr, round: 1 } });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
    const { objectionAskIds } = await compose(t);
    expect(objectionAskIds).toContain("loop:7");
    vi.useRealTimers();
  });
});
