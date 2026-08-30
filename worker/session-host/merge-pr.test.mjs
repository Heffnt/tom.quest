// tts-merge-pr decides whether an agent may merge unattended. In this repo a
// merge to main is a production Convex deploy, so both helpers below are
// security boundaries and their fail-open modes are the ones worth pinning:
// an empty allowlist that reads as "anything", and an empty check list that
// reads as "nothing failed".

import { describe, expect, it } from "vitest";

import { allowedBases, checksVerdict } from "./merge-pr.mjs";

describe("allowedBases", () => {
  // THE ONE THAT MATTERS. Unset, empty, or whitespace must mean "no base is
  // allowed", never "no restriction". This is the default state of the box.
  it.each([undefined, null, "", "   ", ",", " , , "])(
    "reads %j as no bases allowed",
    (raw) => {
      expect(allowedBases(raw)).toEqual([]);
    },
  );

  it("parses a list, tolerating spacing", () => {
    expect(allowedBases("overnight")).toEqual(["overnight"]);
    expect(allowedBases(" overnight , staging ")).toEqual([
      "overnight",
      "staging",
    ]);
  });

  // main is not special-cased in code — it is allowed only if Tom literally
  // writes it, which is the point. This test exists so that stays deliberate.
  it("allows main only when explicitly listed", () => {
    expect(allowedBases("overnight")).not.toContain("main");
    expect(allowedBases("overnight,main")).toContain("main");
  });
});

describe("checksVerdict", () => {
  // THE OTHER FAIL-OPEN. gh returns [] both when a repo has no CI and when
  // the checks have not been created yet. An agent asks seconds after
  // pushing, so "empty means green" would merge before the tests start.
  it.each([[[]], [undefined], [null]])("refuses when no checks are reported (%j)", (rollup) => {
    const v = checksVerdict(rollup);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/no CI checks/i);
  });

  it("refuses while a check is still running", () => {
    const v = checksVerdict([
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "guardrails", status: "IN_PROGRESS" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/still running.*guardrails/i);
  });

  it("refuses on a failure", () => {
    const v = checksVerdict([
      { name: "tests", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/not green.*tests=FAILURE/i);
  });

  it("passes when every check is green", () => {
    expect(
      checksVerdict([
        { name: "tests", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "guardrails", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "secret-scan", status: "COMPLETED", conclusion: "SKIPPED" },
      ]).ok,
    ).toBe(true);
  });

  // The legacy commit-status shape uses `state` and carries no `status`.
  it("reads the legacy status shape", () => {
    expect(checksVerdict([{ context: "vercel", state: "SUCCESS" }]).ok).toBe(
      true,
    );
    expect(checksVerdict([{ context: "vercel", state: "FAILURE" }]).ok).toBe(
      false,
    );
  });
});
