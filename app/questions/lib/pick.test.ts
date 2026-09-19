import { describe, expect, it } from "vitest";
import type { Question } from "../data/types";
import { BANK } from "../data/types";
import {
  FRAMES,
  INITIAL_FILTERS,
  KINDS,
  canStep,
  kindOf,
  matches,
  refined,
  startIndex,
  stepped,
  topicsOf,
  type Filters,
} from "./pick";

const question = (over: Partial<Question> & { id: string }): Question => ({
  text: `question ${over.id}`,
  depth: 1,
  frame: "hypothetical",
  topic: "taste",
  release: false,
  source: "test",
  why: "test",
  ...over,
});

const filters = (over: Partial<Filters> = {}): Filters => ({ ...INITIAL_FILTERS, ...over });

const ids = (questions: readonly Question[]): string[] => questions.map((entry) => entry.id);

describe("the no-filter sentinel", () => {
  it("is null on every filter, and opens every chip row", () => {
    expect(INITIAL_FILTERS).toEqual({ kind: null, frame: null, topic: null });
    expect(KINDS[0]).toBeNull();
    expect(FRAMES[0]).toBeNull();
  });

  it("never collides with a topic the bank calls any", () => {
    const bank = [question({ id: "named", topic: "any" }), question({ id: "other", topic: "taste" })];
    expect(ids(matches(bank, filters({ topic: null })))).toEqual(["named", "other"]);
    expect(ids(matches(bank, filters({ topic: "any" })))).toEqual(["named"]);
  });
});

describe("refined", () => {
  it("returns the filters it was given when the patch selects what is already selected", () => {
    const current = filters({ kind: 2, topic: "taste" });
    expect(refined(current, { topic: "taste" })).toBe(current);
    expect(refined(current, { kind: 2 })).toBe(current);
    expect(refined(current, { frame: null })).toBe(current);
    expect(refined(current, {})).toBe(current);
  });

  it("returns new filters when the patch changes one", () => {
    const current = filters({ topic: "taste" });
    const updated = refined(current, { topic: "memory" });
    expect(updated).not.toBe(current);
    expect(updated).toEqual({ kind: null, frame: null, topic: "memory" });
    expect(refined(current, { topic: null })).not.toBe(current);
  });
});

describe("matches", () => {
  const bank = [
    question({ id: "d1", depth: 1, frame: "hypothetical", topic: "taste" }),
    question({ id: "d2", depth: 2, frame: "observation", topic: "memory" }),
    question({ id: "d3", depth: 3, frame: "value", topic: "taste" }),
    question({ id: "light", depth: 1, frame: "appraisal", topic: "humour", release: true }),
  ];

  it("admits every question, release included, on the initial filters", () => {
    expect(ids(matches(bank, filters()))).toEqual(["d1", "d2", "d3", "light"]);
  });

  it("admits only the questions at a numeric kind, and never a release one", () => {
    expect(ids(matches(bank, filters({ kind: 1 })))).toEqual(["d1"]);
    expect(ids(matches(bank, filters({ kind: 2 })))).toEqual(["d2"]);
    expect(ids(matches(bank, filters({ kind: 3 })))).toEqual(["d3"]);
  });

  it("admits only release questions on the lighter kind", () => {
    const lighter = matches(bank, filters({ kind: "lighter" }));
    expect(ids(lighter)).toEqual(["light"]);
    expect(lighter.every((entry) => entry.release)).toBe(true);
  });

  it("filters on frame alone", () => {
    expect(ids(matches(bank, filters({ frame: "observation" })))).toEqual(["d2"]);
    expect(ids(matches(bank, filters({ frame: "appraisal" })))).toEqual(["light"]);
  });

  it("filters on topic alone", () => {
    expect(ids(matches(bank, filters({ topic: "taste" })))).toEqual(["d1", "d3"]);
  });

  it("combines all three filters", () => {
    expect(ids(matches(bank, filters({ kind: 3, frame: "value", topic: "taste" })))).toEqual(["d3"]);
    expect(matches(bank, filters({ kind: 3, frame: "value", topic: "memory" }))).toEqual([]);
    expect(matches(bank, filters({ kind: 1, frame: "appraisal" }))).toEqual([]);
  });

  it("keeps bank order rather than filter order", () => {
    const shuffled = [
      question({ id: "third", topic: "taste" }),
      question({ id: "first", topic: "taste" }),
      question({ id: "second", topic: "taste" }),
    ];
    expect(ids(matches(shuffled, filters({ topic: "taste" })))).toEqual(["third", "first", "second"]);
    expect(ids(matches(shuffled, filters()))).toEqual(["third", "first", "second"]);
  });
});

