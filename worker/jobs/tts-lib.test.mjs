import { describe, it, expect } from "vitest";
import { skippedRowIds } from "./tts-lib.mjs";

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
