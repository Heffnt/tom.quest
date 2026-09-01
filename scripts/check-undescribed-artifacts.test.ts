import { describe, expect, it } from "vitest";
// @ts-expect-error — the checker is plain Node ESM with no type declarations;
// it is a script, not app code, and importing it here is what fences its rule.
import {
  artifactTokens,
  undescribed,
  visibleText,
} from "./check-undescribed-artifacts.mjs";

// The rule under test: WRITING_STANDARD (convex/ttsShared.ts) says an artifact
// an agent made — a file, a branch, a directory, a job — must be described
// before it is named, because the reader has no knowledge of it. The checker
// reads stored prose and reports the names that arrive undescribed. These cases
// are the two directions it must not get wrong: a bare name is reported, and a
// name with its description beside it is not.
//
// witness: delete "file" from the DESCRIPTOR list in
// scripts/check-undescribed-artifacts.mjs and the second case goes red.

describe("check-undescribed-artifacts", () => {
  it("reports a path named with nothing saying what it is", () => {
    expect(undescribed("brief", "The fix lands at cmt/sweep/runner.py:41.")).toEqual([
      "cmt/sweep/runner.py",
    ]);
  });

  it("accepts a path whose kind is named beside it", () => {
    expect(
      undescribed(
        "brief",
        "The file cmt/sweep/runner.py, which starts one sweep per configuration, gets the fix.",
      ),
    ).toEqual([]);
  });

  it("accepts a path described in place by a copular sentence", () => {
    expect(
      undescribed(
        "brief",
        "app/boolback/lib/anatomy.ts is the pure math behind the anatomy view, and it gains one export.",
      ),
    ).toEqual([]);
  });

  it("counts one token per name, longest match at a position", () => {
    const tokens = artifactTokens("touching app/tts/lib.ts twice: app/tts/lib.ts");
    expect(tokens.map((t: { token: string }) => t.token)).toEqual(["app/tts/lib.ts"]);
  });

  it("reports a session branch and a Convex function reference", () => {
    expect(
      undescribed(
        "brief",
        "Merge session/q975a307c34b9d0e1f2a and internal.gpuPool.reconcile follows.",
      ),
    ).toEqual(["session/q975a307c34b9d0e1f2a", "internal.gpuPool.reconcile"]);
  });

  it("reads only the visible text of a ground-up explanation", () => {
    const doc =
      "<!DOCTYPE html><html><head><style>body{background:#0a0e17}</style></head>" +
      "<body><p>The fix lands at <code>cmt/sweep/runner.py</code>.</p></body></html>";
    expect(visibleText("groundUpExplanation", doc)).not.toContain("#0a0e17");
    expect(undescribed("groundUpExplanation", doc)).toEqual(["cmt/sweep/runner.py"]);
  });
});
