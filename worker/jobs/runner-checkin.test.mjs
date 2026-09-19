import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCheckIn, checkInJudgePrompt, parseCheckInVerdict } from "./runner-checkin.mjs";
import { JOBS, loadGolden, scoreCheckIn } from "./evals.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STANDARD = "Write plainly. Define every term.";
const GOOD = "The sweep has 12 jobs running.\n\nNothing changed.";

function judge(...answers) {
  const calls = [];
  return {
    calls,
    run: (prompt, options) => {
      calls.push({ prompt, options });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("checkCheckIn", () => {
  it("stops at the form rules without calling the judge", async () => {
    const j = judge();
    const graded = await checkCheckIn("## Status\n\nIt ran.", { run: j.run, standard: STANDARD });
    expect(graded).toMatchObject({ verdict: "fail", stage: "form", attempts: 0 });
    expect(graded.complaints[0]).toMatch(/^checkin-heading:/);
    expect(j.calls).toEqual([]);
  });

  it("asks the judge once, with no tools and one turn, and takes a readable verdict", async () => {
    const j = judge('{"verdict": "fail", "complaints": ["The word grinder is coined."]}');
    const graded = await checkCheckIn(GOOD, { run: j.run, standard: STANDARD });
    expect(graded).toMatchObject({ verdict: "fail", complaints: ["The word grinder is coined."], attempts: 1, stage: "judge" });
    expect(j.calls[0].options).toMatchObject({ maxTurns: 1, allowedTools: [] });
    expect(j.calls[0].prompt).toContain(STANDARD);
    expect(j.calls[0].prompt.endsWith(GOOD)).toBe(true);
  });

  it("asks again once, only for an answer it could not read", async () => {
    const j = judge("not json", '{"verdict": "pass", "complaints": []}');
    expect(await checkCheckIn(GOOD, { run: j.run, standard: STANDARD })).toMatchObject({ verdict: "pass", attempts: 2 });
    const twice = judge("not json", "still not");
    const graded = await checkCheckIn(GOOD, { run: twice.run, standard: STANDARD });
    expect(graded).toMatchObject({ verdict: "fail", attempts: 2 });
    expect(graded.complaints[0]).toMatch(/could not be read twice/);
  });

  it("never passes a check-in whose judge could not be run", async () => {
    const j = judge(new Error("box busy"));
    expect(await checkCheckIn(GOOD, { run: j.run, standard: STANDARD })).toMatchObject({ verdict: "fail", stage: "judge" });
  });
});

describe("the judge's answer", () => {
  it("is read as a verdict and complaints, and a fail with no complaint is unreadable", () => {
    expect(parseCheckInVerdict('{"verdict":"pass","complaints":[]}')).toEqual({ verdict: "pass", complaints: [] });
    expect(parseCheckInVerdict('{"verdict":"fail","complaints":[]}').unreadable).toBe(true);
    expect(parseCheckInVerdict('{"verdict":"maybe","complaints":[]}').unreadable).toBe(true);
    expect(checkInJudgePrompt(GOOD, STANDARD)).toContain("HIS WRITING STANDARD");
  });
});

describe("the golden check-ins", () => {
  const items = loadGolden(path.join(here, "..", "..")).filter((item) => item.job === "checkin");

  it("are seven, each under the checkin job, each passing the form rules", async () => {
    expect(items.map((item) => item.id).sort()).toEqual([
      "checkin-act-verified-pass", "checkin-coined-jargon-fail", "checkin-contract-table-pass", "checkin-plain-numbers-pass",
      "checkin-ruling-requested-pass", "checkin-self-grading-fail", "checkin-undefined-tier-fail",
    ]);
    expect(JOBS.checkin.module).toBe("worker/jobs/runner-checkin.mjs");
    const { checkInFailures } = await import("../../scripts/checkin-rules.mjs");
    for (const item of items) expect(checkInFailures(item.input.checkIn), item.id).toEqual([]);
    expect(fs.existsSync(path.join(here, "..", "..", "evals", "golden", "checkins", "README.md"))).toBe(true);
  });

  it("score by comparing the judge's verdict with the one the item requires", () => {
    const wantsFail = items.find((item) => item.expected.verdict === "fail");
    expect(scoreCheckIn(wantsFail, { verdict: "fail", complaints: ["x."] }).judged).toBe("pass");
    expect(scoreCheckIn(wantsFail, { verdict: "pass", complaints: [] }).judged).toBe("fail");
    expect(scoreCheckIn(wantsFail, { unreadable: true, head: "?" }).judged).toBe("fail");
  });
});
