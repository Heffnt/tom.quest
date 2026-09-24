// The needs-me selector's timestamp comparisons, at the tie.
//
// selectNeedsMe (app/tts/lib.ts) decides what is in front of Tom by comparing
// the live ruling's ruledAt against the subject's own last-write stamp — a
// life todo's updatedAt, a code brief's preparedAt. All three are
// whole-millisecond Date.now() values written by separate Convex mutations, so
// two of them CAN be equal, and the comparison has to say what an equal pair
// means. It means "still awaiting": the item stays on the pile. These cases
// pin that, so the `<=` cannot be tightened back to `<` silently.

import { describe, expect, it } from "vitest";
import { subjectKey } from "@/convex/ttsRulings";
import {
  codeSubjectKey,
  liveRulingsByKey,
  rulingSubjectKey,
  activeCells,
  agentFigures,
  datedRows,
  eventLanes,
  nextForTom,
  reasonGroup,
  recentDone,
  sessionFacts,
  todoCounts,
  weekActivity,
  selectNeedsMe,
  selectToday,
  shapeCells,
  shapeCounts,
  sourceRows,
  type EventRow,
  type CodeBrief,
  type MirrorRow,
  type Ruling,
  type Todo,
} from "./lib";

// The rows carry many fields the selector never reads; each factory writes the
// ones it does read and casts, so a schema addition elsewhere cannot break
// these cases. Convex row ids are branded strings (Id<"dtsTodos">, not
// string), so the one id these cases share is cast once, here.
const TODO_ID = "todo-1" as unknown as Todo["_id"];

const todo = (over: Partial<Todo> = {}): Todo =>
  ({
    _id: TODO_ID,
    _creationTime: 1,
    statement: "renew the visa",
    status: "active",
    readiness: "prepared",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }) as unknown as Todo;

const mirrorRow = (over: Partial<MirrorRow> = {}): MirrorRow =>
  ({
    _id: "mirror-1",
    _creationTime: 1,
    repo: "ComplexMultiTrigger",
    externalId: "cmt-001",
    tier: "C",
    status: "open",
    statement: "an open code todo",
    url: "https://example.invalid/cmt-001",
    syncedAt: 1000,
    ...over,
  }) as unknown as MirrorRow;

const codeBrief = (over: Partial<CodeBrief> = {}): CodeBrief =>
  ({
    _id: "brief-1",
    _creationTime: 1,
    repo: "ComplexMultiTrigger",
    externalId: "cmt-001",
    sourceHash: "hash-a",
    brief: "# Ground-up brief",
    recommendation: "approve",
    execClass: "box",
    preparedAt: 1000,
    ...over,
  }) as unknown as CodeBrief;

const ruling = (over: Partial<Ruling> = {}): Ruling =>
  ({
    _id: "ruling-1",
    _creationTime: 1,
    subjectType: "code",
    repo: "ComplexMultiTrigger",
    externalId: "cmt-001",
    verdict: "revise",
    sentence: "narrower scope",
    ruledAt: 1000,
    ...over,
  }) as unknown as Ruling;

