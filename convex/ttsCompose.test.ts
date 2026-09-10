import { describe, expect, it } from "vitest";
import {
  FIRST_LINE_CHARS,
  LINE_CHARS,
  MESSAGE_MAX_CHARS,
  SECTION_ORDER,
  TAB_BATCHES,
  TAB_CALENDAR,
  TAB_EVERYTHING,
  checkMessage,
  claimKey,
  composeBroken,
  composeCaptured,
  composeContinued,
  composeDecision,
  composeHourly,
  composeNeedsYou,
  composeToday,
  composeTodayFitted,
  dropFaultyLines,
  itemUrl,
  objectionLine,
  overnightLine,
  renderSlack,
  sessionUrl,
  statement,
  verifyDraft,
  todayFactsBlock,
  type Draft,
  type HourlyFacts,
  type Line,
  type Message,
  type TodayFacts,
} from "./ttsCompose";
import { ttsItemLink, ttsSessionLink, ttsTabLink } from "./ttsShared";

// The composer is PURE and imports nothing (its header says why), so every
// test here calls it with literals — no Convex harness, no clock, no network.

// ── The one copy of each link ────────────────────────────────────────────────
// ttsCompose may not import ttsShared, so the two hold the same literals. This
// is the guard that keeps them equal, which is what the one-copy rule is
// actually for.
describe("the links the composer spells for itself", () => {
  it("are byte-identical to convex/ttsShared.ts's", () => {
    expect(itemUrl("ph7fqh2j")).toBe(ttsItemLink("ph7fqh2j"));
    expect(sessionUrl("k97a")).toBe(ttsSessionLink("k97a"));
    expect(TAB_EVERYTHING).toBe(ttsTabLink("everything"));
    expect(TAB_BATCHES).toBe(ttsTabLink("batches"));
    expect(TAB_CALENDAR).toBe(ttsTabLink("calendar"));
  });
});

describe("statement", () => {
  it("ends every output in a full stop and never emits an ellipsis", () => {
    expect(statement("a whole thought")).toBe("a whole thought.");
    expect(statement("already ended.")).toBe("already ended.");
    expect(statement("a question?")).toBe("a question?");
    expect(statement("  collapses   its   spaces  ")).toBe("collapses its spaces.");
    expect(statement("something…")).not.toContain("…");
  });

  it("cuts at the last clause boundary before the cap", () => {
    const long =
      "Evaluate the interest-gradient sequencing experiment against your never-switches worry, " +
      "which is a two-week claim you made about yourself and have not tested since, and then say so.";
    const cut = statement(long);
    expect(cut.length).toBeLessThanOrEqual(LINE_CHARS);
    expect(cut.endsWith(".")).toBe(true);
    expect(cut).not.toContain("…");
    // The cut landed on a comma, so the sentence ends on a clause.
    expect(cut).toBe(
      "Evaluate the interest-gradient sequencing experiment against your never-switches worry.",
    );
  });

  it("cuts at a word boundary when there is no clause boundary at all", () => {
    const long = `${"word ".repeat(60)}end`;
    const cut = statement(long);
    expect(cut.length).toBeLessThanOrEqual(LINE_CHARS);
    expect(cut.endsWith(".")).toBe(true);
    expect(cut).not.toMatch(/wor\.$/); // never mid-word
  });

  // The real 2026-09-09 line, which the old 110-character cut printed as
  // "…your own two-week…" — mid-sentence, twice, three mornings running.
  it("gives the 09-09 interest-gradient statement a whole sentence", () => {
    const real =
      "Evaluate the interest-gradient sequencing experiment against your 'never switches' worry — " +
      "your own two-week claim that you never switch tasks, tested against the harvest log";
    const line = statement(real);
    expect(line.length).toBeLessThanOrEqual(LINE_CHARS);
    expect(line).not.toContain("…");
    expect(line.endsWith(".")).toBe(true);
    expect(line).toContain("interest-gradient sequencing experiment");
  });
});

// ── The form, fault by fault ────────────────────────────────────────────────
const OK: Message = {
  firstLine: "Two things carry a date you have passed.",
  lines: [
    { role: "lead", text: "Dated, oldest first — each line names the first move." },
    { role: "item", text: "Run the Friday triage session. Ten days late.", url: itemUrl("ph7f") },
  ],
};

