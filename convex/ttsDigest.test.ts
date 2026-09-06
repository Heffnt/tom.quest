import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  DIGEST_SENT,
  LEARNING_CHANGE,
  ROLLOVER_NOTE,
  SLACK_FAILED,
  SLACK_SENT,
  WIKITOM_UNREADABLE,
  composeDigest,
  digestSubject,
  isPassedWithoutOutcome,
  provenanceText,
  type DigestFacts,
} from "./ttsDigest";
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

const emptyFacts = (): DigestFacts => ({
  day: DAY_KEY,
  now: FIVE_AM,
  since: FIVE_AM - DAY,
  due: [],
  blocks: [],
  calendar: [],
  emailCaptures: [],
  overnight: [],
  ready: [],
  failures: [],
  wikitom: [],
  rulings: [],
  learning: [],
});

describe("composeDigest", () => {
  it("always carries the first section and omits every empty one", () => {
    const text = composeDigest(emptyFacts());
    expect(text).toBe(
      ["*TTS digest — 2026-09-05*", "", "*Due and overdue*", "- nothing"].join("\n"),
    );
  });

  it("lists every WikiTom commit with its author", () => {
    const text = composeDigest({
      ...emptyFacts(),
      wikitom: [
        {
          sha: "abc1234def5678",
          message: "areas: the health page's must-not-break lines",
          author: "Tom",
          url: "https://github.com/Heffnt/WikiTom/commit/abc1234def5678",
        },
      ],
    });
    expect(text).toContain("*WikiTom commits*");
    expect(text).toContain(
      "- <https://github.com/Heffnt/WikiTom/commit/abc1234def5678|abc1234> areas: the health page's must-not-break lines — Tom",
    );
  });

  // An unreadable repo is not the same fact as a quiet one, so the section
  // stays and says which it is.
  it("says so when WikiTom cannot be read, and omits the section when it is quiet", () => {
    expect(composeDigest({ ...emptyFacts(), wikitom: null })).toContain(
      WIKITOM_UNREADABLE,
    );
    expect(composeDigest(emptyFacts())).not.toContain("WikiTom");
  });

  it("orders the sections and links every item", () => {
    const yesterdayNoon = Date.UTC(2026, 8, 4, 16);
    const todayNoon = Date.UTC(2026, 8, 5, 16);
    const text = composeDigest({
      ...emptyFacts(),
      due: [
        { id: "t2", statement: "call the bank", dueAt: todayNoon, entryAction: "dial 555" , missed: false },
        { id: "t1", statement: "pay rent", dueAt: yesterdayNoon, missed: true },
      ],
      blocks: [{ start: Date.UTC(2026, 8, 5, 13), end: Date.UTC(2026, 8, 5, 15), label: "chores" }],
      calendar: [
        { start: Date.UTC(2026, 8, 5, 23), end: Date.UTC(2026, 8, 6, 0, 30), title: "practice", allDay: false },
        { start: Date.UTC(2026, 8, 5, 4), end: Date.UTC(2026, 8, 6, 4), title: "holiday", allDay: true },
      ],
      emailCaptures: [{ id: "t3", statement: "reply to Ana", entryAction: "open the thread" }],
      overnight: [
        { batch: null, text: "calendar event written: dentist" },
        { batch: "the lease", text: "session opened: lease session" },
        { batch: "the lease", text: "session completed: lease session — drafted the reply" },
      ],
      ready: [{ id: "t4", statement: "sign the form", entryAction: "sign page 2" }],
      failures: [{ at: Date.UTC(2026, 8, 5, 7), text: "poll-gmail-failed: token expired" }],
      rulings: [
        { verdict: "archive", subject: "old thing", sentence: "drop it", provenance: "slack 1757000000.000100" },
      ],
      learning: [
        { id: "lc-1", file: "schedule.md", before: "up at 7", after: "up at 6", evidence: "three sessions before 7" },
      ],
    });
    const lines = text.split("\n");
    const headers = lines.filter((l) => l.startsWith("*"));
    expect(headers).toEqual([
      "*TTS digest — 2026-09-05*",
      "*Due and overdue*",
      "*Blocks and calendar*",
      "*Captured from email*",
      "*Overnight, by batch*",
      "*Ready for you*",
      "*Job failures*",
      "*Rulings from your words*",
      "*Model of Tom*",
    ]);
    // Due sorted by date; the missed one carries the reply path, the other
    // its entry action.
    const dueStart = lines.indexOf("*Due and overdue*");
    expect(lines[dueStart + 1]).toBe(
      `- <${ttsItemLink("t1")}|pay rent> — 1 day overdue — missed: reply done, or a new date`,
    );
    expect(lines[dueStart + 2]).toBe(
      `- <${ttsItemLink("t2")}|call the bank> — dial 555 — today`,
    );
    // Spans in New York time, all-day first because it starts at midnight.
    expect(lines).toContain("- all day holiday");
    expect(lines).toContain("- 09:00–11:00 chores");
    expect(lines).toContain("- 19:00–20:30 practice");
    expect(lines).toContain(`- <${ttsItemLink("t3")}|reply to Ana> — open the thread`);
    // Named batches first, then the batch-less tail.
    const overnightStart = lines.indexOf("*Overnight, by batch*");
    expect(lines.slice(overnightStart + 1, overnightStart + 6)).toEqual([
      "_the lease_",
      "- session opened: lease session",
      "- session completed: lease session — drafted the reply",
      "_no batch_",
      "- calendar event written: dentist",
    ]);
    expect(lines).toContain(`- <${ttsItemLink("t4")}|sign the form> — sign page 2`);
    expect(lines).toContain("- 03:00 poll-gmail-failed: token expired");
    expect(lines).toContain('- archive on old thing: "drop it" (slack 1757000000.000100)');
    expect(lines).toContain(
      '- [lc-1] schedule.md: "up at 7" → "up at 6" (three sessions before 7)',
    );
  });

  it("escapes Slack's reserved characters in statements", () => {
    const text = composeDigest({
      ...emptyFacts(),
      ready: [{ id: "t1", statement: "a <b> & c" }],
    });
    expect(text).toContain("|a &lt;b&gt; &amp; c>");
  });
});