describe("selectNeedsMe: ruling-vs-subject timestamps", () => {
  // witness: change `ruling.ruledAt <= brief.preparedAt` back to `<` in
  // selectNeedsMe — the row disappears from the code tab and the badge count.
  it("keeps a code row whose re-brief lands in the SAME millisecond as its ruling", () => {
    const { codeRows } = selectNeedsMe(
      [],
      [mirrorRow()],
      [codeBrief({ preparedAt: 1000 })],
      [ruling({ ruledAt: 1000 })],
    );
    expect(codeRows.map((r) => r.row.externalId)).toEqual(["cmt-001"]);
  });

  it("drops a code row whose ruling is strictly newer than its brief", () => {
    const { codeRows } = selectNeedsMe(
      [],
      [mirrorRow()],
      [codeBrief({ preparedAt: 1000 })],
      [ruling({ ruledAt: 1001 })],
    );
    expect(codeRows).toEqual([]);
  });

  it("keeps a code row whose brief is strictly newer than its ruling", () => {
    const { codeRows } = selectNeedsMe(
      [],
      [mirrorRow()],
      [codeBrief({ preparedAt: 1002 })],
      [ruling({ ruledAt: 1001 })],
    );
    expect(codeRows.map((r) => r.row.externalId)).toEqual(["cmt-001"]);
  });

  // witness: change `ruling.ruledAt <= t.updatedAt` back to `<` in
  // selectNeedsMe — the life todo disappears from the tab and the badge.
  it("keeps a life todo re-prepped in the SAME millisecond as its ruling", () => {
    const { lifeRows } = selectNeedsMe(
      [todo({ updatedAt: 1000 })],
      [],
      [],
      [
        ruling({
          subjectType: "life",
          todoId: TODO_ID,
          repo: undefined,
          externalId: undefined,
          ruledAt: 1000,
        }),
      ],
    );
    expect(lifeRows.map((r) => r._id)).toEqual([TODO_ID]);
  });

  // The counterpart the tie must not break: annotations (a checked plan step)
  // deliberately leave updatedAt alone precisely so a ruled
  // gate stays answered, and a ruling recorded after the last content edit is
  // strictly newer than it.
  // A stored "preparing" reads as unprepared (ttsShared.normalizeReadiness):
  // a half-finished write-up is never ready for Tom. Read it as prepared and
  // this goes red — the row would sit on his pile with no write-up to rule on.
  it("drops a life todo still spelled preparing", () => {
    // The validator no longer stores either spelling (the lifeos update, phase
    // 7); a reader still accepts them for one more release, so a bundle built
    // before the narrow reads a row the same way. Hence the casts.
    const retired = (r: string) => todo({ readiness: r as Todo["readiness"] });
    const { lifeRows } = selectNeedsMe([retired("preparing")], [], [], []);
    expect(lifeRows).toEqual([]);
    expect(selectNeedsMe([retired("ready-for-tom")], [], [], []).lifeRows).toHaveLength(1);
  });

  it("drops a life todo whose ruling is strictly newer than its last update", () => {
    const { lifeRows } = selectNeedsMe(
      [todo({ updatedAt: 1000 })],
      [],
      [],
      [
        ruling({
          subjectType: "life",
          todoId: TODO_ID,
          repo: undefined,
          externalId: undefined,
          ruledAt: 1001,
        }),
      ],
    );
    expect(lifeRows).toEqual([]);
  });
});

// One spelling for a ruling subject key. Two things can drift here and used to:
// (1) inside app/tts/lib.ts, rulingSubjectKey once inlined the same strings the
// codeSubjectKey builder produces; (2) the client file as a
// whole is a hand-kept mirror of convex/ttsRulings.ts subjectKey. Both are
// asserted below, so a change to one spelling that misses the other fails here
// instead of silently splitting one subject into two keys (a live ruling that
// no longer matches its subject).
const CASES = [
  { subjectType: "life" as const, todoId: "todo123" },
  { subjectType: "code" as const, repo: "Heffnt/tom.quest", externalId: "42" },
];

describe("ruling subject keys", () => {
  it("produces the two documented formats", () => {
    expect(rulingSubjectKey(CASES[0])).toBe("life todo123");
    expect(rulingSubjectKey(CASES[1])).toBe("code Heffnt/tom.quest 42");
  });

  it("agrees with the codeSubjectKey builder", () => {
    expect(rulingSubjectKey(CASES[1])).toBe(
      codeSubjectKey("Heffnt/tom.quest", "42"),
    );
  });

  it("agrees with the server's subjectKey for every subject kind", () => {
    for (const c of CASES) {
      expect(rulingSubjectKey(c)).toBe(subjectKey(c));
    }
  });

  // A ruling on a batch can still come back from listRulings until the schema
  // stops declaring that subject. No page shows a batch, so it is no live
  // ruling here: without the drop it would sit in "ruled, applying" with no
  // subject to name.
  it("drops a ruling on a batch", () => {
    const onBatch = ruling({
      subjectType: "batch" as never,
      repo: undefined,
      externalId: undefined,
      ruledAt: 1000,
    });
    expect([...liveRulingsByKey([onBatch]).values()]).toEqual([]);
    expect(selectNeedsMe([], [], [], [onBatch]).pending).toEqual([]);
  });
});

