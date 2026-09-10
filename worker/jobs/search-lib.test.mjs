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
  runSearchCli,
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
  it("gives areas all the shared default and accepts the hard maximum", () => {
    expect(parseSearchArgs(["areas", "all"])).toMatchObject({ limit: 20 });
    expect(parseSearchArgs(["areas", "all", "--limit", "200"])).toMatchObject({ limit: 200 });
    expect(() => parseSearchArgs(["areas", "all", "--limit", "201"])).toThrow("from 1 to 200");
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

  it("limits areas all to the shared default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const areas = path.join(root, "model-of-tom", "areas");
    fs.mkdirSync(areas, { recursive: true });
    for (let i = 0; i < 21; i += 1) fs.writeFileSync(path.join(areas, `area-${String(i).padStart(2, "0")}.md`), `# ${i}\n`);
    const output = [];
    expect(await runSearchCli(["areas", "all"], { env: { WIKITOM_DIR: root }, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(20);
    expect(output[0]).toContain("area:area-00");
    expect(output.at(-1)).toContain("area:area-19");
  });
});

describe("search CLI output boundaries", () => {
  it("reports missing production credentials through the injected error callback", async () => {
    const errors = [];
    expect(await runSearchCli(["rulings", "needle"], { env: {}, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors).toEqual(["tts-search: CONVEX_SITE_URL and TTS_WORKER_KEY must be set for production searches"]);
  });

  it("reports a missing archive as text or JSON and exits 3", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const text = [];
    expect(await runSearchCli(["archive", "needle"], { env: { WIKITOM_DIR: root }, write: (line) => text.push(line), error: () => {} })).toBe(3);
    expect(text).toEqual([`tts-search: no session archive at ${path.join(root, "sessions")}`]);

    const json = [];
    expect(await runSearchCli(["archive", "needle", "--json"], { env: { WIKITOM_DIR: root }, write: (line) => json.push(line), error: () => {} })).toBe(3);
    expect(JSON.parse(json[0])).toEqual({ missing: path.join(root, "sessions") });
  });

  it("redacts credential-shaped paths in missing archive and filesystem errors", async () => {
    const token = `gho_${"A".repeat(36)}`;
    const missingRoot = path.join(os.tmpdir(), `tts-search-${token}`);
    fs.mkdirSync(missingRoot, { recursive: true });
    temporary.push(missingRoot);
    const missing = [];
    expect(await runSearchCli(["archive", "needle"], { env: { WIKITOM_DIR: missingRoot }, write: (line) => missing.push(line), error: () => {} })).toBe(3);
    expect(missing[0]).toContain("[redacted:github]");
    expect(missing[0]).not.toContain(token);

    const errorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(errorRoot);
    const archive = path.join(errorRoot, "sessions", "2026", "09", "09");
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, `${token}.gz`), "not gzip");
    const errors = [];
    expect(await runSearchCli(["archive", "needle"], { env: { WIKITOM_DIR: errorRoot }, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain("[redacted:github]");
    expect(errors[0]).not.toContain(token);
  });

  it("forwards --since and reports a server coverage envelope from injected fetch", async () => {
    const output = [];
    const requested = [];
    const fetch = async (url, init) => {
      requested.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          results: [{ id: "r1", date: "2026-09-08", verdict: "approve", sentence: "needle" }],
          scanned: 37,
          exhausted: true,
          oldestScannedAt: "2026-08-01T12:00:00.000Z",
        }),
      };
    };
    const env = { CONVEX_SITE_URL: "https://example.convex.cloud", TTS_WORKER_KEY: "worker-key" };
    expect(await runSearchCli(["rulings", "needle", "--since", "2026-09-01"], { env, fetch, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(new URL(requested[0].url).searchParams.get("since")).toBe("2026-09-01");
    expect(requested[0].init.headers).toEqual({ "X-TTS-Key": "worker-key" });
    expect(output.at(-1)).toBe("tts-search: searched 37 rows back to 2026-08-01 (exhausted)");

    const json = [];
    expect(await runSearchCli(["rulings", "needle", "--json"], { env, fetch, write: (line) => json.push(line), error: () => {} })).toBe(0);
    expect(JSON.parse(json[0])).toMatchObject({ scanned: 37, exhausted: true, oldestScannedAt: "2026-08-01T12:00:00.000Z", results: [{ id: "r1" }] });
  });

  it("filters archive rows by --since through the injected WikiTom root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    for (const day of ["08", "09"]) {
      const archive = path.join(root, "sessions", "2026", "09", day);
      fs.mkdirSync(archive, { recursive: true });
      fs.writeFileSync(path.join(archive, "session.jsonl"), `needle ${day}\n`);
    }
    const output = [];
    expect(await runSearchCli(["archive", "needle", "--since", "2026-09-09"], { env: { WIKITOM_DIR: root }, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("sessions/2026/09/09/session.jsonl:1");
  });

  it("stops archive matching at --limit even when matches span files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const archive = path.join(root, "sessions", "2026", "09", "09");
    fs.mkdirSync(archive, { recursive: true });
    for (const name of ["first.jsonl", "second.jsonl", "third.jsonl"]) {
      fs.writeFileSync(path.join(archive, name), `needle in ${name}\n`);
    }
    const output = [];
    expect(await runSearchCli(["archive", "needle", "--limit", "2"], { env: { WIKITOM_DIR: root }, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(2);
    expect(output[0]).toContain("first.jsonl:1");
    expect(output[1]).toContain("second.jsonl:1");
    expect(output.join("\n")).not.toContain("third.jsonl");
  });
});
