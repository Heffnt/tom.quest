import { describe, expect, it } from "vitest";
import type { Doc } from "@/convex/_generated/dataModel";
import { kindsOf, termRows, versionRow, type Term } from "./lib";

function term(over: Partial<Term> = {}): Term {
  return {
    term: "task",
    kind: "concept",
    definition: "work an agent or Tom performs",
    specSection: "5.1",
    related: ["todo"],
    ...over,
  };
}

const TERMS = [
  term(),
  term({ term: "#tts", kind: "refused", definition: "not a TTS word", specSection: "12.1", related: ["#tts-today"], refusedFor: "#tts-today" }),
  term({ term: "ruling", definition: "his decision, carrying one of four verdicts", related: [] }),
];

function row(over: Partial<Doc<"ttsVocabulary">> = {}): Doc<"ttsVocabulary"> {
  return {
    _id: "id" as Doc<"ttsVocabulary">["_id"],
    _creationTime: 0,
    key: "current",
    version: "470c0ad78493ac8f",
    commit: "a".repeat(40),
    committedAt: 0,
    generatedAt: 0,
    wrote: false,
    terms: TERMS,
    disagreements: [],
    ...over,
  };
}

describe("kindsOf", () => {
  it("lists each kind once, sorted", () => {
    expect(kindsOf(TERMS)).toEqual(["concept", "refused"]);
  });
});

describe("versionRow", () => {
  it("prints the header from every field the row carries", () => {
    expect(versionRow(row({
      counts: { entities: 17, jobs: 35, search: 15, skills: 16, repos: 9, channels: 7 },
      tomQuestCommit: "b".repeat(40),
    }))).toBe(
      `vocabulary/@version 470c0ad78493ac8f terms=3 entities=17 jobs=35 search=15 skills=16 repos=9 channels=7 wikitom=${"a".repeat(40)} tom.quest=${"b".repeat(40)}`,
    );
  });

  // A row posted before the nightly sends the header fields has only the
  // terms and its WikiTom commit; nothing else is guessed.
  it("leaves out what a row posted before the widening does not carry", () => {
    expect(versionRow(row())).toBe(`vocabulary/@version 470c0ad78493ac8f terms=3 wikitom=${"a".repeat(40)}`);
  });
});

describe("termRows", () => {
  it("prints every term of the picked kind, with the posted section", () => {
    expect(termRows(row({ section: "12.1" }), "refused", "")).toEqual([
      "vocabulary/#tts 12.1 kind=refused definition=\"not a TTS word\" spec=§12.1 related=#tts-today refused-for=#tts-today",
    ]);
    expect(termRows(row(), "all", "  ")).toHaveLength(3);
  });

  it("never prints a section the row does not carry", () => {
    expect(termRows(row(), "all", "")[0]).toBe(
      "vocabulary/task kind=concept definition=\"work an agent or Tom performs\" spec=§5.1 related=todo",
    );
  });

  it("answers a typed word the way define does, whatever kind is picked", () => {
    expect(termRows(row({ section: "12.1" }), "refused", "Ruling")).toEqual([
      "vocabulary/ruling 12.1 kind=concept definition=\"his decision, carrying one of four verdicts\" spec=§5.1",
    ]);
    expect(termRows(row({ section: "12.1" }), "all", "verdicts")).toEqual([
      "vocabulary/verdicts unknown\n  did you mean  vocabulary/ruling 12.1 kind=concept definition=\"his decision, carrying one of four verdicts\" spec=§5.1",
    ]);
    expect(termRows(row(), "all", "nothing")).toEqual([
      "vocabulary/nothing unknown\n  no term's definition carries \"nothing\"",
    ]);
  });
});
