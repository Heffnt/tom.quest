import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DELEGATE_DECISION } from "./ttsAsk";
import { MERGE } from "./ttsMerge";
import { SIMPLIFY_PROPOSAL } from "./ttsSimplify";
import { EVALS_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import {
  DIGEST_SENT,
  ROLLOVER_NOTE,
  SLACK_FAILED,
  SLACK_SENT,
  WIKITOM_UNREADABLE,
  calendarLeadText,
  isPassedWithoutOutcome,
  latenessText,
  objectionRank,
  stripNarrowListId,
  todaySubject,
} from "./ttsDigest";
import { MESSAGE_MAX_CHARS, TAB_BATCHES } from "./ttsCompose";
import { nyCalendarDayBoundsUtc, ttsDayKey, ttsItemLink } from "./ttsShared";

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
    expect(text).toContain("1 other item is ready, and not one of them is dated.");
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
    expect(first.text).toContain("1 other item is ready");
    // The need closes and the sleep passes: both count.
    await t.run(async (ctx) => {
      await ctx.db.patch(need, { status: "done", doneAt: Date.now() });
      await ctx.db.patch(asleep, { wakeAt: Date.now() - 1 });
    });
    const later = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: Date.now() + 1,
    });
    expect(later.text).toContain("3 other items are ready");
  });

  // A CAPTURE FROM EMAIL IS NOT ITS OWN SECTION any more (§4.3): one that is
  // dated is a dated line, one that is ready is part of the count, and one
  // that is neither is a row, not a line.
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

  // OUTCOMES, NEVER LOGGED EVENTS. Four "graph-stored" rows on one batch are
  // one sentence about that batch, and the words those rows are spelled with
  // reach no message.
  it("turns a night of plan-stored rows into one sentence per batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const batchId = await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement: "The research critical path",
        status: "active",
        createdAt: FIVE_AM - DAY,
        updatedAt: FIVE_AM - DAY,
      }),
    );
    await t.run(async (ctx) => {
      for (const counts of [{ created: 3, retired: 1 }, {}, { created: 1 }, { updated: 2 }]) {
        await ctx.db.insert("dtsEvents", {
          at: FIVE_AM - 3600_000,
          kind: "graph-stored",
          data: { batchId, ...counts },
        });
      }
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM + 1,
    });
    expect(text).toContain("The research critical path gained 4 items, reworked 2 and dropped 1.");
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
  it("reports a mechanically gated merge in the same list, with no askId of its own", async () => {
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
    // Its number names no askId: a merge is not a delegate decision, so a
    // reply that types its number falls through to the ordinary paths.
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

  it("reports an evals regression as broken, and says nothing about a clean run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const clean = convexTest(schema, modules);
    await withTom(clean);
    await clean.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: EVALS_RUN,
        key: "tom.quest@a1b2c3d4",
        data: { repo: "tom.quest", sha: "a1b2c3d4", items: 40, pass: 40, regressions: 0, stillFailing: 0, failures: [] },
      });
    });
    const quiet = await clean.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(quiet.text).not.toContain("evals");

    const t = convexTest(schema, modules);
    await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: EVALS_RUN,
        key: "tom.quest@a1b2c3d4",
        data: {
          repo: "tom.quest",
          sha: "a1b2c3d4",
          items: 40,
          pass: 38,
          regressions: 1,
          stillFailing: 1,
          failures: [
            {
              id: "prepare-chores-k17abc",
              partition: "prepare/chores",
              reason: "still restates the statement",
              regression: true,
            },
          ],
        },
      });
    });
    const { text } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).toContain("The evals came back short at tom.quest a1b2c3d");
    expect(text).toContain("1 regression");
    expect(text).toContain("1 still failing");
    expect(text).toContain("prepare-chores-k17abc");
  });

  it("renders nothing at all when there are no delegate rows", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { text, objectionAskIds } = await t.query(internal.ttsDigest.internalComposeToday, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(text).not.toContain("The delegate decided");
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

describe("sendToday", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  type SlackReply = { ok: boolean; ts?: string; error?: string } | "throws";

  // One fetch stub for both outbound reads: GitHub (the WikiTom readability
  // check) and Slack. `github` unset means the deployment has no token that can
  // see WikiTom — today's state.
  //
  // TTS_MORNING_WRITER=off by default here: these tests are about the SEND, and
  // the Fable path is its own describe below. With the writer on, sendToday
  // opens a draft request and returns, and nothing reaches Slack until the box
  // answers or the five-minute timeout fires.
  function stubSlack(
    reply: SlackReply | SlackReply[],
    github?: { status: number; body?: unknown },
  ) {
    // One reply, or one per call in order (the last one repeats).
    const replies = Array.isArray(reply) ? [...reply] : null;
    let current: SlackReply = Array.isArray(reply) ? reply[0] : reply;
    const slack: { body: { channel: string; text: string } }[] = [];
    const githubUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (typeof url === "string" && url.startsWith("https://api.github.com/")) {
          githubUrls.push(url);
          return {
            ok: github!.status >= 200 && github!.status < 300,
            status: github!.status,
            json: async () => github!.body ?? [],
          };
        }
        slack.push({ body: JSON.parse(init?.body ?? "{}") });
        if (replies) {
          const next = replies.shift();
          if (next !== undefined) current = next;
        }
        if (current === "throws") throw new Error("network down");
        const answer = current;
        return { ok: true, status: 200, json: async () => answer };
      }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "C0TTS");
    vi.stubEnv("TTS_MORNING_WRITER", "off");
    // Stubbed either way, so a token in the developer's own environment never
    // turns a test into a real GitHub read.
    vi.stubEnv("GITHUB_MIRROR_TOKEN", github ? "ghp-test" : undefined);
    return { slack, githubUrls };
  }

  it("rolls, composes, posts to #tts-today, and records the send once per day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM + 5 * 60_000); // 05:05 EDT: inside the 5 a.m. hour
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16);
    const late = await tom.mutation(api.tts.createTodo, { statement: "pay rent", dueAt: passed });
    const { slack } = stubSlack({ ok: true, ts: "1757062800.000100" });

    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(1);
    expect(slack[0].body.channel).toBe("C0TTS");
    expect(slack[0].body.text).toContain("Pay rent");
    // The WikiTom COMMIT LIST is not a section any more: a changelog is not a
    // morning read. An unreadable WikiTom is a #tts-broken line instead, and
    // #tts-broken has no channel here, so nothing is posted for it.
    expect(slack[0].body.text).not.toContain(WIKITOM_UNREADABLE);

    // The ONE door recorded the send, with the morning message's subject, so a
    // threaded reply from Tom is routed back to it (convex/ttsSlack.ts).
    const events = await tom.query(api.tts.listRecentEvents, {});
    const sent = events.filter((e) => e.kind === SLACK_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({
      channel: "C0TTS",
      ts: "1757062800.000100",
      subject: todaySubject(ttsDayKey(Date.now())),
    });
    // The morning's own row carries the day, the window, which path wrote it,
    // and THE FACTS BLOCK — the inputs, in the transcript, next to the output.
    const marked = events.filter((e) => e.kind === DIGEST_SENT);
    expect(marked).toHaveLength(1);
    expect(marked[0].data).toMatchObject({
      day: DAY_KEY,
      truncated: false,
      writtenBy: "template",
    });
    expect((marked[0].data as { windowEnd: number }).windowEnd).toBe(Date.now());
    expect((marked[0].data as { facts: { kind: string } }).facts.kind).toBe("today");
    expect(events.some((e) => e.kind === "surfaced" && e.todoId === late)).toBe(true);

    // The same day again: the digest-sent row is the dedupe key, nothing posts.
    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(1);
  });

  // The morning of 2026-09-06: about sixty due-and-overdue items, most of them
  // code todos. Slack cut that digest into ten messages; it is one now, and the
  // row says the runs were reduced to fit.
  it("posts one message for a sixty-item morning and records the truncation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const long =
      "Rework the credential file helper so the one-time auth path writes the minted values to an owner-only file and prints only that file's path and the variable names, because an agent session stores its own standard output and a printed token is a leaked token forever afterwards.";
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("dtsTodos", {
          statement: `${i}: ${long}`,
          entryAction: `open the file and read the helper before touching it, ${i}`,
          status: "active",
          readiness: "unprepared",
          timingClass: "dated",
          source: "tom",
          dueAt: FIVE_AM - (60 - i) * DAY,
          createdAt: FIVE_AM - 90 * DAY,
          updatedAt: FIVE_AM - 90 * DAY,
        });
      }
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("dtsTodos", {
          statement: `ready ${i}: ${long}`,
          status: "active",
          readiness: "prepared",
          timingClass: "whenever",
          source: "tom",
          createdAt: FIVE_AM - 90 * DAY,
          updatedAt: FIVE_AM - 90 * DAY,
        });
      }
    });
    const { slack } = stubSlack({ ok: true, ts: "1" });

    await t.action(internal.ttsSync.sendToday, {});

    expect(slack).toHaveLength(1);
    expect(slack[0].body.text.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    // Nothing is cut mid-sentence, at any length.
    expect(slack[0].body.text).not.toContain("…");
    // The oldest date survives the cap: an item three weeks late is the one he
    // needs named in the morning.
    expect(slack[0].body.text).toContain("0: Rework the credential file helper");
    const events = await tom.query(api.tts.listRecentEvents, {});
    const marked = events.filter((e) => e.kind === DIGEST_SENT);
    expect(marked).toHaveLength(1);
    expect(marked[0].data).toMatchObject({ day: DAY_KEY });
  });

  it("stays quiet before 5 a.m., when the day key still names yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 5, 7)); // 03:00 EDT
    const t = convexTest(schema, modules);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(0);
  });

  // Both cron ticks can miss the 5 a.m. hour — a deployment, a Convex delay.
  // The day is sent late rather than skipped, and still only once.
  it("sends late when both ticks missed the hour, and only once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 5, 16)); // noon EDT, same TTS day
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" });

    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(1);

    vi.setSystemTime(Date.UTC(2026, 8, 5, 20)); // 16:00 EDT, still today
    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(1);
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.filter((e) => e.kind === SLACK_SENT)).toHaveLength(1);
  });

  // WikiTom is still read, for ONE fact: whether it can be read at all. Its
  // commits are not a section (a commit list is a changelog), and an
  // unreadable repository is a #tts-broken line.
  it("reads WikiTom over the window and prints none of its commits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack, githubUrls } = stubSlack({ ok: true, ts: "1" }, {
      status: 200,
      body: [
        {
          sha: "abc1234def",
          html_url: "https://github.com/Heffnt/WikiTom/commit/abc1234def",
          commit: { message: "areas: the health page\nsecond line", author: { name: "Tom" } },
        },
      ],
    });
    await t.action(internal.ttsSync.sendToday, {});
    expect(githubUrls).toHaveLength(1);
    expect(githubUrls[0]).toContain("/repos/Heffnt/WikiTom/commits");
    expect(githubUrls[0]).toContain(`since=${new Date(FIVE_AM - DAY).toISOString()}`);
    expect(slack[0].body.text).not.toContain("areas: the health page");
    expect(slack[0].body.text).not.toContain("abc1234");
  });

  it("says nothing about WikiTom when GitHub refuses the read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" }, { status: 403 });
    await t.action(internal.ttsSync.sendToday, {});
    // The morning message is a morning read: an unreadable repository is a
    // #tts-broken line, scheduled from the run, not a section here.
    expect(slack[0].body.text).not.toContain(WIKITOM_UNREADABLE);
    expect(slack[0].body.text).not.toContain("WikiTom");
  });

  // #tts-broken's own door, called the way the morning schedules it.
  it("posts an unreadable WikiTom to #tts-broken, once for the day", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    vi.stubEnv("SLACK_TTS_BROKEN_CHANNEL_ID", "C0BROKEN");

    const first = await t.action(internal.ttsSync.sendBroken, {
      job: "wikitom-read",
      statement: WIKITOM_UNREADABLE,
    });
    expect(first).toMatchObject({ sent: true });
    expect(slack).toHaveLength(1);
    expect(slack[0].body.channel).toBe("C0BROKEN");
    expect(slack[0].body.text).toContain(WIKITOM_UNREADABLE);

    // Deduped BY JOB for the TTS day: a poller failing every ten minutes posts
    // once, and the morning message states the count.
    const second = await t.action(internal.ttsSync.sendBroken, {
      job: "wikitom-read",
      statement: WIKITOM_UNREADABLE,
    });
    expect(second).toMatchObject({ sent: false });
    expect(slack).toHaveLength(1);
  });

  it("posts nothing to #tts-broken while its channel is unset", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    const result = await t.action(internal.ttsSync.sendBroken, {
      job: "poll-gmail",
      statement: "Nothing has been captured from email.",
    });
    expect(result).toMatchObject({ sent: false, reason: "not configured" });
    expect(slack).toHaveLength(0);
  });

  // A blip that clears in seconds must not cost Tom the morning.
  it("retries the post once in-run and records the send", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { slack } = stubSlack([
      { ok: false, error: "ratelimited" },
      { ok: true, ts: "1757062800.000100" },
    ]);
    await t.action(internal.ttsSync.sendToday, { force: true });
    expect(slack).toHaveLength(2);
    expect(slack[1].body.text).toBe(slack[0].body.text); // the same content
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.filter((e) => e.kind === SLACK_SENT)).toHaveLength(1);
    expect(events.some((e) => e.kind === SLACK_FAILED)).toBe(false);
  });

  it("records a failed send with the text, and no sent row", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { slack } = stubSlack({ ok: false, error: "channel_not_found" });
    await t.action(internal.ttsSync.sendToday, { force: true });
    expect(slack).toHaveLength(2); // the retry failed too
    const events = await tom.query(api.tts.listRecentEvents, {});
    const failed = events.filter((e) => e.kind === SLACK_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({
      channel: "C0TTS",
      subject: todaySubject(ttsDayKey(Date.now())),
      error: "channel_not_found",
      attempts: 2,
    });
    expect((failed[0].data as { text: string }).text).toContain(
      "Nothing is dated today and nothing is late.",
    );
    expect(events.some((e) => e.kind === SLACK_SENT)).toBe(false);
    expect(events.some((e) => e.kind === DIGEST_SENT)).toBe(false);
  });

  // witness: drop `windowEnd` from sendToday's postSlack call and the row
  // carries only its own `at` — the hourly tick's resend then marks the day at
  // that later instant, and everything recorded while Slack was refusing is
  // reported by no morning message.
  it("records the composition boundary on the failed row, not the clock the failure was written at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    // Every Slack call costs a minute of clock, so composing, the retry and
    // the row are three distinct instants rather than one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(Date.now() + 60_000);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false, error: "channel_not_found" }),
        };
      }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "C0TTS");
    vi.stubEnv("TTS_MORNING_WRITER", "off");
    vi.stubEnv("GITHUB_MIRROR_TOKEN", undefined);

    await t.action(internal.ttsSync.sendToday, {});

    const events = await tom.query(api.tts.listRecentEvents, {});
    const failed = events.filter(
      (e) =>
        e.kind === SLACK_FAILED &&
        (e.data as { subject?: { kind?: string } } | undefined)?.subject?.kind === "today",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].at).toBeGreaterThan(FIVE_AM); // two calls later
    expect((failed[0].data as { windowEnd: number }).windowEnd).toBe(FIVE_AM);
  });

  it("treats a network error as a failed send", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    stubSlack("throws");
    await t.action(internal.ttsSync.sendToday, { force: true });
    const events = await tom.query(api.tts.listRecentEvents, {});
    const failed = events.filter((e) => e.kind === SLACK_FAILED);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((failed[0].data as { error: string }).error).toBe("network down");
  });

  it("falls back to SLACK_TTS_CHANNEL_ID when the today channel is unset", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    await t.action(internal.ttsSync.sendToday, { force: true });
    expect(slack[0].body.channel).toBe("C0TTS");
  });

  it("prefers the today channel when it is set", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "C0TODAY");
    await t.action(internal.ttsSync.sendToday, { force: true });
    expect(slack[0].body.channel).toBe("C0TODAY");
  });
});