// Today's column is computed from the record, not read from a stored queue
// (the lifeos update, phase 7: dtsDailyQueues gets no new rows). These cases
// pin the five lists and the render order.
describe("selectToday", () => {
  const HOUR = 3_600_000;
  const DAY_START = Date.UTC(2026, 8, 6, 4); // a calendar day, as instants
  const DAY_END = DAY_START + 24 * HOUR;
  const NOW = DAY_START + 9 * HOUR;
  const row = (id: string, over: Partial<Todo> = {}): Todo =>
    todo({ _id: id as unknown as Todo["_id"], readiness: "unprepared", ...over });

  it("files each active todo under the first reason that holds, in order", () => {
    const todos = [
      row("overdue", { dueAt: DAY_START - HOUR, readiness: "prepared" }), // also ready
      row("due", { dueAt: DAY_START + 12 * HOUR }),
      row("scheduled"),
      row("ready", { readiness: "prepared" }),
      row("waking", { wakeAt: DAY_START + 20 * HOUR }),
      row("tomorrow", { dueAt: DAY_END + HOUR }),
      row("raw"), // unprepared, undated, unscheduled: not in the column
      row("archived", { status: "archived", dueAt: DAY_START + HOUR }),
      // Dated inside the day, so only the pool rule keeps it out: asleep
      // past the day.
      row("asleep-past-day", { dueAt: DAY_START + HOUR, wakeAt: DAY_END + HOUR }),
      // A task and a goal are todos like any other: with batches gone no
      // card shows them instead, so both are in the pool.
      row("task", { dueAt: DAY_START + 13 * HOUR, kind: "task" }),
      row("goal", { dueAt: DAY_START + 14 * HOUR, kind: "goal" }),
    ];
    const blocks = [
      { todoId: "scheduled", start: DAY_START + 10 * HOUR, end: DAY_START + 11 * HOUR },
      { todoId: "raw", start: DAY_END + HOUR, end: DAY_END + 2 * HOUR }, // tomorrow's block
    ];
    const view = selectToday(todos, blocks, { start: DAY_START, end: DAY_END }, NOW);
    expect(view.overdue.map((t) => t._id)).toEqual(["overdue"]);
    expect(view.due.map((t) => t._id)).toEqual(["due", "task", "goal"]);
    expect(view.scheduled.map((t) => t._id)).toEqual(["scheduled"]);
    // "overdue" is ready too, and stays in the ready list — the lists are facts.
    expect(view.ready.map((t) => t._id).sort()).toEqual(["overdue", "ready"]);
    expect(view.waking.map((t) => t._id)).toEqual(["waking"]);
    // The column shows each once, under the reason that outranks the others.
    expect(view.entries.map((e) => `${e.reason}:${e.todo._id}`)).toEqual([
      "overdue:overdue",
      "due:due",
      "due:task",
      "due:goal",
      "scheduled:scheduled",
      "ready:ready",
      "waking:waking",
    ]);
  });

  it("ready means ready FOR TOM: prepared, awake, every need done", () => {
    const todos = [
      row("need", { status: "done" }),
      row("blocked", { readiness: "prepared", needs: ["missing"] as never }),
      row("unblocked", { readiness: "prepared", needs: ["need"] as never }),
      row("asleep", { readiness: "prepared", wakeAt: NOW + HOUR }),
    ];
    const view = selectToday(todos, [], { start: DAY_START, end: DAY_END }, NOW);
    expect(view.ready.map((t) => t._id)).toEqual(["unblocked"]);
    // A sleep that ends inside the day is a waking entry, not a ready one.
    expect(view.entries.map((e) => `${e.reason}:${e.todo._id}`)).toEqual([
      "ready:unblocked",
      "waking:asleep",
    ]);
  });

  it("orders dated lists by date and is empty for an empty record", () => {
    const todos = [
      row("later", { dueAt: DAY_START + 15 * HOUR }),
      row("sooner", { dueAt: DAY_START + 8 * HOUR }),
    ];
    const view = selectToday(todos, [], { start: DAY_START, end: DAY_END }, NOW);
    expect(view.due.map((t) => t._id)).toEqual(["sooner", "later"]);
    expect(selectToday([], [], { start: DAY_START, end: DAY_END }, NOW).entries).toEqual([]);
  });
});

// ── The whole set at a glance (the toolbox page) ─────────────────────────────

