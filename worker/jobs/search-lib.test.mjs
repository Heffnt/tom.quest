import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  areaResults,
  archiveResults,
  evidenceResults,
  formatDatabaseResult,
  formatEvalsResult,
  formatEventResult,
  formatRulingResult,
  formatSessionResult,
  formatTodoResult,
  parseSearchArgs,
  runSearchCli,
  SEARCH_COMMANDS,
  skillRoots,
  usage,
} from "./search-lib.mjs";
import { writeRegistration } from "../runs/registration.mjs";

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
    // A run with nothing to report keeps the shape and simply carries no
    // counts and no failures clause.
    expect(formatEvalsResult({ id: "ev0", at: Date.UTC(2026, 8, 6), data: { repo: "WikiTom", sha: "deadbee" } })).toBe("dtsEvents/ev0 2026-09-06 repo=WikiTom sha=deadbee");
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

  it("lists all areas as frontmatter-only summaries and reads protected sections by name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const areas = path.join(root, "model-of-tom", "areas");
    fs.mkdirSync(areas, { recursive: true });
    fs.writeFileSync(path.join(areas, "alpha.md"), "---\nupdated: 2026-09-05\nreviewed: 2026-09-06\n---\n## Current state\nReady now\n");
    const beta = path.join(areas, "beta.md");
    fs.writeFileSync(beta, "# Beta\n");
    fs.utimesSync(beta, new Date("2026-09-07T12:00:00Z"), new Date("2026-09-07T12:00:00Z"));
    expect(areaResults(root, "all")).toEqual([
      { id: "area:alpha", name: "alpha", date: "2026-09-05", updated: "2026-09-05", reviewed: "2026-09-06" },
      { id: "area:beta", name: "beta", date: "2026-09-07", updated: "unknown", reviewed: "unknown" },
    ]);
    // "Current state" is the only protected section an area page carries, and
    // the printed line has no must-not-break field to leave empty.
    // witness: re-add the "Must not break" extraction and this fails.
    const alpha = areaResults(root, "alpha")[0];
    expect(alpha).toMatchObject({ currentState: "## Current state\nReady now" });
    expect("mustNotBreak" in alpha).toBe(false);
    const line = [];
    expect(await runSearchCli(["areas", "alpha"], { env: { WIKITOM_DIR: root }, write: (text) => line.push(text), error: () => {} })).toBe(0);
    expect(line).toEqual(['area:alpha 2026-09-05 updated=2026-09-05 reviewed=2026-09-06 current-state=## Current state\\nReady now']);
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

// The two subcommands the dynamic-context round added. `evidence` is the one
// the prelude's fetchable line names for "where did this sentence come from";
// `proposals` is what a run about to edit a nested AGENTS.md reads first.
describe("evidence search", () => {
  function vault() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const dir = path.join(root, "model-of-tom", "evidence", "areas");
    fs.mkdirSync(dir, { recursive: true });
    return { root, dir };
  }

  it("returns the whole entry for a match anywhere inside it, with the first source and its kind", () => {
    const { root, dir } = vault();
    fs.writeFileSync(
      path.join(dir, "climbing.md"),
      [
        "# Evidence for areas/climbing.md",
        "",
        "## Current state",
        "",
        "- line: He climbs at Central Rock Worcester.",
        '  said: 2026-08-30 · tom-quest/`47f04bc9` · "central rock, always"',
        "  paraphrase: 2026-04-23 · a second source that is not printed",
        "- line: A line whose NEEDLE is only in its source.",
        "  read: 2026-09-01 · the NEEDLE is here, not above",
        "",
        "## Must not break",
        "",
        "- line: Nothing here matches.",
        "  rests on: 2026-09-02 · unrelated",
        "",
      ].join("\n"),
    );
    const { rows } = evidenceResults(root, "needle", 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "model-of-tom/evidence/areas/climbing.md:Current state",
      heading: "Current state",
      line: "A line whose NEEDLE is only in its source.",
      sourceKind: "read",
    });

    // The heading travels with the entry, and only the FIRST source is printed.
    const central = evidenceResults(root, "central rock", 20).rows;
    expect(central).toHaveLength(1);
    expect(central[0].sourceKind).toBe("said");
    expect(central[0].sourceText).toContain("central rock, always");
    expect(central[0].sourceText).not.toContain("a second source");

    // `rests on:` is a source kind like the other three.
    const rests = evidenceResults(root, "unrelated", 20).rows;
    expect(rests[0]).toMatchObject({ heading: "Must not break", sourceKind: "rests on" });
  });

  it("prints the entry as path:heading with the line and the source kind, and redacts", async () => {
    const { root, dir } = vault();
    const token = `gho_${"A".repeat(36)}`;
    const file = path.join(dir, "money.md");
    fs.writeFileSync(
      file,
      ["## Current state", "", "- line: The NEEDLE key is stored somewhere.", `  read: 2026-09-01 · ${token}`, ""].join("\n"),
    );
    // No frontmatter and no date in the path, so the row's date is the file's
    // own modification time (sourceDate's last fallback). Pinned, or the
    // expectation below would be whatever today is.
    fs.utimesSync(file, new Date("2026-09-05T12:00:00Z"), new Date("2026-09-05T12:00:00Z"));
    const output = [];
    expect(await runSearchCli(["evidence", "needle"], { env: { WIKITOM_DIR: root }, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toBe(
      'model-of-tom/evidence/areas/money.md:Current state 2026-09-05 line="The NEEDLE key is stored somewhere." read="2026-09-01 · [redacted:github]"',
    );
    expect(output[0]).not.toContain(token);
  });

  it("reports a missing evidence directory as text or JSON and exits 3, like the archive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-search-"));
    temporary.push(root);
    const text = [];
    expect(await runSearchCli(["evidence", "needle"], { env: { WIKITOM_DIR: root }, write: (line) => text.push(line), error: () => {} })).toBe(3);
    expect(text).toEqual([`tts-search: no evidence directory at ${path.join(root, "model-of-tom", "evidence")}`]);

    const json = [];
    expect(await runSearchCli(["evidence", "needle", "--json"], { env: { WIKITOM_DIR: root }, write: (line) => json.push(line), error: () => {} })).toBe(3);
    expect(JSON.parse(json[0])).toEqual({ missing: path.join(root, "model-of-tom", "evidence") });
  });

  it("stops at --limit and rejects the options that do not apply", () => {
    const { root, dir } = vault();
    fs.writeFileSync(
      path.join(dir, "many.md"),
      ["## Current state", "", ...Array.from({ length: 5 }, (_, i) => `- line: needle ${i}\n  said: 2026-09-0${i + 1} · s${i}`), ""].join("\n"),
    );
    expect(evidenceResults(root, "needle", 2).rows).toHaveLength(2);
    expect(() => parseSearchArgs(["evidence", "q", "--since", "2026-09-01"])).toThrow("--since does not apply to evidence");
    expect(() => parseSearchArgs(["evidence"])).toThrow("evidence needs exactly one query");
  });
});