describe("kindOf", () => {
  it("returns lighter for a release question regardless of its depth", () => {
    expect(kindOf(question({ id: "release", depth: 3, release: true }))).toBe("lighter");
  });

  it("returns the depth for a non-release question at each of 1, 2 and 3", () => {
    for (const depth of [1, 2, 3] as const) {
      expect(kindOf(question({ id: `depth-${depth}`, depth }))).toBe(depth);
    }
  });

  it("round-trips every committed bank question through its kind filter", () => {
    for (const entry of BANK) {
      expect(matches(BANK, { ...INITIAL_FILTERS, kind: kindOf(entry) })).toContain(entry);
    }
  });
});

describe("startIndex", () => {
  const list = [question({ id: "first" }), question({ id: "second" }), question({ id: "third" })];

  it("returns 0 for an empty list", () => {
    expect(startIndex([], new Set(), null)).toBe(0);
  });

  it("returns the current id position even when it is seen and an unseen question comes earlier", () => {
    expect(startIndex(list, new Set(["second"]), "second")).toBe(1);
  });

  it("returns the first unseen position when the current id is null", () => {
    expect(startIndex(list, new Set(["first"]), null)).toBe(1);
  });

  it("returns the first unseen position when the current id is not in the list", () => {
    expect(startIndex(list, new Set(["first"]), "elsewhere")).toBe(1);
  });

  it("returns 0 when every question is seen and the current id is not in the list", () => {
    expect(startIndex(list, new Set(ids(list)), "elsewhere")).toBe(0);
  });
});

describe("stepped", () => {
  const list = [question({ id: "first" }), question({ id: "second" }), question({ id: "third" })];

  it("moves forward from the middle and returns a new set with the left question and every input id", () => {
    const seen = new Set(["already-seen"]);
    const result = stepped(list, 1, seen, 1);
    expect(result.index).toBe(2);
    expect(result.seen).not.toBe(seen);
    expect([...result.seen]).toEqual(["already-seen", "second"]);
  });

  it("does not mutate the input set when moving forward", () => {
    const seen = new Set(["already-seen"]);
    stepped(list, 1, seen, 1);
    expect([...seen]).toEqual(["already-seen"]);
  });

  it("returns the same index and identical set when moving forward at the last index", () => {
    const seen = new Set<string>();
    const result = stepped(list, 2, seen, 1);
    expect(result.index).toBe(2);
    expect(result.seen).toBe(seen);
  });

  it("moves back from the middle and returns the identical set", () => {
    const seen = new Set<string>();
    const result = stepped(list, 1, seen, -1);
    expect(result.index).toBe(0);
    expect(result.seen).toBe(seen);
  });

  it("returns the same index and identical set when moving back at index 0", () => {
    const seen = new Set<string>();
    const result = stepped(list, 0, seen, -1);
    expect(result.index).toBe(0);
    expect(result.seen).toBe(seen);
  });

  it("returns the same index and identical set on an empty list in both directions", () => {
    const seen = new Set<string>();
    expect(stepped([], 0, seen, 1)).toEqual({ index: 0, seen });
    expect(stepped([], 0, seen, 1).seen).toBe(seen);
    expect(stepped([], 0, seen, -1)).toEqual({ index: 0, seen });
    expect(stepped([], 0, seen, -1).seen).toBe(seen);
  });
});

describe("canStep", () => {
  it("is false in both directions on one entry, false at each end, and true otherwise", () => {
    const list = [question({ id: "first" }), question({ id: "second" }), question({ id: "third" })];
    expect(canStep([list[0]], 0, -1)).toBe(false);
    expect(canStep([list[0]], 0, 1)).toBe(false);
    expect(canStep(list, 0, -1)).toBe(false);
    expect(canStep(list, 2, 1)).toBe(false);
    expect(canStep(list, 0, 1)).toBe(true);
    expect(canStep(list, 2, -1)).toBe(true);
  });
});

describe("the committed bank", () => {
  it("has a unique id for every question", () => {
    expect(new Set(BANK.map((entry) => entry.id)).size).toBe(BANK.length);
  });

  it("holds a question at every depth the walk can reach", () => {
    for (const depth of [1, 2, 3] as const) {
      expect(BANK.some((entry) => entry.depth === depth && !entry.release)).toBe(true);
    }
  });

  it("holds a release question for lighten to serve", () => {
    expect(BANK.some((entry) => entry.release)).toBe(true);
  });

  it("lists its topics in bank order", () => {
    expect(topicsOf(BANK)[0]).toBe(BANK[0].topic);
    expect(topicsOf(BANK).length).toBeGreaterThan(1);
  });
});
