import { describe, expect, it } from "vitest";
import type { Question } from "../data/types";
import { BANK } from "../data/types";
import { FRAMES, INITIAL_FILTERS, KINDS, matches, next, refined, topicsOf, type Filters, type Rng } from "./pick";

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

/** Always the first candidate, so every assertion below is about the ordering. */
const first: Rng = () => 0;
/** Always the last candidate, so an assertion can tell a pool's ends apart. */
const last: Rng = () => 0.999;

const filters = (over: Partial<Filters> = {}): Filters => ({ ...INITIAL_FILTERS, ...over });

const ids = (questions: readonly Question[]): string[] => questions.map((entry) => entry.id);

const none = new Set<string>();

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

describe("next", () => {
  it("never returns the question already on screen", () => {
    const bank = [question({ id: "a" }), question({ id: "b" })];
    expect(next(bank, filters(), none, "a", first)?.id).toBe("b");
    expect(next(bank, filters(), none, "b", first)?.id).toBe("a");
    expect(next(bank, filters(), none, "b", last)?.id).toBe("a");
  });

  it("prefers a question not yet seen", () => {
    const bank = [question({ id: "seen1" }), question({ id: "seen2" }), question({ id: "fresh" })];
    const seen = new Set(["seen1", "seen2"]);
    expect(next(bank, filters(), seen, null, first)?.id).toBe("fresh");
    expect(next(bank, filters(), seen, null, last)?.id).toBe("fresh");
  });

  it("cycles through the match set again once everything in it is seen", () => {
    const bank = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
    const seen = new Set(["a", "b", "c"]);
    expect(next(bank, filters(), seen, "a", first)?.id).toBe("b");
    expect(next(bank, filters(), seen, "a", last)?.id).toBe("c");
  });

  it("serves an already-seen question rather than emptying the page", () => {
    const bank = [question({ id: "a" }), question({ id: "b" })];
    const seen = new Set(["a", "b"]);
    const served = next(bank, filters(), seen, "a", first);
    expect(served).not.toBeNull();
    expect(seen.has(served?.id ?? "")).toBe(true);
  });

  it("draws only from the match set the filters describe", () => {
    const bank = [
      question({ id: "d1", depth: 1 }),
      question({ id: "d2", depth: 2, topic: "memory" }),
      question({ id: "light", release: true }),
    ];
    expect(next(bank, filters({ kind: 2 }), none, null, first)?.id).toBe("d2");
    expect(next(bank, filters({ kind: "lighter" }), none, null, first)?.id).toBe("light");
    expect(next(bank, filters({ topic: "memory" }), none, null, last)?.id).toBe("d2");
  });

  it("returns null when nothing matches", () => {
    const bank = [question({ id: "a", topic: "taste" })];
    expect(next(bank, filters({ topic: "memory" }), none, null, first)).toBeNull();
    expect(next(bank, filters({ kind: "lighter" }), none, null, first)).toBeNull();
    expect(next([], filters(), none, null, first)).toBeNull();
  });

  it("holds the one match on screen rather than blanking the page", () => {
    const bank = [question({ id: "only" }), question({ id: "other", depth: 2 })];
    expect(next(bank, filters({ kind: 1 }), new Set(["only"]), "only", first)?.id).toBe("only");
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