// Ruling 15: the digest reports EVERY ruling written from Tom's words, so a
// misreading gets objected to. The reader judges only that a provenance is
// there, never how it is worded.
describe("provenanceText", () => {
  it("takes both shapes the ruling route writes", () => {
    expect(provenanceText("slack 1757000000.000100")).toBe("slack 1757000000.000100");
    expect(provenanceText({ from: "tom-words", channel: "C0TTS", ts: "1757.1" })).toBe(
      "from tom-words, channel C0TTS, ts 1757.1",
    );
    // A wording that names neither a session nor Slack is still a ruling from
    // his words — the old regex dropped exactly these.
    expect(provenanceText({ from: "tom-words" })).toBe("from tom-words");
    expect(provenanceText("dictated on the phone")).toBe("dictated on the phone");
  });

  it("reads a missing or empty provenance as a button ruling", () => {
    expect(provenanceText(undefined)).toBeNull();
    expect(provenanceText("   ")).toBeNull();
    expect(provenanceText({})).toBeNull();
    expect(provenanceText({ nested: { from: "tom-words" } })).toBeNull();
    expect(provenanceText(7)).toBeNull();
  });
});

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
    expect(
      events.filter((e) => e.kind === "date-outcome" && e.todoId === late),
    ).toHaveLength(1);
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
    const { text } = await t.query(internal.ttsDigest.internalComposeDigest, {
      day: "2026-09-04",
      now: Date.UTC(2026, 8, 4, 9),
    });
    expect(text).toContain("|midnight deadline>");
    // The next morning's rollover marks it once.
    expect(
      await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY }),
    ).toEqual([todo]);
  });
});

