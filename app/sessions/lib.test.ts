// The two readers the sessions page added with the lifeos update (phase 7),
// both of which read something ANOTHER file wrote and could drift from it
// silently.
//
//   modelOfTomHeadOf reads back the header convex/ttsSkills.ts writes at the
//   head of every session opener — the WikiTom commit the model-of-tom files
//   were read at, and their paths. It is pinned here against the writer
//   itself, not against a copy of its format: a change to modelOfTomText that
//   this reader does not follow would otherwise show a transcript's first row
//   with no commit on it and nothing would fail.
//
//   describeOverflow says how much of a cut payload came back and whether it
//   can be trusted. Its claims are deliberately different strengths — verified
//   against the hash, summed across pages, and the two ways a payload comes
//   back wrong — and the wrong one is a lie about completeness, the exact
//   thing the overflow path exists to prevent.

import { describe, expect, it } from "vitest";
import { modelOfTomText } from "@/convex/ttsSkills";
import { describeOverflow, modelOfTomHeadOf } from "./lib";

describe("modelOfTomHeadOf", () => {
  it("reads back the commit and paths the prompt writer puts in the header", () => {
    const prompt = modelOfTomText({
      commit: "abc1234def5678",
      syncedAt: 1,
      pushed: true,
      files: [
        { path: "model-of-tom/writing.md", body: "the standard" },
        { path: "model-of-tom/priorities.md", body: "what matters" },
      ],
    });
    expect(modelOfTomHeadOf(prompt)).toEqual({
      commit: "abc1234def5678",
      paths: ["model-of-tom/writing.md", "model-of-tom/priorities.md"],
    });
  });

  it("says no commit was recorded when the fallback copy is serving", () => {
    const prompt = modelOfTomText({ commit: null, syncedAt: null, pushed: null, files: [] });
    // The fallback header IS the model-of-tom header, so the row still marks
    // itself as the prelude — with nothing to name.
    expect(modelOfTomHeadOf(prompt)).toEqual({ commit: null, paths: [] });
  });

  it("is null for an ordinary prompt", () => {
    expect(modelOfTomHeadOf("Work the batch below with Tom.")).toBeNull();
    expect(modelOfTomHeadOf("")).toBeNull();
  });
});

describe("describeOverflow", () => {
  const base = { bytes: 0, byteLength: 100, end: false, complete: false, reads: 1, reading: false };

  it("says complete only when the server checked the hash", () => {
    expect(
      describeOverflow({ ...base, bytes: 100, end: true, complete: true }),
    ).toBe("complete — 100 bytes, checked against the stored hash");
  });

  // witness: let the paged case borrow the word "complete" alone — the page
  // would claim a verification that was never performed.
  it("says the bytes summed, and that the hash was not re-checked, across pages", () => {
    const said = describeOverflow({
      ...base,
      bytes: 100,
      end: true,
      reads: 3,
    });
    expect(said).toContain("complete — 100 bytes in 3 reads");
    expect(said).toContain("the hash is checked only when");
  });

  // witness: let the paged sentence answer for a single read too — a payload
  // whose stored hash did NOT match would be announced as complete, which is
  // the one thing this function exists to make impossible. The server computes
  // `complete` as the hash comparison itself and only ever on a whole read
  // from index 0, so complete:false here is a mismatch, not an unasked
  // question.
  it("says the bytes do not match the stored hash when one whole read fails the check", () => {
    expect(
      describeOverflow({
        ...base,
        bytes: 100,
        end: true,
        reads: 1,
        complete: false,
      }),
    ).toBe(
      "incomplete — 100 bytes came back but they do not match the stored hash",
    );
  });

  it("says incomplete, and why, when a chunk is missing", () => {
    expect(describeOverflow({ ...base, bytes: 40, end: false })).toBe(
      "incomplete — the stored chunks stop after 40 of 100 bytes; one is missing",
    );
  });

  it("says incomplete when the bytes do not sum to the row's stamp", () => {
    expect(describeOverflow({ ...base, bytes: 40, end: true })).toBe(
      "incomplete — 40 of 100 bytes came back",
    );
  });

  it("says what it has while a read is in flight", () => {
    expect(describeOverflow({ ...base, bytes: 40, reading: true })).toBe(
      "reading — 40 of 100 bytes so far",
    );
  });
});
