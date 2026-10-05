// Who decided, and the option an answer of Tom's names (shared/decided-by.mjs):
// the record's check of a decision by Tom and the box's mapping of his reply
// read this one function, so they cannot disagree on what a reply names.

import { describe, expect, it } from "vitest";
import { askShown, decidedByText, decisionOfAnswer, optionNamed } from "../decided-by.mjs";

const OPTIONS = ["Move it to Thursday morning.", "Leave it Wednesday."];

describe("optionNamed", () => {
  it("reads a letter in the forms a reply takes", () => {
    for (const said of ["b", "B", "b)", "(b)", "b.", "option b", " b "]) {
      expect(optionNamed(said, OPTIONS)).toBe("Leave it Wednesday.");
    }
    expect(optionNamed("c", OPTIONS)).toBeNull();
  });

  it("reads an option's own words, case and a closing stop aside", () => {
    expect(optionNamed("leave it wednesday", OPTIONS)).toBe("Leave it Wednesday.");
    expect(optionNamed("Move it to Thursday morning!", OPTIONS)).toBe("Move it to Thursday morning.");
    expect(optionNamed("Ask the consulate first.", OPTIONS)).toBeNull();
  });

  it("makes his own words the decision when they name no option", () => {
    expect(decisionOfAnswer("a", OPTIONS)).toBe("Move it to Thursday morning.");
    expect(decisionOfAnswer("  Ask the consulate first. ", OPTIONS)).toBe("Ask the consulate first.");
  });
});

describe("askShown", () => {
  it("letters the options in order after the question", () => {
    expect(askShown(" Move it? ", OPTIONS)).toBe("Move it? Options: a) Move it to Thursday morning; b) Leave it Wednesday.");
  });
});

describe("decidedByText", () => {
  it("names Tom, or the delegate after its wait, in whole minutes", () => {
    expect(decidedByText(true, 180_000)).toBe("decided by Tom after 3 minutes");
    expect(decidedByText(true, 60_000)).toBe("decided by Tom after 1 minute");
    expect(decidedByText(true, undefined)).toBe("decided by Tom");
    expect(decidedByText(false, 7_200_000)).toBe("decided by the delegate after waiting 120 minutes");
    expect(decidedByText(false, 0)).toBe("decided by the delegate after waiting 0 minutes");
    expect(decidedByText(false, 90_000)).toBe("decided by the delegate after waiting 2 minutes");
  });

  it("says nothing for a delegate decision with no recorded wait", () => {
    expect(decidedByText(false, undefined)).toBeNull();
    expect(decidedByText(false, null)).toBeNull();
    expect(decidedByText(false, -5)).toBeNull();
  });
});