describe("shapeCells", () => {
  const NOW = 10_000_000;
  const at = (id: string, over: Partial<Todo>) =>
    todo({ _id: id as unknown as Todo["_id"], source: "manual", ...over });

  it("puts every todo in exactly one shape, overdue before the waiting reason", () => {
    const todos = [
      at("a", { actor: "tom" }),
      at("b", { actor: "tom", dueAt: NOW - 1 }),
      at("c", { readiness: "unprepared" }),
      at("d", { needs: ["a" as unknown as Todo["_id"]] }),
      at("e", { wakeAt: NOW + 1000 }),
      at("f", { actor: "agent" }),
      at("g", { status: "done" }),
      at("h", { status: "archived", source: "slack-capture" }),
    ];
    const cells = shapeCells(todos, NOW);
    const counts = shapeCounts(cells);
    expect(counts).toMatchObject({
      overdue: 1,
      "waiting on you": 1,
      "not yet prepared": 1,
      "waiting on another todo": 1,
      "with a date": 1,
      "with an agent": 1,
      done: 1,
      archived: 1,
    });
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(todos.length);
    expect(cells.find((c) => c.group === "archived")?.label).toBe("slack capture");
  });

  it("splits one shape by source and folds the cells back by source", () => {
    const todos = [
      at("a", { actor: "tom", source: "email" }),
      at("b", { actor: "tom", source: "email" }),
      at("c", { actor: "tom", source: "manual" }),
      at("d", { status: "done", source: "email" }),
    ];
    const cells = shapeCells(todos, NOW);
    expect(cells.map((c) => [c.group, c.label, c.count])).toEqual([
      ["waiting on you", "email", 2],
      ["waiting on you", "manual", 1],
      ["done", "email", 1],
    ]);
    expect(sourceRows(cells)).toEqual([
      { source: "email", waitingOnYou: 2, notYetPrepared: 0, done: 1, total: 3 },
      { source: "manual", waitingOnYou: 1, notYetPrepared: 0, done: 0, total: 1 },
    ]);
  });
});

describe("nextForTom", () => {
  const id = (s: string) => s as unknown as Todo["_id"];

  it("picks an overdue todo ready for Tom first, the longest overdue of them", () => {
    const old = todo({ _id: id("old"), _creationTime: 1 });
    const late = todo({ _id: id("late"), _creationTime: 5, dueAt: 1_500 });
    const later = todo({ _id: id("later"), _creationTime: 4, dueAt: 1_800 });
    expect(nextForTom([old, later, late], [], 2_000)?._id).toBe("late");
  });

  // witness: sort every needs-me row by date, as nextForTom once did — the
  // todo due next month jumps the capture that has waited on him longest.
  it("otherwise picks the oldest waiting on Tom, whatever date a newer one carries", () => {
    const a = todo({ _id: id("a"), _creationTime: 1 });
    const b = todo({ _id: id("b"), _creationTime: 2, dueAt: 5_000 });
    expect(nextForTom([b, a], [], 2_000)?._id).toBe("a");
  });

  it("skips one he has ruled on, and is undefined when none waits", () => {
    const a = todo({ _id: id("a"), _creationTime: 1 });
    const b = todo({ _id: id("b"), _creationTime: 2 });
    const ruled = { subjectType: "life", todoId: "a", ruledAt: 3_000, _creationTime: 3 } as unknown as Ruling;
    expect(nextForTom([a, b], [ruled], 2_000)?._id).toBe("b");
    expect(nextForTom([], [], 2_000)).toBeUndefined();
  });
});

// ── The todos page ──────────────────────────────────────────────────────────

