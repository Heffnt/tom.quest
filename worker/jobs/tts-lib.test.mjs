import { describe, it, expect } from "vitest";
import { skippedRowIds, proposedRowIds } from "./tts-lib.mjs";

// The skip report returned by POST /tts/batches is the ONLY thing that tells a
// worker whether the write it asked for landed on a given row. These tests fix
// the rule that a caller reads `id` (identity) and never `ref` (display text).
describe("skippedRowIds", () => {
  // witness: in form-batches.mjs, match a revise ruling's todoId against
  // `s.ref` instead of `s.id` — a skipped batch rewrite would be read as
  // stored and Tom's revise sentence would be retired without ever being
  // served.
  it("collects the id of a skipped rewrite, whose ref is the model's NEW statement", () => {
    const skipped = [
      {
        ref: "visa paperwork", // what the model just wrote
        why: "Tom-touched (frozen)",
        id: "batch-id-1", // the row that was refused
      },
    ];
    const ids = skippedRowIds(skipped);
    expect(ids.has("batch-id-1")).toBe(true);
    // The statement the batch had BEFORE the rewrite is nowhere in the report,
    // which is exactly why matching on text cannot work.
    expect(ids.has("trip logistics")).toBe(false);
    expect(ids.has("visa paperwork")).toBe(false);
  });

  it("collects the id of a skipped archive", () => {
    const ids = skippedRowIds([
      { ref: "batch-id-2", why: "Tom-touched (frozen)", id: "batch-id-2" },
    ]);
    expect([...ids]).toEqual(["batch-id-2"]);
  });

  it("holds nothing for a skipped BRAND-NEW batch (there is no row to name)", () => {
    const ids = skippedRowIds([
      { ref: "taker", why: 'code X y is already in batch "holder"' },
    ]);
    expect(ids.size).toBe(0);
  });

  it("tolerates an absent or malformed report", () => {
    expect(skippedRowIds(undefined).size).toBe(0);
    expect(skippedRowIds([]).size).toBe(0);
    expect(skippedRowIds([null, { ref: "x", why: "y", id: 7 }]).size).toBe(0);
  });
});

// The skip report says which rows were REFUSED. It cannot say which rows the
// model addressed at all, and a row nobody addressed is stored nowhere and
// skipped nowhere. These tests fix the rule that "did my instruction land on
// row X" is answered by the model's own answer first, the skip report second.
describe("proposedRowIds", () => {
  // witness: in form-batches.mjs, consume a batch-revise ruling on the mere
  // absence of a skip — a run whose answer omits the batch entirely retires
  // Tom's sentence while the batch keeps the grouping he asked to change.
  it("holds the ids the answer addressed, and nothing for a batch it ignored", () => {
    const ids = proposedRowIds(
      [
        { id: "batch-rewritten", statement: "visa paperwork", members: [] },
        { statement: "a brand-new grouping", members: [] },
      ],
      ["batch-retired"],
    );
    expect([...ids].sort()).toEqual(["batch-retired", "batch-rewritten"]);
    expect(ids.has("batch-ignored")).toBe(false);
  });

  it("holds nothing for an answer of only new batches", () => {
    expect(proposedRowIds([{ statement: "new", members: [] }], []).size).toBe(0);
  });

  it("tolerates an absent or malformed answer", () => {
    expect(proposedRowIds(undefined, undefined).size).toBe(0);
    expect(proposedRowIds([null, { id: 7 }, { id: "" }], [null, "", 7]).size).toBe(
      0,
    );
  });
});
