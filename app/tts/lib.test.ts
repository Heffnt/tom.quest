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
  batchSubjectKey,
  codeSubjectKey,
  rulingSubjectKey,
  selectNeedsMe,
  selectToday,
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

  // The counterpart the tie must not break: annotations (a checked plan step,
  // a batch binding) deliberately leave updatedAt alone precisely so a ruled
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
// codeSubjectKey/batchSubjectKey builders produce; (2) the client file as a
// whole is a hand-kept mirror of convex/ttsRulings.ts subjectKey. Both are
// asserted below, so a change to one spelling that misses the other fails here
// instead of silently splitting one subject into two keys (a live ruling that
// no longer matches its subject).
const CASES = [
  { subjectType: "life" as const, todoId: "todo123" },
  { subjectType: "code" as const, repo: "Heffnt/tom.quest", externalId: "42" },
  { subjectType: "batch" as const, batchId: "batch789" },
];

describe("ruling subject keys", () => {
  it("produces the three documented formats", () => {
    expect(rulingSubjectKey(CASES[0])).toBe("life todo123");
    expect(rulingSubjectKey(CASES[1])).toBe("code Heffnt/tom.quest 42");
    expect(rulingSubjectKey(CASES[2])).toBe("batch batch789");
  });

  it("agrees with the codeSubjectKey and batchSubjectKey builders", () => {
    expect(rulingSubjectKey(CASES[1])).toBe(
      codeSubjectKey("Heffnt/tom.quest", "42"),
    );
    expect(rulingSubjectKey(CASES[2])).toBe(batchSubjectKey("batch789"));
  });

  it("agrees with the server's subjectKey for every subject kind", () => {
    for (const c of CASES) {
      expect(rulingSubjectKey(c)).toBe(subjectKey(c));
    }
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
      // The three the retired queue never listed, each dated inside the day
      // so only the pool rule keeps it out: asleep past the day, a v1 batch
      // row, a graph task. A bound GOAL is Tom's own todo and stays.
      row("asleep-past-day", { dueAt: DAY_START + HOUR, wakeAt: DAY_END + HOUR }),
      row("v1-batch", { dueAt: DAY_START + HOUR, members: [] }),
      row("graph-task", {
        dueAt: DAY_START + HOUR,
        batchId: "batch-1" as unknown as Todo["batchId"],
        kind: "task",
      }),
      row("goal", {
        dueAt: DAY_START + 13 * HOUR,
        batchId: "batch-1" as unknown as Todo["batchId"],
        kind: "goal",
      }),
    ];
    const blocks = [
      { todoId: "scheduled", start: DAY_START + 10 * HOUR, end: DAY_START + 11 * HOUR },
      { todoId: "raw", start: DAY_END + HOUR, end: DAY_END + 2 * HOUR }, // tomorrow's block
    ];
    const view = selectToday(todos, blocks, { start: DAY_START, end: DAY_END }, NOW);
    expect(view.overdue.map((t) => t._id)).toEqual(["overdue"]);
    expect(view.due.map((t) => t._id)).toEqual(["due", "goal"]);
    expect(view.scheduled.map((t) => t._id)).toEqual(["scheduled"]);
    // "overdue" is ready too, and stays in the ready list — the lists are facts.
    expect(view.ready.map((t) => t._id).sort()).toEqual(["overdue", "ready"]);
    expect(view.waking.map((t) => t._id)).toEqual(["waking"]);
    // The column shows each once, under the reason that outranks the others.
    expect(view.entries.map((e) => `${e.reason}:${e.todo._id}`)).toEqual([
      "overdue:overdue",
      "due:due",
      "due:goal",
      "scheduled:scheduled",
      "ready:ready",
      "waking:waking",
    ]);
  });

  it("ready means ready FOR TOM: prepared, awake, every need done (a v1 batch is outside the pool)", () => {
    const todos = [
      row("need", { status: "done" }),
      row("blocked", { readiness: "prepared", needs: ["missing"] as never }),
      row("unblocked", { readiness: "prepared", needs: ["need"] as never }),
      row("asleep", { readiness: "prepared", wakeAt: NOW + HOUR }),
      row("batch", { readiness: "prepared", members: [] }),
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
