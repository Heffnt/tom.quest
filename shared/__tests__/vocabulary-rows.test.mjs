// The vocabulary rows, pinned to what the box's `tts-search` printed on
// 2026-09-25. Each expected string below is the CLI's own output, copied, and
// each input is that CLI's `--json` for the same word: a formatter that drifts
// from the CLI fails here before the /vocabulary page shows Tom a row no agent
// was shown. The definitions are the spec's (WikiTom tts/spec.md §12.1), not
// his model-of-tom pages.

import { describe, expect, it } from "vitest";

import {
  defineTerm,
  formatTermRow,
  formatUnknownTerm,
  formatVersionRow,
  NEAR_MISSES,
  singleLine,
} from "../vocabulary-rows.mjs";

const RULING = {
  term: "ruling",
  kind: "concept",
  definition: "Tom's decision, carrying exactly one of four verdicts: **`approve`**, **`revise`**, **`session`**, **`archive`**. The same four words on a code brief (§5.3) and everywhere else. Written from Tom's own sentence, never typed by him as a word (§7).",
  specSection: "5.3",
  codeSymbol: "convex/schema.ts:dtsRulings",
  related: ["session"],
  refusedFor: null,
};
const TRANSCRIPT = {
  term: "transcript",
  kind: "concept",
  definition: "an agent's recorded rows: every prompt, injected file, attachment, tool input and output, verdict, and child agent, expandable in full (§20.1, §23.2).",
  specSection: "20.1",
  codeSymbol: "convex/schema.ts:runFileVersions",
  related: ["agent", "child agent"],
  refusedFor: null,
};
const TTS = {
  term: "#tts",
  kind: "refused",
  definition: "not a TTS word — `#tts-today`",
  specSection: "12.1",
  codeSymbol: null,
  related: ["#tts-today"],
  refusedFor: "#tts-today",
};
const TERMS = [TTS, RULING, TRANSCRIPT];

describe("formatTermRow", () => {
  it("prints `tts-search define ruling` exactly", () => {
    expect(formatTermRow({ section: "12.1", term: RULING })).toBe(
      "vocabulary/ruling 12.1 kind=concept definition=\"Tom's decision, carrying exactly one of four verdicts: **`approve`**, **`revise`**, **`session`**, **`archive`**. The same four words on a code brief (§5.3) and everywhere else. Written from Tom's own sentence, never typed by him as a word (§7).\" spec=§5.3 code=convex/schema.ts:dtsRulings related=session",
    );
  });

  it("prints a refused word with the word it points at last", () => {
    expect(formatTermRow({ section: "12.1", term: TTS })).toBe(
      "vocabulary/#tts 12.1 kind=refused definition=\"not a TTS word — `#tts-today`\" spec=§12.1 related=#tts-today refused-for=#tts-today",
    );
  });

  it("leaves the section column out when the reader does not know it", () => {
    expect(formatTermRow({ term: TTS })).toBe(
      "vocabulary/#tts kind=refused definition=\"not a TTS word — `#tts-today`\" spec=§12.1 related=#tts-today refused-for=#tts-today",
    );
  });
});

describe("defineTerm and formatUnknownTerm", () => {
  it("finds a word whatever its case", () => {
    expect(defineTerm(TERMS, "RULING")).toEqual({ found: RULING, candidates: [] });
  });

  it("prints `tts-search define verdict` exactly", () => {
    const { found, candidates } = defineTerm(TERMS, "verdict");
    expect(found).toBeNull();
    expect(formatUnknownTerm({ section: "12.1", term: "verdict", candidates })).toBe([
      "vocabulary/verdict unknown",
      "  did you mean  vocabulary/ruling 12.1 kind=concept definition=\"Tom's decision, carrying exactly one of four verdicts: **`approve`**, **`revise`**, **`session`**, **`archive`**. The same four words on a code brief (§5.3) and everywhere else. Written from Tom's own sentence, never typed by him as a word (§7).\" spec=§5.3 code=convex/schema.ts:dtsRulings related=session",
      "  did you mean  vocabulary/transcript 12.1 kind=concept definition=\"an agent's recorded rows: every prompt, injected file, attachment, tool input and output, verdict, and child agent, expandable in full (§20.1, §23.2).\" spec=§20.1 code=convex/schema.ts:runFileVersions related=agent,child agent",
    ].join("\n"));
  });

  it("prints `tts-search define rulingz` exactly", () => {
    const { candidates } = defineTerm(TERMS, "rulingz");
    expect(formatUnknownTerm({ section: "12.1", term: "rulingz", candidates }))
      .toBe("vocabulary/rulingz unknown\n  no term's definition carries \"rulingz\"");
  });

  it("lists at most NEAR_MISSES, sorted by word", () => {
    const many = Array.from({ length: NEAR_MISSES + 2 }, (_, index) => ({
      ...TRANSCRIPT,
      term: `w${NEAR_MISSES + 2 - index}`,
    }));
    const { candidates } = defineTerm(many, "recorded");
    expect(candidates.map((term) => term.term)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  it("offers nothing for an empty word", () => {
    expect(defineTerm(TERMS, "")).toEqual({ found: null, candidates: [] });
  });
});

describe("formatVersionRow", () => {
  it("prints the `tts-search vocabulary` header exactly", () => {
    expect(formatVersionRow({
      version: "470c0ad78493ac8f",
      counts: { terms: 117, entities: 17, jobs: 35, search: 15, skills: 16, repos: 9, channels: 7 },
      wikitom: "6b2f4f1cb409eeb5f5482c1f851970f53995bba1",
      tomQuest: "1305fc85b5f07cc509bdbdafe5b5400300d334d5",
    })).toBe(
      "vocabulary/@version 470c0ad78493ac8f terms=117 entities=17 jobs=35 search=15 skills=16 repos=9 channels=7 wikitom=6b2f4f1cb409eeb5f5482c1f851970f53995bba1 tom.quest=1305fc85b5f07cc509bdbdafe5b5400300d334d5",
    );
  });

  it("leaves out a count or commit it was not given", () => {
    expect(formatVersionRow({ version: "v1", counts: { terms: 3 }, wikitom: "abc" }))
      .toBe("vocabulary/@version v1 terms=3 wikitom=abc");
  });
});

describe("singleLine", () => {
  it("keeps a row on one line", () => {
    expect(singleLine("a\nb\tc   d\\")).toBe("a\\nb\\tc d\\\\");
  });
});
