import { describe, expect, it } from "vitest";

import { AST_GREP_VERSION, checkRemovals, movedAgainst } from "./check-removals.mjs";
import { baselineText, hash8 } from "./removal-sensor.mjs";

/** The fingerprint the sensor gives an exported name. */
function hashOf(name = "lonely") {
  return hash8(`export ${name}`);
}

/** One ast-grep match line the sensor reads. */
function hit(ruleId, file, text, line) {
  return JSON.stringify({ ruleId, file, text, range: { start: { line: line - 1 }, end: { line: line - 1 } } });
}

const LONELY = hit("dead-export", "app/a.ts", "export const lonely = 1;", 3);
const NEWCOMER = hit("dead-export", "app/b.ts", "export const newcomer = 2;", 7);
const noUse = () => ({ ok: false, status: 1, stdout: "", error: "" });

/** The io the check runs against: a tree whose live matches are `matches`, a
 *  committed baseline, and main's. */
function io({ matches = [LONELY], baseline, main = undefined, version = `ast-grep ${AST_GREP_VERSION}`, rules = true }) {
  return {
    sensor: { astGrep: () => matches.join("\n"), git: noUse },
    astGrepVersion: () => version,
    ruleTest: () => ({ ok: rules, output: rules ? "ok" : "FAIL dead-export" }),
    readBaseline: () => baseline,
    mainBaseline: () => (main === undefined ? baseline : main),
  };
}

const LONELY_KEY = "dead-export\tapp/a.ts\t";

describe("check-removals", () => {
  it("fails a violation that is live and not in the baseline, naming the rule, the file and what to do", () => {
    const result = checkRemovals(io({ baseline: baselineText([]) }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("dead-export in app/a.ts (line 3): no other file names this export");
  });

  it("passes the baseline it would write, and prints a drop without failing", () => {
    const keys = [LONELY_KEY + hashOf(), "dead-export\tapp/gone.ts\t00000000"];
    const result = checkRemovals(io({ baseline: baselineText(keys) }));
    expect(result.code).toBe(0);
    expect(result.out).toContain("gone: dead-export\tapp/gone.ts\t00000000");
  });

  it("fails a baseline regenerated to admit a new violation, against main's", () => {
    const onMain = baselineText([LONELY_KEY + hashOf()]);
    const grown = baselineText([LONELY_KEY + hashOf(), "dead-export\tapp/b.ts\t" + hashOf("newcomer")]);
    const result = checkRemovals(io({ matches: [LONELY, NEWCOMER], baseline: grown, main: onMain }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("the list was regenerated to admit a new violation");
  });

  it("reports a violation whose file moved as moved, not as new", () => {
    const moved = hit("dead-export", "shared/a.ts", "export const lonely = 1;", 3);
    const onMain = baselineText([LONELY_KEY + hashOf()]);
    const after = baselineText(["dead-export\tshared/a.ts\t" + hashOf()]);
    const result = checkRemovals(io({ matches: [moved], baseline: after, main: onMain }));
    expect(result.code).toBe(0);
    expect(result.out).toContain("moved: dead-export\tapp/a.ts\t" + hashOf() + " -> shared/a.ts");
  });

  it("still fails a new line that only looks like a move", () => {
    const keys = ["dead-export\tshared/a.ts\t" + hashOf(), "dead-export\tshared/b.ts\t" + hashOf()];
    const onMain = [LONELY_KEY + hashOf()];
    // Each line on main pairs once, and a different basename never pairs.
    expect(movedAgainst(keys, onMain)).toEqual({
      grown: ["dead-export\tshared/b.ts\t" + hashOf()],
      moved: [[LONELY_KEY + hashOf(), "dead-export\tshared/a.ts\t" + hashOf()]],
    });
    // A line main still carries is no move: the old path has not gone.
    expect(movedAgainst([LONELY_KEY + hashOf(), "dead-export\tshared/a.ts\t" + hashOf()], onMain).grown).toEqual([
      "dead-export\tshared/a.ts\t" + hashOf(),
    ]);
    // Another rule or fingerprint never pairs.
    expect(movedAgainst(["flag-not-deletion\tshared/a.ts\t" + hashOf()], onMain).grown).toHaveLength(1);
    expect(movedAgainst(["dead-export\tshared/a.ts\t" + hashOf("other")], onMain).grown).toHaveLength(1);
  });

  it("says so, and still checks the tree, when no main is readable", () => {
    const result = checkRemovals(io({ baseline: baselineText([LONELY_KEY + hashOf()]), main: null }));
    expect(result.code).toBe(0);
    expect(result.out[0]).toContain("not compared with main's");
  });

  it("fails a hand-edited baseline", () => {
    const edited = baselineText([LONELY_KEY + hashOf()]).replace("# 1 violations", "# 0 violations");
    expect(checkRemovals(io({ baseline: edited })).err[0]).toContain("edited by hand");
  });

  it("fails loudly with no ast-grep, and with a rule that stopped matching its examples", () => {
    expect(checkRemovals(io({ baseline: "", version: null })).err[0]).toContain("ast-grep is not installed");
    expect(checkRemovals(io({ baseline: "", rules: false })).err[0]).toContain("no longer matches its own examples");
  });

  it("fails a missing baseline", () => {
    expect(checkRemovals(io({ baseline: null })).err[0]).toContain("is missing");
  });
});