describe("checkMessage", () => {
  it("passes a message that obeys the form", () => {
    expect(checkMessage(OK, { canReply: false })).toEqual([]);
  });

  it("catches an item line with no http(s) link", () => {
    const faults = checkMessage(
      { ...OK, lines: [OK.lines[0], { role: "item", text: "A statement.", url: "tom.quest" }] },
      { canReply: false },
    );
    expect(faults.join(" ")).toContain("no http(s) link");
  });

  it("catches a line over the cap, and a first line over its own", () => {
    const long = `${"x".repeat(LINE_CHARS + 5)}.`;
    expect(
      checkMessage({ ...OK, lines: [{ role: "item", text: long, url: itemUrl("a") }] }, { canReply: false }).join(" "),
    ).toContain(`over ${LINE_CHARS}`);
    expect(
      checkMessage({ ...OK, firstLine: `${"y".repeat(FIRST_LINE_CHARS + 5)}.` }, { canReply: false }).join(" "),
    ).toContain(`over ${FIRST_LINE_CHARS}`);
  });

  it("catches a line that is not a complete statement", () => {
    expect(
      checkMessage(
        { ...OK, lines: [OK.lines[0], { role: "item", text: "no full stop", url: itemUrl("a") }] },
        { canReply: false },
      ).join(" "),
    ).toContain("not a complete statement");
  });

  it("catches a line that begins with a bare id", () => {
    expect(
      checkMessage(
        {
          ...OK,
          lines: [
            OK.lines[0],
            { role: "item", text: "ph7fqh2jzbnv4dsp5xwkdhkf2d8dcrst is late.", url: itemUrl("a") },
          ],
        },
        { canReply: false },
      ).join(" "),
    ).toContain("bare id");
  });

  it("catches a bare \"+N more\", with or without a link", () => {
    expect(
      checkMessage(
        { ...OK, lines: [OK.lines[0], { role: "item", text: "+667 more", url: TAB_EVERYTHING }] },
        { canReply: false },
      ).join(" "),
    ).toContain('bare "+N more"');
    expect(
      checkMessage({ ...OK, lines: [{ role: "lead", text: "+667 more on the page." }] }, { canReply: false }).join(" "),
    ).toContain('"+N more" with no link');
  });

  it("catches a lead line with no item line under it", () => {
    expect(
      checkMessage({ ...OK, lines: [{ role: "lead", text: "A heading with nothing beneath it." }] }, { canReply: false }).join(" "),
    ).toContain("no item line under it");
  });

  it("catches a note line when the reply route is not live, and passes it when it is", () => {
    const withNote: Message = {
      ...OK,
      lines: [...OK.lines, { role: "note", text: 'reply "done" on a line.' }],
    };
    expect(checkMessage(withNote, { canReply: false }).join(" ")).toContain(
      "invites a reply the route cannot receive",
    );
    expect(checkMessage(withNote, { canReply: true })).toEqual([]);
  });

  it("catches a second note line, and a note line that is not last in its section", () => {
    const two: Message = {
      ...OK,
      lines: [...OK.lines, { role: "note", text: "reply once." }, { role: "note", text: "reply twice." }],
    };
    expect(checkMessage(two, { canReply: true }).join(" ")).toContain("2 note lines");
    const misplaced: Message = {
      ...OK,
      lines: [
        OK.lines[0],
        { role: "note", text: "reply here." },
        { role: "item", text: "A statement.", url: itemUrl("a") },
      ],
    };
    expect(checkMessage(misplaced, { canReply: true }).join(" ")).toContain("not last in it");
  });

  it("catches a rendered message over Slack's limit", () => {
    const many: Line[] = [{ role: "lead", text: "A lead." }];
    for (let i = 0; i < 60; i += 1) {
      many.push({ role: "item", text: `${"x".repeat(120)}.`, url: itemUrl(`a${i}`) });
    }
    expect(checkMessage({ firstLine: "First.", lines: many }, { canReply: false }).join(" ")).toContain(
      `over ${MESSAGE_MAX_CHARS}`,
    );
  });
});

