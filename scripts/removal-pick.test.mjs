import { describe, expect, it } from "vitest";

import { branchFor, pickOne, rank } from "./removal-pick.mjs";
import { keyOf } from "./removal-sensor.mjs";

const v = (ruleId, path, fingerprint, lines, files) => ({ ruleId, path, fingerprint, lines, files, line: 1, text: "" });

describe("the removal loop's controller", () => {
  const big = v("duplicated-helper", "app/a.ts", "aaaaaaaa", 12, 2);
  const oneLine = v("dead-export", "app/z.ts", "bbbbbbbb", 1, 1);
  const oneLineEarlier = v("dead-export", "app/b.ts", "cccccccc", 1, 1);
  const twoFiles = v("check-not-deletion", "app/c.ts", "dddddddd", 1, 2);

  it("ranks by lines, then files, then rule, path and fingerprint", () => {
    expect(rank([big, twoFiles, oneLine, oneLineEarlier])).toEqual([oneLineEarlier, oneLine, twoFiles, big]);
  });

  it("breaks a tie the same way whatever order it was handed", () => {
    const a = rank([oneLine, oneLineEarlier]);
    const b = rank([oneLineEarlier, oneLine]);
    expect(a).toEqual(b);
  });

  it("picks only a baseline violation, and skips an excluded one", () => {
    const all = [big, oneLine, oneLineEarlier];
    const baseline = [big, oneLine].map(keyOf);
    expect(pickOne(all, baseline)).toBe(oneLine);
    expect(pickOne(all, baseline, ["dead-export-bbbbbbbb"])).toBe(big);
    expect(pickOne(all, [], [])).toBeNull();
  });

  it("names the branch by rule and fingerprint", () => {
    expect(branchFor(big)).toBe("loop/removals/duplicated-helper-aaaaaaaa");
  });
});
