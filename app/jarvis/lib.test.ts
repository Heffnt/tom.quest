// The needs-me selector's timestamp comparisons, at the tie.
//
// selectNeedsMe (app/jarvis/lib.ts) decides what is in front of Tom by comparing
// the live ruling's ruledAt against a life todo's own last-write stamp. Both
// are whole-millisecond Date.now() values written by separate Convex mutations,
// so two of them CAN be equal, and the comparison has to say what an equal pair
// means. It means "still awaiting": the item stays on the pile. These cases
// pin that, so the `<=` cannot be tightened back to `<` silently.

import { describe, expect, it } from "vitest";
import { subjectKey } from "@/convex/ttsRulings";
import {
  fmtDate,
  isoDate,
  liveRulingsByKey,
  rulingSubjectKey,
  selectNeedsMe,
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
  // witness: change `ruling.ruledAt <= t.updatedAt` back to `<` in
  // selectNeedsMe — the life todo disappears from the tab and the badge.
  it("keeps a life todo re-prepped in the SAME millisecond as its ruling", () => {
    const { lifeRows } = selectNeedsMe(
      [todo({ updatedAt: 1000 })],
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
    const { lifeRows } = selectNeedsMe([retired("preparing")], []);
    expect(lifeRows).toEqual([]);
    expect(selectNeedsMe([retired("ready-for-tom")], []).lifeRows).toHaveLength(1);
  });

  it("drops a life todo whose ruling is strictly newer than its last update", () => {
    const { lifeRows } = selectNeedsMe(
      [todo({ updatedAt: 1000 })],
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

// One spelling for a ruling subject key. The client file is a hand-kept mirror
// of convex/ttsRulings.ts subjectKey. Both are
// asserted below, so a change to one spelling that misses the other fails here
// instead of silently splitting one subject into two keys (a live ruling that
// no longer matches its subject).
const CASES = [
  { subjectType: "life" as const, todoId: "todo123" },
];

describe("ruling subject keys", () => {
  it("produces the documented life format", () => {
    expect(rulingSubjectKey(CASES[0])).toBe("life todo123");
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
    expect(selectNeedsMe([], [onBatch]).pending).toEqual([]);
  });
});

describe("the dates on the todo rows", () => {
  it("are the New York date, so an evening instant is not dated tomorrow", () => {
    expect(isoDate(Date.parse("2026-10-05T01:58:00Z"))).toBe("2026-10-04");
    expect(fmtDate(Date.parse("2026-10-05T01:58:00Z"))).toBe("Sun Oct 4, 2026");
  });
});