describe("internalComposeDigest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the rollover's mark and everything since the last digest", async () => {
    // Pinned: "1 day overdue" is a fact about the gap between the due date and
    // the reading clock, so a wall-clock run stops matching the day after it
    // was written.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16);
    const late = await tom.mutation(api.tts.createTodo, { statement: "pay rent", dueAt: passed });
    await t.mutation(internal.ttsDigest.internalRollMissed, { day: DAY_KEY });
    const ready = await tom.mutation(api.tts.createTodo, {
      statement: "sign the form",
      entryAction: "sign page 2",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(ready, { readiness: "ready-for-tom" });
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: LEARNING_CHANGE,
        data: { id: "lc-1", file: "schedule.md", before: "a", after: "b", evidence: "e" },
      });
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: "poll-gmail-failed",
        data: { error: "token expired" },
      });
    });
    const { text, surfacedTodoIds } = await t.query(
      internal.ttsDigest.internalComposeDigest,
      { day: DAY_KEY, now: Date.now() + 1 },
    );
    expect(text).toContain(
      `- <${ttsItemLink(late)}|pay rent> — 1 day overdue — missed: reply done, or a new date`,
    );
    expect(text).toContain(`- <${ttsItemLink(ready)}|sign the form> — sign page 2`);
    expect(text).toContain('- [lc-1] schedule.md: "a" → "b" (e)');
    expect(text).toContain("poll-gmail-failed: token expired");
    expect(surfacedTodoIds).toEqual([late, ready]);
  });

  it("lists a dated email capture once, under due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const dated = await tom.mutation(api.tts.createTodo, {
      statement: "reply to Ana",
      dueAt: Date.UTC(2026, 8, 5, 16),
    });
    const undated = await tom.mutation(api.tts.createTodo, {
      statement: "read the newsletter",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(dated, { source: "email" });
      await ctx.db.patch(undated, { source: "email" });
    });
    const { text, surfacedTodoIds } = await t.query(
      internal.ttsDigest.internalComposeDigest,
      { day: DAY_KEY, now: FIVE_AM + 1 },
    );
    expect(text.split("reply to Ana")).toHaveLength(2); // one line only
    expect(text.indexOf("reply to Ana")).toBeLessThan(
      text.indexOf("*Captured from email*"),
    );
    expect(text).toContain("|read the newsletter>");
    expect(surfacedTodoIds).toEqual([dated, undated]);
  });

  // The window starts where the last one ENDED. Composing and posting take
  // seconds; anything recorded in them would be reported by neither digest if
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
        data: { error: "token expired" },
      });
    });
    const { since, text } = await t.query(internal.ttsDigest.internalComposeDigest, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(windowEnd);
    expect(text).toContain("poll-gmail-failed: token expired");
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
    const { since } = await t.query(internal.ttsDigest.internalComposeDigest, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(FIVE_AM - DAY);
  });

  // A day the digest never went out widens the next one's window instead of
  // losing the day: the window is [last send, now], not a fixed 24 hours.
  it("widens the window over a skipped day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const twoDaysBack = FIVE_AM - 2 * DAY;
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: twoDaysBack,
        kind: DIGEST_SENT,
        data: { day: "2026-09-03", windowEnd: twoDaysBack },
      });
    });
    // A capture from the skipped day, older than 24 hours.
    const skipped = await tom.mutation(api.tts.createTodo, {
      statement: "reply to Ana",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(skipped, { source: "email", createdAt: FIVE_AM - 1.5 * DAY });
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 1.5 * DAY,
        kind: "poll-canvas-failed",
        data: { error: "canvas token expired" },
      });
    });
    const { since, text } = await t.query(internal.ttsDigest.internalComposeDigest, {
      day: DAY_KEY,
      now: FIVE_AM,
    });
    expect(since).toBe(twoDaysBack);
    expect(text).toContain("|reply to Ana>");
    expect(text).toContain("poll-canvas-failed: canvas token expired");
  });
});

