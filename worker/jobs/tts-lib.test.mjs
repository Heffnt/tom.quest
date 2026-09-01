// Tests for the shared brief-clipping rule in tts-lib.mjs.
//
// This rule used to be spelled twice — once in plan-graphs.mjs (with an
// ellipsis marker and an empty-text case) and once in form-batches.mjs (a bare
// slice with neither) — so the same brief reached the model in two forms
// depending on which planner read it. These three cases are exactly the ones
// the two old spellings disagreed about, so they are what a re-split would
// break first.

import { describe, expect, it } from "vitest";

import { clip, MAX_BRIEF_CHARS, MAX_LIFE_PER_RUN } from "./tts-lib.mjs";

describe("clip", () => {
  it("returns text shorter than the limit unchanged and unmarked", () => {
    expect(clip("a short brief", MAX_BRIEF_CHARS)).toBe("a short brief");
  });

  it("returns text exactly at the limit unchanged and unmarked", () => {
    const exact = "x".repeat(MAX_BRIEF_CHARS);
    expect(clip(exact, MAX_BRIEF_CHARS)).toBe(exact);
  });

  it("cuts text over the limit and marks the cut with an ellipsis", () => {
    const long = "y".repeat(MAX_BRIEF_CHARS + 50);
    const clipped = clip(long, MAX_BRIEF_CHARS);
    expect(clipped).toBe(`${"y".repeat(MAX_BRIEF_CHARS)}…`);
    // The marker is appended after the slice, so the result is one character
    // longer than the limit. The limit bounds the source text, not the output.
    expect(clipped).toHaveLength(MAX_BRIEF_CHARS + 1);
  });

  it("maps empty and missing text to null, never to an empty string", () => {
    // A blank field would read to the model as a claim that the todo HAS an
    // empty brief; null drops the field from the JSON instead.
    expect(clip("", MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(undefined, MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(null, MAX_BRIEF_CHARS)).toBeNull();
  });

  it("honours a caller-supplied limit other than MAX_BRIEF_CHARS", () => {
    // plan-graphs.mjs calls the same function with its preview limits.
    expect(clip("abcdef", 3)).toBe("abc…");
  });
});

describe("planner input bounds", () => {
  it("holds the values both planners were spelling separately", () => {
    expect(MAX_LIFE_PER_RUN).toBe(80);
    expect(MAX_BRIEF_CHARS).toBe(400);
  });
});
