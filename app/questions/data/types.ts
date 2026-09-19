// The question bank's shape, and the bank itself.
//
// `source` and `why` are editorial notes — where a question came from and what
// it is meant to open up. They are in the data because they are how the bank is
// maintained; the page never renders either of them.

import bank from "./bank.json";

/** How far in a question reaches. 1 opens, 2 presses, 3 is the one you earn. */
export type Depth = 1 | 2 | 3;

/** The shape of the asking, which is what rotation varies so two questions in a row do not land the same way. */
export type Frame = "hypothetical" | "observation" | "appraisal" | "value";

export type Question = {
  id: string;
  text: string;
  depth: Depth;
  frame: Frame;
  topic: string;
  /** True for a light question, which is what "lighten" serves and the depth walk never does. */
  release: boolean;
  source: string;
  why: string;
};

// An assertion and not a `satisfies` check: JSON.parse's type widens `depth` to
// `number` and `frame` to `string`, and no structural check narrows those back.
// The bank is committed alongside this file, so the shape is verified by reading
// it, not by the type system.
export const BANK = bank as Question[];