describe("sendDigest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  type SlackReply = { ok: boolean; ts?: string; error?: string } | "throws";

  // One fetch stub for both outbound reads: GitHub (the WikiTom commit list)
  // and Slack. `github` unset means the deployment has no token that can see
  // WikiTom — today's state.
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
    // Stubbed either way, so a token in the developer's own environment never
    // turns a test into a real GitHub read.
    vi.stubEnv("GITHUB_MIRROR_TOKEN", github ? "ghp-test" : undefined);
    return { slack, githubUrls };
  }

  it("rolls, composes, posts to #tts, and records the send once per day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM + 5 * 60_000); // 05:05 EDT: inside the 5 a.m. hour
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const passed = Date.UTC(2026, 8, 4, 16);
    const late = await tom.mutation(api.tts.createTodo, { statement: "pay rent", dueAt: passed });
    const { slack } = stubSlack({ ok: true, ts: "1757062800.000100" });

    await t.action(internal.ttsSync.sendDigest, {});
    expect(slack).toHaveLength(1);
    expect(slack[0].body.channel).toBe("C0TTS");
    expect(slack[0].body.text).toContain("missed: reply done, or a new date");
    // No credential that can read WikiTom: the gap is named, not hidden.
    expect(slack[0].body.text).toContain(WIKITOM_UNREADABLE);

    // The ONE door recorded the send, with the digest's subject, so a threaded
    // reply from Tom is routed back to it (convex/ttsSlack.ts).
    const events = await tom.query(api.tts.listRecentEvents, {});
    const sent = events.filter((e) => e.kind === SLACK_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({
      channel: "C0TTS",
      ts: "1757062800.000100",
      subject: digestSubject(ttsDayKey(Date.now())),
    });
    // The digest's own row carries the day and where the window ended.
    const marked = events.filter((e) => e.kind === DIGEST_SENT);
    expect(marked).toHaveLength(1);
    expect(marked[0].data).toMatchObject({ day: DAY_KEY });
    expect((marked[0].data as { windowEnd: number }).windowEnd).toBe(Date.now());
    expect(events.some((e) => e.kind === "surfaced" && e.todoId === late)).toBe(true);

    // The same day again: the digest-sent row is the dedupe key, nothing posts.
    await t.action(internal.ttsSync.sendDigest, {});
    expect(slack).toHaveLength(1);
  });

  it("stays quiet before 5 a.m., when the day key still names yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 5, 7)); // 03:00 EDT
    const t = convexTest(schema, modules);
    const { slack } = stubSlack({ ok: true, ts: "1" });
    await t.action(internal.ttsSync.sendDigest, {});
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

    await t.action(internal.ttsSync.sendDigest, {});
    expect(slack).toHaveLength(1);

    vi.setSystemTime(Date.UTC(2026, 8, 5, 20)); // 16:00 EDT, still today
    await t.action(internal.ttsSync.sendDigest, {});
    expect(slack).toHaveLength(1);
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.filter((e) => e.kind === SLACK_SENT)).toHaveLength(1);
  });

  it("reads WikiTom's commits over the digest's window", async () => {
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
    await t.action(internal.ttsSync.sendDigest, {});
    expect(githubUrls).toHaveLength(1);
    expect(githubUrls[0]).toContain("/repos/Heffnt/WikiTom/commits");
    expect(githubUrls[0]).toContain(`since=${new Date(FIVE_AM - DAY).toISOString()}`);
    expect(slack[0].body.text).toContain(
      "- <https://github.com/Heffnt/WikiTom/commit/abc1234def|abc1234> areas: the health page — Tom",
    );
  });

  it("names the gap when GitHub refuses the WikiTom read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await withTom(t);
    const { slack } = stubSlack({ ok: true, ts: "1" }, { status: 403 });
    await t.action(internal.ttsSync.sendDigest, {});
    expect(slack[0].body.text).toContain(WIKITOM_UNREADABLE);
  });

  // The named retry owner (the hourly update) is switched off, so a blip that
  // clears in seconds must not cost Tom the morning.
  it("retries the post once in-run and records the send", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { slack } = stubSlack([
      { ok: false, error: "ratelimited" },
      { ok: true, ts: "1757062800.000100" },
    ]);
    await t.action(internal.ttsSync.sendDigest, { force: true });
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
    await t.action(internal.ttsSync.sendDigest, { force: true });
    expect(slack).toHaveLength(2); // the retry failed too
    const events = await tom.query(api.tts.listRecentEvents, {});
    const failed = events.filter((e) => e.kind === SLACK_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({
      channel: "C0TTS",
      subject: digestSubject(ttsDayKey(Date.now())),
      error: "channel_not_found",
      attempts: 2,
    });
    expect((failed[0].data as { text: string }).text).toContain("*Due and overdue*");
    expect(events.some((e) => e.kind === SLACK_SENT)).toBe(false);
    expect(events.some((e) => e.kind === DIGEST_SENT)).toBe(false);
  });

  it("treats a network error as a failed send", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    stubSlack("throws");
    await t.action(internal.ttsSync.sendDigest, { force: true });
    const events = await tom.query(api.tts.listRecentEvents, {});
    const failed = events.filter((e) => e.kind === SLACK_FAILED);
    expect(failed).toHaveLength(1);
    expect((failed[0].data as { error: string }).error).toBe("network down");
  });
});
