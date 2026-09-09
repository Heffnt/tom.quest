import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  areaResults,
  archiveResults,
  formatDatabaseResult,
  formatEventResult,
  formatRulingResult,
  formatSessionResult,
  formatTodoResult,
  parseSearchArgs,
} from "./search-lib.mjs";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("formatDatabaseResult", () => {
  it("starts with stable id and day, collapses values, and preserves the server URL", () => {
    expect(
      formatDatabaseResult("sessions", {
        _id: "session:42",
        createdAt: "2026-09-09T14:20:00Z",
        title: "first line\nsecond\tline",
        status: "ended",
        model: "opus",
        outcomeSummary: "ready",
        sessionUrl: "https://tom.quest/sessions/42",
      }),
    ).toBe("claudeSessions/session:42 2026-09-09 title=\"first line\\nsecond\\tline\" status=ended model=opus summary=\"ready\" url=https://tom.quest/sessions/42");
  });
});

describe("purpose-shaped formatters", () => {
  it("keeps each database result type readable without serializing the row", () => {
    expect(formatRulingResult({ id: "r1", date: "2026-09-01", verdict: "approve", sentence: "keep it", provenance: { from: "tom", inboundId: "i1", quote: "yes" }, todoStatement: "Ship it" })).toContain('dtsRulings/r1 2026-09-01 verdict=approve sentence="keep it" provenance=from=tom inbound=i1 quote="yes" todo="Ship it"');
    expect(formatSessionResult({ id: "s1", date: "2026-09-02", title: "Search", status: "ended", model: "opus", outcomeSummary: "done", repos: ["tom.quest", "WikiTom"], url: "/sessions?session=s1" })).toBe('claudeSessions/s1 2026-09-02 title="Search" status=ended model=opus summary="done" repos=tom.quest,WikiTom url=https://tom.quest/sessions?session=s1');
    expect(formatEventResult({ id: "e1", date: "2026-09-03", kind: "nightly", text: "finished" })).toBe('dtsEvents/e1 2026-09-03 kind=nightly text="finished"');
    expect(formatTodoResult({ id: "t1", createdAt: "2026-09-04", statement: "Search", status: "active", category: "ops", updatedAt: "2026-09-05" })).toBe('dtsTodos/t1 2026-09-04 statement="Search" status=active category="ops" createdAt=2026-09-04 updatedAt=2026-09-05');
  });
});

describe("archive search", () => {
  it("streams gzipped JSONL and bounds the returned matching excerpt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const archive = path.join(root, "sessions", "2026", "09", "09");
    fs.mkdirSync(archive, { recursive: true });
    const token = `gho_${"A".repeat(36)}`;
    const line = `${"x".repeat(1_000)} ${token} ${"y".repeat(1_900)} NEEDLE ${"z".repeat(3_000)}\n`;
    fs.writeFileSync(path.join(archive, "session.jsonl.gz"), zlib.gzipSync(line));
    const { rows } = await archiveResults(root, "needle", undefined, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-09-09", id: "sessions/2026/09/09/session.jsonl.gz:1" });
    expect(rows[0].text).toContain("NEEDLE");
    expect(rows[0].text).toContain("[redacted:github]");
    expect(rows[0].text).not.toContain(token);
    expect(rows[0].text.length).toBeLessThanOrEqual(4_002);
  });
});

describe("local search parsing", () => {
  it("rejects a limit above the hard maximum", () => {
    expect(() => parseSearchArgs(["events", "needle", "--limit", "201"])).toThrow("from 1 to 200");
  });

  it("lists all areas as frontmatter-only summaries and reads protected sections by name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const areas = path.join(root, "model-of-tom", "areas");
    fs.mkdirSync(areas, { recursive: true });
    fs.writeFileSync(path.join(areas, "alpha.md"), "---\nupdated: 2026-09-05\nreviewed: 2026-09-06\n---\n## Current state\nReady now\n## Must not break\nKeep the guard\n");
    const beta = path.join(areas, "beta.md");
    fs.writeFileSync(beta, "# Beta\n");
    fs.utimesSync(beta, new Date("2026-09-07T12:00:00Z"), new Date("2026-09-07T12:00:00Z"));
    expect(areaResults(root, "all")).toEqual([
      { id: "area:alpha", name: "alpha", date: "2026-09-05", updated: "2026-09-05", reviewed: "2026-09-06" },
      { id: "area:beta", name: "beta", date: "2026-09-07", updated: "unknown", reviewed: "unknown" },
    ]);
    expect(areaResults(root, "alpha")[0]).toMatchObject({
      currentState: "## Current state\nReady now",
      mustNotBreak: "## Must not break\nKeep the guard",
    });
  });
});