// GET /tts/search/evals was reachable only over HTTP until this subcommand
// existed. witness: drop "evals" from DATABASE_COMMANDS and the first
// expectation below becomes an unknown-subcommand failure.
describe("evals runs", () => {
  const env = { CONVEX_SITE_URL: "https://example.convex.cloud", TTS_WORKER_KEY: "worker-key" };
  const run = {
    id: "ev1",
    at: Date.UTC(2026, 8, 9, 8),
    data: {
      repo: "tom.quest",
      sha: "abc1234",
      items: 40,
      pass: 38,
      fail: 2,
      regressions: 1,
      stillFailing: 1,
      failures: [{ id: "writing/01", reason: "too long" }, { id: "writing/02", reason: "no evidence" }],
    },
  };

  it("reads the /tts/search/evals door with the shared limit and prints the run's counts and failing ids", async () => {
    const requested = [];
    const fetch = async (url, init) => {
      requested.push({ url, init });
      return { ok: true, json: async () => [run] };
    };
    const output = [];
    expect(await runSearchCli(["evals", "--limit", "5"], { env, fetch, write: (line) => output.push(line), error: () => {} })).toBe(0);
    const url = new URL(requested[0].url);
    expect(url.pathname).toBe("/tts/search/evals");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(requested[0].init.headers).toEqual({ "X-TTS-Key": "worker-key" });
    expect(output).toEqual([
      'dtsEvents/ev1 2026-09-09 repo=tom.quest sha=abc1234 items=40 pass=38 fail=2 regressions=1 still-failing=1 failures="writing/01,writing/02"',
    ]);
  });

  it("caps the rows it prints at --limit and emits the rows unchanged under --json", async () => {
    const fetch = async () => ({ ok: true, json: async () => [run, { ...run, id: "ev2" }, { ...run, id: "ev3" }] });
    const output = [];
    expect(await runSearchCli(["evals", "--limit", "2"], { env, fetch, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(2);
    expect(output[1]).toContain("dtsEvents/ev2");

    const json = [];
    expect(await runSearchCli(["evals", "--json"], { env, fetch, write: (line) => json.push(line), error: () => {} })).toBe(0);
    expect(JSON.parse(json[0])).toMatchObject([{ id: "ev1" }, { id: "ev2" }, { id: "ev3" }]);
  });

  it("takes only the options that apply to it, and needs the production credentials", async () => {
    expect(parseSearchArgs(["evals"])).toMatchObject({ command: "evals", limit: 20, json: false });
    expect(parseSearchArgs(["evals", "--limit", "200"])).toMatchObject({ limit: 200 });
    expect(() => parseSearchArgs(["evals", "--limit", "201"])).toThrow("from 1 to 200");
    expect(() => parseSearchArgs(["evals", "--since", "2026-09-01"])).toThrow("--since does not apply to evals");
    expect(() => parseSearchArgs(["evals", "--repo", "tom.quest"])).toThrow("--repo does not apply to evals");
    expect(() => parseSearchArgs(["evals", "a-query"])).toThrow("evals accepts options only");
    expect(usage()).toContain("evals [--limit N] [--json]");

    const errors = [];
    expect(await runSearchCli(["evals"], { env: {}, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors).toEqual(["tts-search: CONVEX_SITE_URL and TTS_WORKER_KEY must be set for production searches"]);
  });

  it("refuses a body that is not the door's array", async () => {
    const errors = [];
    const fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    expect(await runSearchCli(["evals"], { env, fetch, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors).toEqual(["tts-search: /tts/search/evals returned no result array"]);
  });
});

describe("repository-rule proposals", () => {
  const env = { CONVEX_SITE_URL: "https://example.convex.cloud", TTS_WORKER_KEY: "worker-key" };

  it("reads its own door, forwards --repo, and prints the id a session cites when it applies the line", async () => {
    const requested = [];
    const fetch = async (url, init) => {
      requested.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          proposals: [
            {
              at: Date.UTC(2026, 8, 9, 8),
              id: "b71c",
              repo: "tom.quest",
              file: "worker/AGENTS.md",
              section: "box",
              line: "A worktree has no .env.local; copy it from the main checkout.",
              evidence: "read: session 47f04bc9",
              status: "open",
            },
          ],
        }),
      };
    };
    const output = [];
    expect(await runSearchCli(["proposals", "--repo", "tom.quest"], { env, fetch, write: (line) => output.push(line), error: () => {} })).toBe(0);
    const url = new URL(requested[0].url);
    expect(url.pathname).toBe("/tts/repo-proposals");
    expect(url.searchParams.get("repo")).toBe("tom.quest");
    expect(requested[0].init.headers).toEqual({ "X-TTS-Key": "worker-key" });
    expect(output).toEqual([
      'repoProposal/b71c 2026-09-09 repo=tom.quest file=worker/AGENTS.md § box line="A worktree has no .env.local; copy it from the main checkout." evidence="read: session 47f04bc9"',
    ]);
  });

  it("refuses an envelope that carries no proposal array, and needs the production credentials", async () => {
    const errors = [];
    const fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    expect(await runSearchCli(["proposals"], { env, fetch, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors).toEqual(["tts-search: /tts/repo-proposals returned no proposal array"]);

    const missing = [];
    expect(await runSearchCli(["proposals"], { env: {}, write: () => {}, error: (line) => missing.push(line) })).toBe(2);
    expect(missing).toEqual(["tts-search: CONVEX_SITE_URL and TTS_WORKER_KEY must be set for production searches"]);
  });

  it("takes only the options that apply to it", () => {
    expect(parseSearchArgs(["proposals", "--repo", "tom.quest"])).toMatchObject({ command: "proposals", repo: "tom.quest", limit: 20 });
    expect(() => parseSearchArgs(["proposals", "--wikitom", "/tmp"])).toThrow("--wikitom does not apply to proposals");
    expect(() => parseSearchArgs(["proposals", "a-query"])).toThrow("proposals accepts options only");
  });
});

// ── skills ───────────────────────────────────────────────────────────────────
// The one corpus that is neither WikiTom nor a production door: the INSTALLED
// skills directory, so the answer is exactly what this run could load.
describe("installed skills", () => {
  function installed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-skills-"));
    temporary.push(dir);
    const publish = (name, description, body, references = {}) => {
      const skill = path.join(dir, name);
      fs.mkdirSync(skill, { recursive: true });
      // The frontmatter renderSkillMd writes: `name` and `description`, the
      // description JSON-quoted, and nothing else.
      fs.writeFileSync(
        path.join(skill, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
      );
      for (const [file, contents] of Object.entries(references)) fs.writeFileSync(path.join(skill, file), contents);
    };
    publish("tom-write", "His writing standard: Shape, Words", "The writing body.", { "ground.md": "what he knows" });
    publish("tom-know-money", "Tom's money: money, banking.", "The money body.");
    publish("tom-repo-cmt", "Rules of the CMT repository.", "The repo body.", { "cmt-AGENTS.md": "nested rules" });
    // NOT ours: a checkout's own skill under the same root, which this command
    // must never see. witness: drop the prefix filter and the first test fails.
    publish("other-skill", "someone else's", "not Tom's.");
    return dir;
  }

  it("names every tom- skill under the root, its group, bytes, path and description, and nothing else", async () => {
    const dir = installed();
    const output = [];
    expect(await runSearchCli(["skills", "--skills-dir", dir], { env: {}, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output.map((line) => line.split(" ")[0])).toEqual(["know-money", "repo-cmt", "write"]);
    expect(output.join("\n")).not.toContain("someone else");
    expect(output[0]).toContain("[know]");
    expect(output[0]).toContain(path.join(dir, "tom-know-money"));
    expect(output[0]).toContain('description="Tom\'s money: money, banking."');
    expect(output[0]).toMatch(/\s\d+B\s/);
    // The group is DERIVED from the name; the frontmatter never carries it.
    expect(output[1]).toContain("[repo]");
    expect(output[2]).toContain("[write]");
  });

  it("narrows to one group", async () => {
    const dir = installed();
    const output = [];
    expect(await runSearchCli(["skills", "--group", "know", "--skills-dir", dir], { env: {}, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("know-money");
  });

  it("prints a known skill's body and its references' names and paths", async () => {
    const dir = installed();
    const output = [];
    expect(await runSearchCli(["skills", "write", "--skills-dir", dir], { env: {}, write: (line) => output.push(line), error: () => {} })).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("The writing body.");
    expect(text).toContain(`references: ground.md ${path.join(dir, "tom-write", "ground.md")}`);

    // The directory form is accepted and nothing is said about the prefix.
    const prefixed = [];
    expect(await runSearchCli(["skills", "tom-write", "--skills-dir", dir], { env: {}, write: (line) => prefixed.push(line), error: () => {} })).toBe(0);
    expect(prefixed).toEqual(output);

    const json = [];
    expect(await runSearchCli(["skills", "write", "--skills-dir", dir, "--json"], { env: {}, write: (line) => json.push(line), error: () => {} })).toBe(0);
    expect(JSON.parse(json[0])).toMatchObject({
      skill: { name: "write", group: "write", body: "The writing body.", references: [{ name: "ground.md" }] },
    });
  });

  it("refuses an unknown name with its near misses and appends the refusal to the run's envelope", async () => {
    const dir = installed();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "tts-skills-reg-"));
    temporary.push(state);
    const spoolDir = path.join(state, "registration");
    const token = "77777777-7777-4777-8777-777777777777";
    writeRegistration({ spoolDir, token, writer: { file: "launcher.mjs" }, registration: { host: "laptop" }, now: () => 1 });

    const errors = [];
    const env = { TTS_RUN_REG_SPOOL: spoolDir, TTS_RUN_REG_TOKEN: token };
    expect(await runSearchCli(["skills", "know-nothing", "--skills-dir", dir], { env, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('skill "know-nothing" is not in the catalog');
    expect(errors[0]).toContain("near misses: know-money");

    // `tts search skills` runs inside the child, and a run's sidecar only
    // exists after its claim — so the SPOOL is what the refusal lands on.
    const envelope = JSON.parse(fs.readFileSync(path.join(spoolDir, `${token}.json`), "utf8"));
    expect(envelope.skills.asked).toMatchObject([{ name: "know-nothing", result: "refused", why: "not in the catalog" }]);
    expect(envelope).toMatchObject({ envelopeVersion: 2, token, writer: { file: "launcher.mjs" }, registration: { host: "laptop" } });

    // A found skill is recorded too — the envelope answers "what did this run
    // reach for", not only "what did it fail to reach for".
    expect(await runSearchCli(["skills", "know-money", "--skills-dir", dir], { env, write: () => {}, error: () => {} })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(spoolDir, `${token}.json`), "utf8")).skills.asked.at(-1)).toMatchObject({
      name: "know-money",
      result: "ok",
    });

    // With no run around it, the same refusal is still just a refusal.
    const alone = [];
    expect(await runSearchCli(["skills", "know-nothing", "--skills-dir", dir], { env: {}, write: () => {}, error: (line) => alone.push(line) })).toBe(2);
    expect(alone[0]).toContain("near misses: know-money");
  });

  it("treats a missing skills directory as an empty catalog, not an error, and says where it looked", async () => {
    const dir = path.join(os.tmpdir(), `tts-skills-absent-${process.pid}`);
    const output = [];
    expect(await runSearchCli(["skills", "--skills-dir", dir], { env: {}, write: (line) => output.push(line), error: () => {} })).toBe(0);
    expect(output).toEqual([`tts-search: no skills directory at ${path.resolve(dir)}`]);

    const json = [];
    expect(await runSearchCli(["skills", "--skills-dir", dir, "--json"], { env: {}, write: (line) => json.push(line), error: () => {} })).toBe(0);
    expect(JSON.parse(json[0])).toEqual({ skills: [] });
  });

  it("looks in CLAUDE_CONFIG_DIR first and the Codex root second, on either machine", () => {
    // The box reaches its per-account root (/root/.claude-accounts/<account>)
    // ONLY through CLAUDE_CONFIG_DIR; the laptop sets none and falls back.
    expect(skillRoots({ CLAUDE_CONFIG_DIR: "/root/.claude-accounts/wpi", HOME: "/root" })).toEqual([
      path.join("/root/.claude-accounts/wpi", "skills"),
      path.join("/root", ".codex", "skills"),
    ]);
    expect(skillRoots({ HOME: "/home/tom" })).toEqual([
      path.join("/home/tom", ".claude", "skills"),
      path.join("/home/tom", ".codex", "skills"),
    ]);
  });

  it("takes only the options that apply to it, and a name instead of a group", () => {
    expect(parseSearchArgs(["skills"])).toMatchObject({ command: "skills", limit: 20, json: false });
    expect(parseSearchArgs(["skills", "know-money"])).toMatchObject({ command: "skills", skill: "know-money" });
    expect(parseSearchArgs(["skills", "--group", "know"])).toMatchObject({ group: "know" });
    expect(() => parseSearchArgs(["skills", "--wikitom", "/tmp"])).toThrow("--wikitom does not apply to skills");
    expect(() => parseSearchArgs(["skills", "--since", "2026-09-01"])).toThrow("--since does not apply to skills");
    expect(() => parseSearchArgs(["skills", "a", "b"])).toThrow("skills takes at most one skill name");
    expect(() => parseSearchArgs(["skills", "write", "--group", "write"])).toThrow("--group does not apply when skills names a skill");
  });

  it("refuses a group that is not one of the published three", async () => {
    const dir = installed();
    const errors = [];
    expect(await runSearchCli(["skills", "--group", "nope", "--skills-dir", dir], { env: {}, write: () => {}, error: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toBe("tts-search: --group must be one of write, know, repo");
  });
});

describe("the help", () => {
  // DATA-DRIVEN ON PURPOSE. A corpus added to the grammar and left out of HELP
  // fails here, rather than being discovered by a run that cannot find it.
  it("names every corpus the grammar accepts", () => {
    expect([...SEARCH_COMMANDS]).toEqual([
      "archive",
      "areas",
      "evals",
      "events",
      "evidence",
      "proposals",
      "rulings",
      "sessions",
      "skills",
      "sources",
      "todos",
    ]);
    for (const command of SEARCH_COMMANDS) {
      expect(usage()).toMatch(new RegExp(`^${command} `, "m"));
    }
  });
});