describe("the todos page selectors", () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const at = (id: string, over: Partial<Todo>) =>
    todo({ _id: id as unknown as Todo["_id"], source: "manual", ...over });
  const need = (id: string) => [id as unknown as Todo["_id"]];

  const TODOS = [
    at("you", { actor: "tom", source: "email", dueAt: NOW - DAY }),
    at("you2", { actor: "tom", source: "email", _creationTime: 0 }),
    at("you3", { actor: "tom" }),
    at("blocked", { needs: need("you3") }),
    at("raw", { readiness: "unprepared", dueAt: NOW + DAY }),
    at("agent", { actor: "agent" }),
    at("asleep", { wakeAt: NOW + DAY }),
    at("stored-waiting", { status: "waiting" }),
    at("done-recent", { status: "done", doneAt: NOW - DAY }),
    at("done-old", { status: "done", doneAt: NOW - 40 * DAY }),
    at("archived", { status: "archived", dueAt: NOW - DAY }),
  ];

  it("puts every active todo under one reason and leaves done and archived out", () => {
    const cells = activeCells(TODOS, NOW);
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(8);
    expect(cells.map((c) => [c.group, c.label, c.count])).toEqual([
      ["waiting on you", "email", 2],
      ["waiting on you", "manual", 1],
      ["waiting on another todo", "manual", 1],
      ["not yet prepared", "manual", 1],
      ["ready for an agent", "manual", 1],
      ["waiting until a date", "manual", 2],
    ]);
    // An overdue todo stays under its reason; the figure is not split by date.
    expect(cells[0].todos.map((t) => t._id)).toEqual(["you", "you2"]);
  });

  it("gives one reason as a whole, largest source first", () => {
    const group = reasonGroup(activeCells(TODOS, NOW), "waiting on you");
    expect(group.count).toBe(3);
    expect(group.todos.map((t) => t._id)).toEqual(["you", "you2", "you3"]);
  });

  it("counts what the page states", () => {
    expect(todoCounts(TODOS, NOW)).toEqual({
      active: 8,
      waitingOnYou: 3,
      waitingOnTodo: 1,
      notPrepared: 1,
      dated: 2,
      overdue: 1,
      blocking: 1,
      done: 2,
      doneLast30: 1,
    });
  });

  // witness: count a need that is already done as blocking — a todo whose
  // need finished last week is still counted as holding another up.
  it("counts as blocking only a todo not yet done that an active todo waits on", () => {
    const todos = [
      at("a", { needs: need("b") }),
      at("b", {}),
      at("c", { needs: need("d") }),
      at("d", { status: "done" }),
      at("e", { status: "done", needs: need("f") }),
      at("f", {}),
    ];
    expect(todoCounts(todos, NOW).blocking).toBe(1);
  });

  it("lists the active dated todos soonest first, overdue or due", () => {
    expect(datedRows(TODOS, NOW).map((r) => [r.todo._id, r.overdue])).toEqual([
      ["you", true],
      ["raw", false],
    ]);
  });

  it("lists the done todos most recently done first", () => {
    expect(recentDone(TODOS).map((r) => r.todo._id)).toEqual(["done-recent", "done-old"]);
  });

  it("counts the week's agent work, and says the span when the events stop short of it", () => {
    const ev = (kind: string, t: number) => ({ kind, at: t }) as unknown as EventRow;
    const events = [
      ev("captured", NOW - DAY),
      ev("captured", NOW - 8 * DAY),
      ev("prepared", NOW - DAY),
      ev("merge", NOW - 2 * DAY),
      ev("job-failed", NOW - 3 * DAY),
      ev("delegate-decision", NOW - 4 * DAY),
    ];
    expect(weekActivity(events, NOW, false)).toEqual({
      since: NOW - 7 * DAY,
      captured: 1,
      prepared: 1,
      merges: 1,
      jobFailures: 1,
      delegateDecisions: 1,
    });
    const capped = [ev("captured", NOW - DAY), ev("merge", NOW - 2 * DAY)];
    expect(weekActivity(capped, NOW, true).since).toBe(NOW - 2 * DAY);
  });

  it("counts the idle agents and names the newest", () => {
    const facts = sessionFacts([
      { title: "older", status: "idle", _creationTime: 1 },
      { title: "newest", status: "running", _creationTime: 3 },
      { title: "idle too", status: "idle", _creationTime: 2 },
    ]);
    expect(facts).toEqual({ idle: 2, latest: { title: "newest", at: 3 } });
    expect(sessionFacts([]).latest).toBeUndefined();
  });
});

describe("eventLanes", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const ev = (kind: string, at: number) => ({ kind, at }) as unknown as EventRow;

  it("counts per bin per kind, keeps the top kinds and folds the rest", () => {
    const events = [
      ev("slack-sent", NOW - 1),
      ev("slack-sent", NOW - 1),
      ev("slack-sent", NOW - 3 * HOUR - 1),
      ev("capture", NOW - 1),
      ev("prepare", NOW - 2 * HOUR - 1),
      ev("prepare", NOW - 30 * HOUR),
    ];
    const { lanes, binLabels } = eventLanes(events, NOW, 4, HOUR, 1);
    expect(binLabels).toHaveLength(4);
    expect(lanes).toEqual([
      { name: "slack sent", bins: [1, 0, 0, 2] },
      { name: "every other kind", bins: [0, 1, 0, 1] },
    ]);
  });

  it("names a lane in Tom's words and folds a kind it cannot name", () => {
    const events = [
      ev("runs-environment-defaulted", NOW - 1),
      ev("runs-environment-defaulted", NOW - 1),
      ev("runs-environment-defaulted", NOW - 1),
      ev("tests-run", NOW - 1),
    ];
    const { lanes } = eventLanes(events, NOW, 1, HOUR, 4);
    expect(lanes).toEqual([
      { name: "tests", bins: [1] },
      { name: "every other kind", bins: [3] },
    ]);
  });
});

describe("agentFigures", () => {
  it("counts the agents by status, working for running", () => {
    const figures = agentFigures([
      { status: "running" },
      { status: "running" },
      { status: "requested" },
      { status: "failed" },
    ]);
    expect(figures).toEqual([
      { value: 4, name: "agents" },
      { value: 2, name: "working" },
      { value: 0, name: "idle" },
      { value: 1, name: "starting" },
      { value: 0, name: "ended" },
      { value: 1, name: "failed" },
    ]);
  });
});