describe("a fault costs the line, never the message", () => {
  it("drops the offending line and keeps the rest", () => {
    const { message, faults } = dropFaultyLines(
      {
        firstLine: "First.",
        lines: [
          { role: "lead", text: "A lead." },
          { role: "item", text: "A good statement.", url: itemUrl("a") },
          { role: "item", text: "no stop and no link", url: "not-a-url" },
        ],
      },
      { canReply: false },
    );
    expect(faults.length).toBeGreaterThan(0);
    expect(message.lines).toHaveLength(2);
    expect(renderSlack(message)).toContain("A good statement.");
  });

  it("drops a lead whose items all went with it", () => {
    const { message } = dropFaultyLines(
      {
        firstLine: "First.",
        lines: [
          { role: "lead", text: "A lead." },
          { role: "item", text: "broken", url: "nope" },
        ],
      },
      { canReply: false },
    );
    expect(message.lines).toEqual([]);
  });
});

// ── The renderer, byte for byte ─────────────────────────────────────────────
describe("renderSlack", () => {
  it("reproduces the needs-you thread of slack-design.md §3.2 exactly", () => {
    const message = composeNeedsYou(
      {
        todoId: "ph7by1ap",
        statement: "Check whether the usage-policy notice is genuine, then answer it or delete it",
        entryAction: "Open the email and click Show original",
        reason:
          "a mail says your OpenAI account is about to be deactivated, and whether it really came from OpenAI decides what you do",
        sourceUrl: "https://mail.google.com/mail/u/0/#all/1994c1",
      },
      { canReply: true },
    );
    expect(renderSlack(message)).toBe(
      [
        "Only you can settle this: a mail says your OpenAI account is about to be deactivated, and whether it really came from OpenAI decides what you do. Open the email and click Show original.",
        "- <https://tom.quest/tts?item=ph7by1ap|Check whether the usage-policy notice is genuine, then answer it or delete it.>",
        "- <https://mail.google.com/mail/u/0/#all/1994c1|Open the message it came from.>",
        'reply here with what you decided, or "done".',
      ].join("\n"),
    );
  });

  it("puts a blank line before every lead and none before an item or a note", () => {
    expect(renderSlack(OK)).toBe(
      [
        "Two things carry a date you have passed.",
        "",
        "Dated, oldest first — each line names the first move.",
        "- <https://tom.quest/tts?item=ph7f|Run the Friday triage session. Ten days late.>",
      ].join("\n"),
    );
  });

  it("prints no title line and no bold header", () => {
    expect(renderSlack(OK)).not.toContain("*");
  });
});

// ── The morning message ─────────────────────────────────────────────────────
// The 2026-09-09 record, as slack-today.md §2 holds it.
function sept9(overrides: Partial<TodayFacts> = {}): TodayFacts {
  return {
    day: "2026-09-09",
    today: [
      {
        id: "ph7fqh2j",
        statement: "Run the first Friday triage session",
        entryAction: "open friday-2026-08-28.md and read the agenda",
        countdown: "Ten days late.",
      },
      {
        id: "ph74xqqp",
        statement: 'Test interest-gradient sequencing against your "never switches" worry',
        entryAction: "reread §5.3 of harvest-2026-08-28.md",
        countdown: "Eight days late.",
      },
      {
        id: "ph7acr30",
        statement: "Confirm the time of the TRACE Lab meeting you are presenting at",
        entryAction: "open the linked email thread",
        countdown: "Five days late.",
      },
    ],
    lateCount: 3,
    oldestLateBy: "ten days",
    readyBeyond: 667,
    calendar: [
      { title: "Quiz 3 for CS542", when: "", allDay: true },
      { title: "PT", when: "16:00 to 17:00", allDay: false },
      { title: "D&D", when: "19:30 to 23:00", allDay: false },
    ],
    calendarLead: "Your day is committed from 16:00 to 23:00.",
    objections: [],
    overnight: [
      {
        batchId: "b1",
        statement: "The research critical path",
        added: 4,
        reworked: 0,
        dropped: 1,
        finished: 0,
        running: false,
      },
      {
        batchId: "b2",
        statement: "The Veritasium BackerKit reward survey",
        added: 0,
        reworked: 0,
        dropped: 0,
        finished: 0,
        running: false,
      },
    ],
    batchesPlanned: 9,
    batchesFinished: 0,
    broken: [],
    ...overrides,
  };
}