// ── #tts-decisions (slack-design.md §3.4) ───────────────────────────────────
// One action: revert. The default is silence, and silence is consent. This is
// the channel the round exists for — without it Tom can only object at 5 a.m.
// about a decision taken at 2 p.m., by which time the run that acted on it has
// finished.
describe("sendDecision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function stub() {
    const posts: { channel: string; text: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { channel: string; text: string };
        posts.push({ channel: body.channel, text: body.text });
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: `${posts.length}.0` }) };
      }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_TTS_DECISIONS_CHANNEL_ID", "C0DECISIONS");
    return posts;
  }

  it("asks for an objection, links the item, and invites no reply while the route is dead", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "renew the passport" });
    const posts = stub();

    expect(
      await t.action(internal.ttsSync.sendDecision, {
        askId: "ask-1",
        todoId,
        decision: "moved the passport appointment to Thursday",
        reason: "the consulate shuts on Wednesdays this month",
      }),
    ).toEqual({ sent: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("C0DECISIONS");
    expect(posts[0].text).toBe(
      [
        "Object if this is wrong; silence means it stands.",
        `- <${ttsItemLink(todoId)}|Moved the passport appointment to Thursday, because the consulate shuts on Wednesdays this month.>`,
      ].join("\n"),
    );
    // The thread carries the ask as its subject, so a bare "revert" in it
    // needs no number (convex/ttsSlack.ts routeReply, case "ask").
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    const sent = rows.filter((e) => e.kind === SLACK_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ subject: { kind: "ask", id: "ask-1" } });
  });

  it("invites the reply when the route is live", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const posts = stub();
    vi.stubEnv("SLACK_SIGNING_SECRET", "shhh");
    vi.stubEnv("TOM_SLACK_USER_ID", "U0TOM");
    await t.action(internal.ttsSync.sendDecision, {
      askId: "ask-2",
      decision: "left the MOT booked where it was",
    });
    expect(posts[0].text).toContain('reply "revert", or say what to do instead.');
  });

  it("says a refusal is parked, and that nothing was done in his name", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const posts = stub();
    await t.action(internal.ttsSync.sendDecision, {
      askId: "ask-3",
      decision: "emailed the landlord chasing the deposit",
      refused: true,
      refusedBecause: "a message to another human in your name",
      fallback: "left it for you",
    });
    expect(posts[0].text).toContain(
      "Parked for you: a message to another human in your name. Nothing was done in your name.",
    );
    expect(posts[0].text).toContain("instead the run left it for you");
  });

  // ONE APPEARANCE PER ITEM PER DAY. A decision about an item the morning has
  // already claimed for "object" is not posted twice in one day — but the
  // "act" claim is a different ask and does not suppress it, because
  // suppressing it would silence the objection.
  it("does not post twice about one item in one day, and is not blocked by the act claim", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "renew the passport" });
    const posts = stub();
    await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
      day: ttsDayKey(Date.now()),
      ask: "act",
      itemId: todoId,
      channel: "today",
    });
    const args = { askId: "ask-4", todoId, decision: "moved the appointment" };
    expect(await t.action(internal.ttsSync.sendDecision, args)).toEqual({ sent: true });
    expect(await t.action(internal.ttsSync.sendDecision, { ...args, askId: "ask-5" })).toMatchObject(
      { sent: false },
    );
    expect(posts).toHaveLength(1);
  });

  it("posts nothing while #tts-decisions has no id", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const posts = stub();
    vi.stubEnv("SLACK_TTS_DECISIONS_CHANNEL_ID", "");
    expect(
      await t.action(internal.ttsSync.sendDecision, { askId: "ask-6", decision: "did a thing" }),
    ).toMatchObject({ sent: false, reason: "not configured" });
    expect(posts).toHaveLength(0);
  });

  // The two kinds that LEFT the morning message (§4.3) come here as they are
  // written: a line the nightly job wrote about him, and a ruling an agent read
  // out of his sentence, are both decisions taken in his name.
  it("is scheduled by a model-of-Tom line the nightly job writes", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "learning-change",
      data: {
        id: "lc-1",
        file: "writing.md",
        before: "a spread may be drawn as a figure",
        after: "a spread is stated with its numbers",
        evidence: "your correction on 09-07",
      },
    });
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    expect(scheduled).toHaveLength(1);
    const args = scheduled[0].args[0] as { askId: string; decision: string; reason?: string };
    expect(args.askId).toBe("learning:lc-1");
    expect(args.decision).toContain("writing.md now says a spread is stated with its numbers");
    // The raw [change-id] prefix he was expected to type back is gone: in
    // #tts-decisions the thread is the subject.
    expect(args.decision).not.toContain("[lc-1]");
  });

  // A REPOSITORY-RULE PROPOSAL is the third kind that reaches him here. The
  // repo-learning step reads the night's sessions and writes a line it means to
  // put in a repository's own AGENTS.md; that is a decision taken in his name
  // just as a model-of-Tom line is, and "revert" in the thread drops it before
  // the line ever reaches the repository.
  it("is scheduled by a repository-rule proposal the repo-learning step writes", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "repo-proposal",
      key: "b71c",
      data: {
        id: "b71c",
        repo: "tom.quest",
        file: "worker/AGENTS.md",
        section: "box",
        line: "A worktree has no `.env.local`; copy it from the main checkout.",
        read: "lost twenty minutes to a missing .env.local in a worktree",
        evidence: "read: session 47f04bc9",
        status: "open",
      },
    });
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    expect(scheduled).toHaveLength(1);
    const args = scheduled[0].args[0] as { askId: string; decision: string; reason?: string };
    expect(args.askId).toBe("repo-proposal:b71c");
    expect(args.decision).toContain("tom.quest worker/AGENTS.md is to say");
    expect(args.decision).toContain("A worktree has no `.env.local`");
    expect(args.reason).toContain("lost twenty minutes");
    // Same reason as the line above: the thread is the subject, so no id is
    // printed for him to type back.
    expect(args.decision).not.toContain("[b71c]");
  });

  // THE WEEKLY SIMPLIFICATION PASS is the fourth producer at this door, and it
  // uses BOTH of the composer's branches. An ordinary proposal is a decision:
  // it stands unless he objects in the thread. A proposal whose removal
  // changes a line of the spec or of an intent.md he has reviewed is marked
  // needsHisWords and takes the REFUSED branch, which posts it as a question —
  // that removal is his to make, not his silence's.
  it("posts a simplification proposal as a decision, and a needs-his-words one as a question", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    const posts = stub();
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "simplify-proposal",
      key: "simplify:s1",
      data: {
        id: "s1",
        sentence: "removed the three roll-out shims from convex/http.ts",
        evidence: "nothing has posted to them in six weeks",
      },
    });
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "simplify-proposal",
      key: "simplify:s2",
      data: {
        id: "s2",
        sentence: "removed the batch members line from tts/spec.md",
        evidence: "the field came out in phase 7",
        needsHisWords: true,
      },
    });
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    expect(scheduled).toHaveLength(2);
    const args = scheduled
      .map(
        (job) =>
          job.args[0] as {
            askId: string;
            decision: string;
            reason?: string;
            refused?: boolean;
            refusedBecause?: string;
          },
      )
      .sort((a, b) => a.askId.localeCompare(b.askId));
    // The askId is the row's whole key, so the thread and the row are the same
    // string (convex/ttsAsk.ts resolves the reply with one lookup).
    expect(args.map((a) => a.askId)).toEqual(["simplify:s1", "simplify:s2"]);
    for (const arg of args) await t.action(internal.ttsSync.sendDecision, arg);
    expect(posts).toHaveLength(2);
    expect(posts[0].text).toBe(
      [
        "Object if this is wrong; silence means it stands.",
        `- <${TAB_BATCHES}|Removed the three roll-out shims from convex/http.ts, because nothing has posted to them in six weeks.>`,
      ].join("\n"),
    );
    expect(posts[1].text).toBe(
      [
        "Parked for you: needs-his-words — removed the batch members line from tts/spec.md. Nothing was done in your name.",
        `- <${TAB_BATCHES}|It would have removed the batch members line from tts/spec.md.>`,
      ].join("\n"),
    );
  });

  // A night that undid its own write is NOT a decision — nothing stands to
  // object to — and it is not a quiet night either, which is the confusion a
  // silent row would leave. It goes to #tts-broken.
  it("sends the night that took its whole write back to #tts-broken, not here", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "learning-check-failed",
      // The step's own field is `changes`, not `count`.
      data: { baseline: false, stage: "changes", changes: 3, output: "evidence: 2 lines unsupported" },
    });
    const jobs = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => ({
        name: job.name,
        args: job.args[0] as { job?: string; statement?: string },
      })),
    );
    expect(jobs.filter((j) => j.name.includes("sendDecision"))).toHaveLength(0);
    const broken = jobs.filter((j) => j.name.includes("sendBroken"));
    expect(broken).toHaveLength(1);
    expect(broken[0].args.job).toBe("learning");
    expect(broken[0].args.statement).toContain("took every one back");
    expect(broken[0].args.statement).toContain("3 lines");
  });

  // The baseline case says something different: the check was ALREADY failing
  // when the run started, so the step never wrote at all.
  it("says the check was already failing when the night wrote nothing", async () => {
    const t = convexTest(schema, modules);
    await withTom(t);
    await t.mutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: "learning-check-failed",
      data: { baseline: true, output: "evidence: 1 entry has no source" },
    });
    const broken = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendBroken"),
      ),
    );
    expect(broken).toHaveLength(1);
    expect((broken[0].args[0] as { statement: string }).statement).toContain(
      "already failing its own check",
    );
  });

  it("is scheduled by a ruling read out of Tom's own words, and not by a button ruling", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "read the BDDR paper" });
    const scheduledFor = async () =>
      await t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
          job.name.includes("sendDecision"),
        ),
      );

    // A button ruling is Tom's own act: nothing is taken in his name.
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "narrow it to the corpus confound",
    });
    expect(await scheduledFor()).toHaveLength(0);

    // A ruling read out of a sentence he typed IS a decision taken for him.
    // The words door only accepts a turn Tom actually authored, so the row is
    // built the way the browser door and the Slack events route build it.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("claudeSessions", {
        title: "a session about the paper",
        kind: "focus-item",
        repo: "tom.quest",
        // The words door refuses a turn from a session about nothing: a ruling
        // names only what Tom was actually talking about.
        todoId,
        status: "running",
        nextSeq: 0,
        createdAt: Date.now(),
        statusChangedAt: Date.now(),
      }),
    );
    const inboundId = await t.run(async (ctx) =>
      ctx.db.insert("claudeInbound", {
        sessionId,
        kind: "user-turn",
        author: "tom",
        text: "the twin has to be matched, not resampled",
        status: "delivered",
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.ttsRulings.internalRecordRulingFromTomWords, {
      inboundId,
      verdict: "revise",
      subjectType: "life",
      subjectId: todoId,
      quote: "the twin has to be matched, not resampled",
      sentence: "the twin has to be matched, not resampled",
    });
    const scheduled = await scheduledFor();
    expect(scheduled).toHaveLength(1);
    const args = scheduled[0].args[0] as { decision: string; reason?: string; todoId?: string };
    expect(args.todoId).toBe(todoId);
    expect(args.decision).toBe("read the BDDR paper was ruled a revise from your own words");
    expect(args.reason).toBe("the twin has to be matched, not resampled");
  });
});

