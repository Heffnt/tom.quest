import { describe, expect, it } from "vitest";
import type { Question } from "../data/types";
import { BANK } from "../data/types";
import { advance, INITIAL_STATE, pick, topicsOf, type QuestionsState, type Rng } from "./pick";

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

const state = (over: Partial<QuestionsState> = {}): QuestionsState => ({
  ...INITIAL_STATE,
  ...over,
});

describe("pick", () => {
  it("caps the walk at depth 3", () => {
    const bank = [question({ id: "a", depth: 3 }), question({ id: "b", depth: 3 })];
    const deeper = advance(bank, state({ depth: 3, current: bank[0] }), "deeper", first);
    expect(deeper.depth).toBe(3);
    expect(deeper.current?.depth).toBe(3);
  });

  it("walks one depth at a time up to the cap", () => {
    const bank = [question({ id: "a", depth: 1 }), question({ id: "b", depth: 2 }), question({ id: "c", depth: 3 })];
    let walked = advance(bank, state(), "stay", first);
    expect(walked.depth).toBe(1);
    walked = advance(bank, walked, "deeper", first);
    expect(walked.depth).toBe(2);
    walked = advance(bank, walked, "deeper", first);
    expect(walked.depth).toBe(3);
    walked = advance(bank, walked, "deeper", first);
    expect(walked.depth).toBe(3);
  });

  it("serves only release questions when lightening", () => {
    const bank = [
      question({ id: "heavy1", depth: 3 }),
      question({ id: "heavy2", depth: 1 }),
      question({ id: "light", depth: 2, release: true, topic: "humour" }),
    ];
    const lightened = advance(bank, state({ depth: 3 }), "lighten", first);
    expect(lightened.current?.id).toBe("light");
    expect(lightened.current?.release).toBe(true);
  });

  it("never serves a release question on the depth walk", () => {
    const bank = [question({ id: "light", release: true }), question({ id: "heavy" })];
    expect(advance(bank, state(), "stay", first).current?.id).toBe("heavy");
  });

  it("marks the current question used on a walk", () => {
    const bank = [question({ id: "a" }), question({ id: "b" })];
    const walked = advance(bank, state({ current: bank[0] }), "stay", first);
    expect([...walked.used]).toEqual(["a"]);
    expect(walked.current?.id).toBe("b");
  });

  it("does not mark the current question used on a skip", () => {
    const bank = [question({ id: "a" }), question({ id: "b" })];
    const skipped = advance(bank, state({ current: bank[0] }), "skip", first);
    expect([...skipped.used]).toEqual([]);
    expect(skipped.current?.id).toBe("b");
  });

  it("does not mark the current question used when a filter is chosen", () => {
    const bank = [question({ id: "a" }), question({ id: "b", depth: 2 })];
    const filtered = advance(
      bank,
      state({ current: bank[0], filters: { depth: 2, topic: "any" } }),
      "filter",
      first,
    );
    expect([...filtered.used]).toEqual([]);
    expect(filtered.current?.id).toBe("b");
  });

  it("prefers a topic never served over one already served", () => {
    const bank = [
      question({ id: "taste1", topic: "taste" }),
      question({ id: "taste2", topic: "taste" }),
      question({ id: "memory1", topic: "memory" }),
    ];
    const rotated = pick(bank, state({ history: ["taste1"], used: new Set(["taste1"]) }), "stay", first);
    expect(rotated.question?.topic).toBe("memory");
  });

  it("returns to the topic served longest ago once every topic has been served", () => {
    const bank = [
      question({ id: "taste1", topic: "taste" }),
      question({ id: "memory1", topic: "memory" }),
      question({ id: "taste2", topic: "taste" }),
      question({ id: "memory2", topic: "memory" }),
    ];
    // taste last at position 0, memory last at position 1: taste is older.
    const rotated = pick(
      bank,
      state({ history: ["taste1", "memory1"], used: new Set(["taste1", "memory1"]) }),
      "stay",
      first,
    );
    expect(rotated.question?.id).toBe("taste2");
  });

  it("rotates the frame within the chosen topic", () => {
    const bank = [
      question({ id: "hyp1", topic: "taste", frame: "hypothetical" }),
      question({ id: "hyp2", topic: "taste", frame: "hypothetical" }),
      question({ id: "obs1", topic: "taste", frame: "observation" }),
    ];
    const rotated = pick(bank, state({ history: ["hyp1"], used: new Set(["hyp1"]) }), "stay", first);
    expect(rotated.question?.frame).toBe("observation");
    expect(rotated.question?.id).toBe("obs1");
  });

  it("falls back to a used question rather than running dry", () => {
    const bank = [question({ id: "only" })];
    const exhausted = pick(bank, state({ used: new Set(["only"]) }), "stay", first);
    expect(exhausted.question?.id).toBe("only");
  });

  it("falls back on a lighten with every release question used", () => {
    const bank = [question({ id: "light", release: true }), question({ id: "heavy" })];
    const exhausted = pick(bank, state({ used: new Set(["light"]) }), "lighten", first);
    expect(exhausted.question?.id).toBe("light");
  });

  it("returns null when nothing in the bank can answer the move", () => {
    const bank = [question({ id: "light", release: true })];
    expect(pick(bank, state(), "stay", first).question).toBeNull();
    expect(pick([], state(), "stay", first).question).toBeNull();
  });

  it("returns null when no question carries the filtered topic", () => {
    const bank = [question({ id: "a", topic: "taste" })];
    const nothing = pick(bank, state({ filters: { depth: "auto", topic: "memory" } }), "stay", first);
    expect(nothing.question).toBeNull();
  });

  it("clears the question on screen when the pool is empty", () => {
    const bank = [question({ id: "a", topic: "taste" })];
    const emptied = advance(
      bank,
      state({ current: bank[0], filters: { depth: "auto", topic: "memory" } }),
      "filter",
      first,
    );
    expect(emptied.current).toBeNull();
    expect(emptied.history).toEqual([]);
  });

  it("lets a pinned depth filter override the walked depth", () => {
    const bank = [question({ id: "one", depth: 1 }), question({ id: "three", depth: 3 })];
    const pinned = pick(bank, state({ depth: 1, filters: { depth: 3, topic: "any" } }), "stay", first);
    expect(pinned.question?.id).toBe("three");
  });

  it("never serves the question already on screen", () => {
    const bank = [question({ id: "a" }), question({ id: "b" })];
    expect(pick(bank, state({ current: bank[0] }), "skip", first).question?.id).toBe("b");
  });

  it("records every served question in history", () => {
    const bank = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
    let walked = advance(bank, state(), "stay", first);
    walked = advance(bank, walked, "stay", first);
    expect(walked.history).toEqual(["a", "b"]);
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
