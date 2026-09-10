// The ground signal is code, not judgment. The table below is the whole
// contract: sentences Tom actually typed (drawn from WikiTom's
// evidence/ground.md) on the left, the signal they produce on the right — and
// the sentences that produce NOTHING, which is the point of the file.
import { describe, expect, it } from "vitest";
import {
  GROUND_SIGNALS_MAX,
  cleanTerm,
  groundSectionFollows,
  groundSignals,
  isGroundConfirmedSection,
  sentenceSignal,
  sentencesOf,
} from "./learning-ground.mjs";

/** The signals one text of Tom's produces, as [kind, term] pairs. */
function signalsOf(text) {
  const sentences = sentencesOf(text);
  return sentences
    .map((s, i) => sentenceSignal(s, sentences[i + 1] ?? ""))
    .filter((s) => s !== null)
    .map((s) => [s.kind, s.term]);
}

describe("the ground signal", () => {
  const table = [
    ["What is a full overwrite versus merge? Why should I care about this at all?", [["asked", "full overwrite versus merge"]]],
    ["I've never heard of Fourier mass before.", [["asked", "fourier mass"]]],
    ["I don't understand the drain semantics question.", [["asked", "drain semantics question"]]],
    ["What are shards?", [["asked", "shards"]]],
    // A7 wins over B2: the negation family runs first, so a sentence that
    // denies a term and claims another cannot confirm on the strength of the
    // claim. The term is null — the model reads it off the sentence.
    ["That is not a term I recognize, and I am intimately familiar with CMT.", [["asked", null]]],
    ["I understand the vocab you defined so use that and other standard cmt language.", [["confirmed", "vocab you defined"]]],
    ["im an expert in climbing vocab.", [["confirmed", "climbing vocab"]]],
    ["i understand these intuitively but im not fluent in the math.", [["partial", "these intuitively"]]],
    [
      "I have a strong intuitive understanding of these. similar to the statistics, if you talk to me like an expert i can probably intuitively follow what you're saying but might not know all the details.",
      [["partial", "these"]],
    ],
    ["I understand arity and function structure, but tell me more about sampling geometry", [["confirmed", "arity and function structure"]]],
    // Fluent use is not a signal. There is no pattern for it, on purpose.
    ["the AUROC at mad_quirky is 0.81 and the residual stream probe agrees", []],
    ["run git rebase then push", []],
    ["explain every mathematical concept as you introduce it", [["asked", "every mathematical concept"]]],
    // The term is a stop term, so the signal names nothing and is dropped.
    ["i dont know what to do about it.", []],
  ];
  for (const [text, expected] of table) {
    it(`reads ${JSON.stringify(text.slice(0, 60))}`, () => {
      expect(signalsOf(text)).toEqual(expected);
    });
  }

  it("downgrades a confirmation hedged in the sentence after it, once", () => {
    const out = signalsOf("i understand these. but i might not know all the details.");
    expect(out).toEqual([["partial", "these"]]);
  });

  it("drops a term that is empty, too long, a stop term or a clause", () => {
    expect(cleanTerm("  ")).toBeNull();
    expect(cleanTerm("x".repeat(200))).toBeNull();
    expect(cleanTerm("it")).toBeNull();
    expect(cleanTerm("what you mean")).toBeNull();
    expect(cleanTerm("why the sweep failed")).toBeNull();
    expect(cleanTerm("`the residual stream`?")).toBe("residual stream");
    expect(cleanTerm("Fourier mass is")).toBe("fourier mass");
  });
});

describe("groundSignals", () => {
  const turn = (over = {}) => ({
    id: "t1",
    sessionId: "k97",
    sdkSessionId: "47f04bc9-1111-2222-3333-444444444444",
    text: "What are shards?",
    at: Date.UTC(2026, 8, 8, 12),
    replyBefore: "A shard is one slice of a sharded filesystem.",
    replyAfter: "I have explained shards, so he knows shards now.",
    ...over,
  });
  const cite = (t) => `session ${String(t.sdkSessionId).slice(0, 8)}`;
  const day = (at) => new Date(at).toISOString().slice(0, 10);

  it("reads Tom's words and never the agent's", () => {
    const { signals } = groundSignals({ tomTurns: [turn()] }, { cite, day });
    expect(signals).toEqual([
      {
        id: "g-1",
        kind: "asked",
        term: "shards",
        source: "session 47f04bc9",
        date: "2026-09-08",
        quote: "What are shards?",
      },
    ]);
    // The agent's own explanation — "I have explained shards, so he knows
    // shards now" — is not scanned at all.
    const onlyAgent = groundSignals({ tomTurns: [turn({ text: "ok" })] }, { cite, day });
    expect(onlyAgent.signals).toEqual([]);
  });

  it("reads his Slack replies and his rulings' sentences too", () => {
    const { signals } = groundSignals(
      {
        tomTurns: [],
        slackReplies: [
          { at: Date.UTC(2026, 8, 8, 13), data: { ts: "1757300000.001", text: "I've never heard of Fourier mass before." } },
        ],
        rulings: [{ id: "rul1", at: Date.UTC(2026, 8, 8, 14), sentence: "im an expert in climbing vocab." }],
      },
      { cite, day },
    );
    expect(signals.map((s) => [s.kind, s.term, s.source])).toEqual([
      ["confirmed", "climbing vocab", "ruling rul1"],
      ["asked", "fourier mass", "thread 1757300000.001"],
    ]);
  });

  it("keeps the newest and counts what it dropped", () => {
    const many = Array.from({ length: GROUND_SIGNALS_MAX + 5 }, (_, i) =>
      turn({ id: `t${i}`, text: `What is term${i}?`, at: Date.UTC(2026, 8, 8, 0) + i * 1000 }),
    );
    const { signals, dropped } = groundSignals({ tomTurns: many }, { cite, day });
    expect(signals).toHaveLength(GROUND_SIGNALS_MAX);
    expect(dropped).toBe(5);
    // Newest first, and numbered in that order.
    expect(signals[0].term).toBe(`term${GROUND_SIGNALS_MAX + 4}`);
    expect(signals[0].id).toBe("g-1");
  });
});

describe("the sections a signal supports", () => {
  it("maps each kind to the sections a change may name", () => {
    expect(groundSectionFollows("asked", "Does not know")).toBe(true);
    expect(groundSectionFollows("asked", "Knows")).toBe(true);
    expect(groundSectionFollows("confirmed", "Knows")).toBe(true);
    expect(groundSectionFollows("confirmed", "Follows, without the details")).toBe(false);
    expect(groundSectionFollows("partial", "Follows, without the details")).toBe(true);
    expect(groundSectionFollows("partial", "Knows")).toBe(false);
    // How to explain takes a change from any kind: it is a rule about
    // writing, not a claim about a term.
    for (const kind of ["asked", "confirmed", "partial"]) {
      expect(groundSectionFollows(kind, "How to explain")).toBe(true);
    }
  });

  it("names the two sections no line reaches on inference", () => {
    expect(isGroundConfirmedSection("Knows")).toBe(true);
    expect(isGroundConfirmedSection("follows, without the details")).toBe(true);
    expect(isGroundConfirmedSection("Does not know")).toBe(false);
  });
});
