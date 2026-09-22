import { describe, expect, it } from "vitest";
import { bodyOf, detailOf, JOBS } from "./tests-report.mjs";

const green = {
  REPO: "tom.quest",
  SHA: "deadbeef",
  RUN_URL: "https://github.com/Heffnt/tom.quest/actions/runs/1",
  STATIC_RESULT: "success",
  STATIC_SECONDS: "31",
  SECRET_RESULT: "success",
  SECRET_SECONDS: "11",
  TESTS_RESULT: "success",
  TESTS_SECONDS: "142",
  E2E_RESULT: "success",
  E2E_SECONDS: "97",
  SUMMARY: JSON.stringify({ mode: "related", why: "2 changed files", files: 2, seconds: 11.4, ok: true, slowest: [{ file: "convex/http.test.ts", seconds: 6.2 }] }),
};

describe("tests-report", () => {
  it("records every job's seconds, the mode and the file count on one body", () => {
    const body = bodyOf(green);
    expect(body).toMatchObject({
      repo: "tom.quest",
      sha: "deadbeef",
      ok: true,
      mode: "related",
      files: 2,
      slowest: [{ file: "convex/http.test.ts", seconds: 6.2 }],
    });
    expect(body.durations).toEqual({
      "static-boundaries": 31,
      "secret-scan": 11,
      tests: 142,
      e2e: 97,
      // The vitest run's own time, beside the job that paid for install, the
      // typecheck and the build as well.
      suite: 11.4,
    });
  });

  // Four required jobs and one word each: a failure, a cancellation and a skip
  // are all "this check did not pass", because a check that did not answer must
  // not be read as one that did.
  it("goes red unless every job succeeded", () => {
    expect(bodyOf({ ...green, E2E_RESULT: "failure" }).ok).toBe(false);
    expect(bodyOf({ ...green, STATIC_RESULT: "skipped" }).ok).toBe(false);
    expect(bodyOf({ ...green, SECRET_RESULT: "cancelled" }).ok).toBe(false);
    expect(bodyOf({ ...green, TESTS_RESULT: "" }).ok).toBe(false);
  });

  it("says which mode ran in the sentence the merge gate prints", () => {
    expect(detailOf({ static: "success", secret: "success", tests: "failure", e2e: "success" }, { mode: "full", files: 0 }))
      .toBe("guardrails — static-boundaries success, secret-scan success, tests failure, e2e success; full mode, 0 changed files");
    expect(detailOf({}, { mode: "related", files: 1 })).toContain("related mode, 1 changed file");
    expect(detailOf({}, null)).toContain("scope unknown");
  });

  it("still posts a body when the tests job died before writing a summary", () => {
    const body = bodyOf({ ...green, TESTS_RESULT: "failure", SUMMARY: "not json" });
    expect(body.ok).toBe(false);
    expect(body.mode).toBeUndefined();
    expect(body.detail).toContain("scope unknown");
    expect(body.durations.tests).toBe(142);
  });

  it("drops a duration it cannot read rather than sending a bad number", () => {
    const body = bodyOf({ ...green, E2E_SECONDS: "", STATIC_SECONDS: "not a number" });
    expect(body.durations["static-boundaries"]).toBeUndefined();
    expect(body.durations.e2e).toBeUndefined();
    expect(JOBS.map((job) => job.name)).toEqual(["static-boundaries", "secret-scan", "tests", "e2e"]);
  });
});