describe("composeToday", () => {
  it("names the count, the age of the worst, and the one to start with", () => {
    const first = composeToday(sept9(), { canReply: false }).firstLine;
    expect(first).toBe(
      "Three things carry a date you have passed, the oldest by ten days; run the first Friday triage session is the one to start with. Nothing else needs an answer from you today.",
    );
    expect(first).not.toContain("TTS digest");
    expect(first.length).toBeLessThanOrEqual(FIRST_LINE_CHARS);
  });

  it("prints one whole sentence per line, each carrying a link, and no bare +N more", () => {
    const text = renderSlack(composeToday(sept9(), { canReply: false }));
    expect(text).toContain(
      "- <https://tom.quest/tts?item=ph7fqh2j|Run the first Friday triage session: open friday-2026-08-28.md and read the agenda. Ten days late.>",
    );
    expect(text).toContain("667 other items are ready, and not one of them is dated.");
    expect(text).not.toMatch(/\+\d+ more/);
    expect(text).not.toContain("…");
    expect(text).not.toContain("missed: reply done");
  });

  it("says nothing about a logged event — outcomes only", () => {
    const text = renderSlack(composeToday(sept9(), { canReply: false }));
    for (const word of ["plan stored", "session opened", "worker event", "created", "retired", "TTS digest"]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(text).toContain("The research critical path gained 4 items and dropped 1.");
    expect(text).toContain("The Veritasium BackerKit reward survey was planned and gained nothing.");
  });

  it("prints the runs in the ruled order and omits the empty ones", () => {
    const leads = composeToday(sept9(), { canReply: false })
      .lines.filter((line) => line.role === "lead")
      .map((line) => line.section);
    expect(leads).toEqual(["today", "calendar", "overnight"]);
    const withAll = composeToday(
      sept9({
        objections: [
          { askId: "a1", todoId: "ph79", decision: "moved the passport appointment to Thursday", reason: "the consulate shuts on Wednesdays this month" },
        ],
        broken: [
          {
            statement: "Nothing has been captured from email since 02:10.",
            detail: "The Gmail poller has failed against Google's token endpoint",
            url: sessionUrl("k97a"),
            count: 11,
          },
        ],
      }),
      { canReply: false },
    );
    const order = withAll.lines.filter((l) => l.role === "lead").map((l) => l.section);
    expect(order).toEqual(["today", "objections", "calendar", "overnight", "broken"]);
    // The four ranked sections keep the design's order among themselves.
    expect(order.filter((s) => (SECTION_ORDER as readonly string[]).includes(s as string))).toEqual([
      ...SECTION_ORDER,
    ]);
  });

  it("prints the nothing-to-do form and still sends", () => {
    const message = composeToday(
      sept9({ today: [], lateCount: 0, oldestLateBy: undefined, readyBeyond: 0 }),
      { canReply: false },
    );
    expect(message.firstLine).toBe(
      "Nothing is dated today and nothing is late. The calendar is your whole day.",
    );
    expect(message.lines.some((line) => line.role === "item")).toBe(true);
  });

  it("emits the reply invitation only when the route is live", () => {
    expect(renderSlack(composeToday(sept9(), { canReply: false }))).not.toContain("reply");
    const live = renderSlack(composeToday(sept9(), { canReply: true }));
    expect(live).toContain('reply "done" on a line, or give it a new date.');
    expect(checkMessage(composeToday(sept9(), { canReply: true }), { canReply: true })).toEqual([]);
  });

  it("numbers the objection list from one, in printed order", () => {
    const message = composeToday(
      sept9({
        objections: [
          { askId: "a1", todoId: "ph79", decision: "moved the passport appointment to Thursday", reason: "the consulate shuts on Wednesdays this month" },
          {
            askId: "a2",
            todoId: "ph80",
            decision: "emailed the landlord chasing the deposit",
            refused: true,
            refusedBecause: "which is a message to another human in your name",
          },
        ],
      }),
      { canReply: true },
    );
    const text = renderSlack(message);
    expect(text).toContain(
      "1. Moved the passport appointment to Thursday, because the consulate shuts on Wednesdays this month.",
    );
    expect(text).toContain("2. REFUSED and parked: it would have emailed the landlord");
    expect(text).toContain('reply "revert 2", or "2: what to do instead".');
    expect(message.firstLine).toContain("Two decisions were taken for you overnight.");
  });

  it("fits one Slack message and reduces the sections furthest from him first", () => {
    const filler = "a whole sentence about something that takes up most of one line on a phone";
    const many = sept9({
      today: Array.from({ length: 200 }, (_, i) => ({
        id: `ph${i}`,
        statement: `A dated thing number ${i}, ${filler}`,
        entryAction: `open the page and start on it, ${filler}`,
        countdown: "Ten days late.",
      })),
      lateCount: 200,
      calendar: Array.from({ length: 20 }, (_, i) => ({
        title: `A commitment number ${i}, ${filler}`,
        when: "16:00 to 17:00",
        allDay: false,
      })),
      overnight: Array.from({ length: 40 }, (_, i) => ({
        batchId: `b${i}`,
        statement: `Batch number ${i}`,
        added: 2,
        reworked: 1,
        dropped: 0,
        finished: 0,
        running: false,
      })),
      broken: Array.from({ length: 6 }, (_, i) => ({
        statement: `A job stopped ${i}.`,
        detail: `Job ${i} failed`,
        url: sessionUrl(`k${i}`),
      })),
    });
    const { message, truncated } = composeTodayFitted(many, { canReply: false });
    const text = renderSlack(message);
    expect(text.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(truncated).toBe(true);
    // The today run is never reduced: its full cap of items survives.
    const todayItems = message.lines.filter((l) => l.section === "today" && l.role === "item");
    expect(todayItems.length).toBeGreaterThanOrEqual(12);
    // Nothing was cut in half.
    expect(text).not.toContain("…");
    for (const line of text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line.endsWith(">")).toBe(true);
    }
  });

  it("never lets one item appear in two runs of one message", () => {
    const facts = sept9();
    facts.today.push({ ...facts.today[0] });
    const ids = composeToday(facts, { canReply: false })
      .lines.filter((l) => l.role === "item" && l.url.includes("item="))
      .map((l) => (l as { url: string }).url);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("overnightLine", () => {
  it("turns a night of counts on one batch into one sentence", () => {
    expect(
      overnightLine({
        batchId: "b1",
        statement: "The research critical path",
        added: 4,
        reworked: 3,
        dropped: 1,
        finished: 0,
        running: true,
      }),
    ).toBe(
      "The research critical path gained 4 items, reworked 3 and dropped 1, and one session is still on it.",
    );
  });

  it("says so when a batch was planned and nothing came of it", () => {
    expect(
      overnightLine({
        batchId: "b2",
        statement: "The Veritasium BackerKit reward survey",
        added: 0,
        reworked: 0,
        dropped: 0,
        finished: 0,
        running: false,
      }),
    ).toBe("The Veritasium BackerKit reward survey was planned and gained nothing.");
  });
});

describe("objectionLine", () => {
  it("numbers in printed order and states the refusal as what it would have done", () => {
    expect(objectionLine({ askId: "a", todoId: "ph79", decision: "moved the appointment", reason: "the consulate shuts" }, 1)).toEqual({
      text: "1. Moved the appointment, because the consulate shuts.",
      url: itemUrl("ph79"),
    });
    expect(
      objectionLine(
        { askId: "b", decision: "emailed the landlord", refused: true, refusedBecause: "a message to another human in your name" },
        2,
      ),
    ).toEqual({
      text: "2. REFUSED and parked: it would have emailed the landlord — a message to another human in your name.",
      url: TAB_BATCHES,
    });
  });
});

// ── The hourly line ─────────────────────────────────────────────────────────
function hourly(overrides: Partial<HourlyFacts> = {}): HourlyFacts {
  return { now: 1_757_000_000_000, since: 1_756_996_400_000, running: [], batches: [], changes: [], ...overrides };
}

describe("composeHourly", () => {
  it("posts nothing at all for a quiet hour", () => {
    expect(composeHourly(hourly())).toBeNull();
  });

  it("is one sentence with a link inside it for a busy hour", () => {
    const message = composeHourly(
      hourly({
        running: [
          {
            sessionId: "k97a",
            title: "Retire the superseded CMT code paths",
            kind: "focus-item",
            mode: "autonomous",
            status: "running",
            statement: null,
            batchId: null,
            elapsedMs: 8_100_000,
          },
        ],
        changes: [
          { kind: "captured", at: 1, text: "one", detail: null, link: null },
          { kind: "captured", at: 2, text: "two", detail: null, link: null },
          { kind: "captured", at: 3, text: "three", detail: null, link: null },
        ],
      }),
    );
    expect(message).not.toBeNull();
    expect(message?.lines).toEqual([]);
    expect(message?.firstLine).toBe(
      "<https://www.tom.quest/sessions?session=k97a|Retire the superseded CMT code paths> has been working on its own for 2h15m, and 3 items were captured.",
    );
  });

  it("never prints a kind or a mode value", () => {
    const message = composeHourly(
      hourly({
        running: [
          { sessionId: "k1", title: "One", kind: "focus-item", mode: "autonomous", status: "running", statement: "a batch", batchId: "b1", elapsedMs: 60_000 },
          { sessionId: "k2", title: "Two", kind: "adhoc", mode: "interactive", status: "running", statement: null, batchId: null, elapsedMs: 60_000 },
        ],
      }),
    );
    const text = renderSlack(message as Message);
    for (const word of ["focus-item", "adhoc", "autonomous", "interactive", "weekly", "gate", "block"]) {
      expect(text).not.toContain(word);
    }
  });

  it("names where a longer window starts, once, at the end", () => {
    const message = composeHourly(
      hourly({
        sinceLabel: "13:00",
        changes: [{ kind: "done", at: 1, text: "a", detail: null, link: null }],
      }),
    );
    expect(message?.firstLine).toBe("1 finished since 13:00.");
  });
});

// ── The other four kinds ────────────────────────────────────────────────────
describe("composeNeedsYou", () => {
  it("never carries the vendor subject or the From header, even when the facts are next to them", () => {
    const text = renderSlack(
      composeNeedsYou(
        {
          todoId: "ph7by1ap",
          statement: "Check whether the usage-policy notice is genuine, then answer it or delete it",
          entryAction: "Open the email and click Show original",
          reason: "the mail threatens to deactivate the account and may not be from OpenAI",
          sourceUrl: "https://mail.google.com/mail/u/0/#all/1994c1",
        },
        { canReply: false },
      ),
    );
    expect(text).not.toContain("Usage Policy Violation & Deactivation Warning");
    expect(text).not.toContain("OpenAI <");
    expect(text).not.toContain("Needs you today");
    expect(text).not.toContain("reply here");
    expect(text.startsWith("Only you can settle this: ")).toBe(true);
  });
});

describe("composeDecision", () => {
  it("asks for an objection and nothing else, and states a refusal as parked", () => {
    expect(
      renderSlack(
        composeDecision(
          { askId: "a", todoId: "ph7a", decision: "moved the passport appointment to Thursday", reason: "the consulate shuts on Wednesdays" },
          { canReply: true },
        ),
      ),
    ).toBe(
      [
        "Object if this is wrong; silence means it stands.",
        "- <https://tom.quest/tts?item=ph7a|Moved the passport appointment to Thursday, because the consulate shuts on Wednesdays.>",
        'reply "revert", or say what to do instead.',
      ].join("\n"),
    );
    const refused = renderSlack(
      composeDecision(
        {
          askId: "b",
          todoId: "ph80",
          decision: "emailed the landlord chasing the deposit",
          refused: true,
          refusedBecause: "a message to another human in your name",
          fallback: "left it for you",
        },
        { canReply: false },
      ),
    );
    expect(refused).toContain("Parked for you: a message to another human in your name. Nothing was done in your name.");
    expect(refused).toContain("instead the run left it for you");
    expect(refused).not.toContain("reply");
  });
});

describe("composeBroken", () => {
  it("is its first line alone when the failure has no link", () => {
    const message = composeBroken({
      statement: "Nothing has been captured from email since 02:10: the Gmail poller has failed eleven times.",
    });
    expect(message.lines).toEqual([]);
    expect(checkMessage(message, { canReply: false })).toEqual([]);
  });
});

describe("composeCaptured and composeContinued", () => {
  it("says what happens next instead of echoing his words back", () => {
    const text = renderSlack(composeCaptured({ todoId: "ph7a", statement: "buy climbing tape" }));
    expect(text).toBe(
      [
        "Captured; it is prepared tonight and reaches you in tomorrow's morning message.",
        "- <https://tom.quest/tts?item=ph7a|buy climbing tape.>",
      ].join("\n"),
    );
    expect(text).not.toContain("Captured as a todo");
  });

  it("states the session's status as a fact and never prints its kind", () => {
    const text = renderSlack(composeContinued({ sessionId: "k97a", title: "Retire the CMT paths", status: "ended" }));
    expect(text).toContain("That session had already finished, so your reply opened a new one");
    expect(text).not.toContain("ended");
    expect(text).not.toContain("seeded with this thread");
    expect(renderSlack(composeContinued({ sessionId: "k1", title: "T", status: "failed" }))).toContain("had failed");
  });
});

// ── The dedup index ─────────────────────────────────────────────────────────
describe("claimKey", () => {
  it("keys on the day, the ask and the item, so one item under two asks is two keys", () => {
    expect(claimKey("2026-09-09", "act", "ph7a")).toBe("2026-09-09:act:ph7a");
    expect(claimKey("2026-09-09", "object", "ph7a")).not.toBe(claimKey("2026-09-09", "act", "ph7a"));
    expect(claimKey("2026-09-10", "act", "ph7a")).not.toBe(claimKey("2026-09-09", "act", "ph7a"));
  });
});

// ── The facts block and the verifier ────────────────────────────────────────
describe("the facts block", () => {
  it("gives every fact an id, its links and its numbers", () => {
    const block = todayFactsBlock(sept9(), true);
    expect(block.kind).toBe("today");
    expect(block.day).toBe("2026-09-09");
    expect(block.canReply).toBe(true);
    const ids = block.facts.map((f) => f.id);
    expect(ids).toContain("todo:ph7fqh2j");
    expect(ids).toContain("ready:beyond");
    expect(ids).toContain("batch:b1");
    expect(ids).toContain("calendar:lead");
    const ready = block.facts.find((f) => f.id === "ready:beyond");
    expect(ready?.urls).toContain(TAB_EVERYTHING);
    expect(ready?.numbers).toContain("667");
  });

  it("never offers a private calendar row — the gatherer dropped it before this", () => {
    const block = todayFactsBlock(sept9({ calendar: [], calendarLead: undefined }), false);
    expect(block.facts.some((f) => f.id.startsWith("calendar:"))).toBe(false);
  });
});

describe("verifyDraft", () => {
  const block = todayFactsBlock(sept9(), false);

  const good: Draft = {
    firstLine: "Three things carry a date you have passed, the oldest by ten days.",
    firstLineSources: ["today:count"],
    lines: [
      { role: "lead", text: "Dated, oldest first.", sources: ["today:count"] },
      {
        role: "item",
        text: "Run the first Friday triage session: open the agenda. Ten days late.",
        url: itemUrl("ph7fqh2j"),
        sources: ["todo:ph7fqh2j"],
      },
      {
        role: "item",
        text: "667 other items are ready, and not one of them is dated.",
        url: TAB_EVERYTHING,
        sources: ["ready:beyond"],
      },
    ],
  };

  it("accepts a draft whose every link and number is in a fact it cites", () => {
    expect(verifyDraft(good, block)).toEqual([]);
  });

  it("refuses an invented number", () => {
    const bad: Draft = {
      ...good,
      lines: good.lines.map((line, i) =>
        i === 2 ? { ...line, text: "704 other items are ready, and not one of them is dated." } : line,
      ),
    };
    expect(verifyDraft(bad, block).join(" ")).toContain("uses the number 704");
  });

  it("refuses a link carried over from another line", () => {
    const bad: Draft = {
      ...good,
      lines: good.lines.map((line, i) => (i === 2 ? { ...line, url: itemUrl("ph74xqqp") } : line)),
    };
    expect(verifyDraft(bad, block).join(" ")).toContain("which is in no fact it cites");
  });

  it("refuses a fact id that does not exist", () => {
    const bad: Draft = { ...good, firstLineSources: ["today:invented"] };
    expect(verifyDraft(bad, block).join(" ")).toContain('cites an unknown fact "today:invented"');
  });

  it("refuses a reply invitation when the block says the route is not live", () => {
    const bad: Draft = {
      ...good,
      lines: [...good.lines, { role: "note", text: 'reply "done" on a line.', sources: [] }],
    };
    expect(verifyDraft(bad, block).join(" ")).toContain("invites a reply the route cannot receive");
  });

  it("refuses a draft that breaks the form, whatever it cites", () => {
    const bad: Draft = {
      ...good,
      lines: [...good.lines, { role: "item", text: "+667 more", url: TAB_EVERYTHING, sources: ["ready:beyond"] }],
    };
    expect(verifyDraft(bad, block).join(" ")).toContain('bare "+N more"');
  });
});
