import { describe, expect, it } from "vitest";
import { definedIn, kindsOf, searchTerms, type Term } from "./lib";

function term(over: Partial<Term> = {}): Term {
  return {
    term: "batch",
    kind: "concept",
    definition: "a set of todos that share one purpose",
    specSection: "5.4",
    related: [],
    ...over,
  };
}

describe("definedIn", () => {
  it("names the spec section, and the code symbol beside it", () => {
    expect(definedIn(term())).toBe("spec §5.4");
    expect(definedIn(term({ codeSymbol: "convex/ttsShared.ts TTS_CLOSED_VOCABULARY" })))
      .toBe("spec §5.4 · convex/ttsShared.ts TTS_CLOSED_VOCABULARY");
  });

  it("says the code for a word the spec does not define", () => {
    expect(definedIn(term({ specSection: undefined }))).toBe("the code");
  });
});

describe("kindsOf", () => {
  it("lists each kind once, sorted", () => {
    expect(kindsOf([term(), term({ kind: "channel" }), term({ kind: "concept" })]))
      .toEqual(["channel", "concept"]);
  });
});

describe("searchTerms", () => {
  const terms = [
    term(),
    term({ term: "#tts", kind: "refused", definition: "not a TTS word", refusedFor: "#tts-today" }),
    term({ term: "ruling", definition: "his decision, carrying one of four verdicts" }),
  ];

  it("matches the word, its definition, and what a refused word points to", () => {
    expect(searchTerms(terms, "all", "todos").map((x) => x.term)).toEqual(["batch"]);
    expect(searchTerms(terms, "all", "verdict").map((x) => x.term)).toEqual(["ruling"]);
    expect(searchTerms(terms, "all", "#tts-today").map((x) => x.term)).toEqual(["#tts"]);
  });

  it("narrows by kind and by query together", () => {
    expect(searchTerms(terms, "refused", "").map((x) => x.term)).toEqual(["#tts"]);
    expect(searchTerms(terms, "concept", "#tts-today")).toEqual([]);
  });

  it("shows everything for an empty query", () => {
    expect(searchTerms(terms, "all", "   ")).toHaveLength(3);
  });
});
