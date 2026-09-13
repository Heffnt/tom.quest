import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./clone-desktop-session.mjs", import.meta.url));
const CURRENT_ACCOUNT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CURRENT_ORG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SOURCE_ACCOUNT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOURCE_ORG = "dddddddd-dddd-dddd-dddd-dddddddddddd";

let fixture;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function record(title, overrides = {}) {
  return {
    sessionId: `desktop-${title}`,
    cliSessionId: `cli-${title}`,
    title,
    cwd: `C:\\work\\${title}`,
    worktreePath: `C:\\trees\\${title}`,
    branch: "feature/test",
    createdAt: "2026-09-12T10:00:00.000Z",
    lastActivityAt: "2026-09-13T15:30:00.000Z",
    isArchived: false,
    bridgeSessionIds: ["live-bridge"],
    error: "stale banner",
    errorAt: "2026-09-13T15:31:00.000Z",
    nested: { untouched: [1, "two", { three: true }] },
    ...overrides,
  };
}

function sourceFile(name) {
  return path.join(fixture.source, name);
}

function destinationFile(name) {
  return path.join(fixture.destination, name);
}

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--root", fixture.root, "--home", fixture.home], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });
}

function ledger() {
  return JSON.parse(fs.readFileSync(path.join(fixture.home, ".claude", "clone-desktop-session-ledger.json"), "utf8"));
}

beforeEach(() => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clone-desktop-session-"));
  const claudeApp = path.join(temporary, "appdata", "Claude");
  fixture = {
    temporary,
    home: path.join(temporary, "home"),
    root: path.join(claudeApp, "claude-code-sessions"),
  };
  fixture.destination = path.join(fixture.root, CURRENT_ACCOUNT, CURRENT_ORG);
  fixture.source = path.join(fixture.root, SOURCE_ACCOUNT, SOURCE_ORG);
  fs.mkdirSync(fixture.destination, { recursive: true });
  fs.mkdirSync(fixture.source, { recursive: true });
  writeJson(path.join(claudeApp, "config.json"), { lastKnownAccountUuid: CURRENT_ACCOUNT });
  writeJson(path.join(fixture.home, ".claude.json"), {
    oauthAccount: {
      emailAddress: "current@example.test",
      accountUuid: CURRENT_ACCOUNT,
      organizationUuid: CURRENT_ORG,
      tokenThatMustNotMatter: "fixture-secret",
    },
  });
  writeJson(path.join(fixture.home, ".claude", "clone-desktop-session-labels.json"), {
    version: 1,
    labels: [{
      emailAddress: "source@example.test",
      accountUuid: SOURCE_ACCOUNT,
      organizationUuid: SOURCE_ORG,
    }],
  });
  writeJson(sourceFile("local_alpha.json"), record("Alpha investigation"));
  writeJson(sourceFile("local_alpha_two.json"), record("Alpha follow-up", { lastActivityAt: "2026-09-13T16:00:00.000Z" }));
  writeJson(sourceFile("local_archived.json"), record("Archived Alpha", { isArchived: true }));
  writeJson(sourceFile("local_unique.json"), record("Unique handoff", { customField: "preserve me" }));
});

afterEach(() => {
  fs.rmSync(fixture.temporary, { recursive: true, force: true });
});

describe("clone-desktop-session", () => {
  test("list labels the current folder and prints only non-archived sessions", () => {
    const result = run("list");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${CURRENT_ACCOUNT}/${CURRENT_ORG} \\[current, current@example\\.test\\]`));
    assert.match(result.stdout, /source@example\.test/);
    assert.match(result.stdout, /Unique handoff/);
    assert.match(result.stdout, /last active:/);
    assert.match(result.stdout, /worktree\/cwd:/);
    assert.match(result.stdout, /isArchived: false/);
    assert.doesNotMatch(result.stdout, /Archived Alpha/);
  });

  test("pull copies one title, drops only live-state keys, and writes no BOM", () => {
    const before = JSON.parse(fs.readFileSync(sourceFile("local_unique.json"), "utf8"));
    const result = run("pull", "unique", "--from", "source@example.test");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /COPIED "Unique handoff"/);
    assert.match(result.stdout, /If it does not appear in the sidebar within a minute/);
    const bytes = fs.readFileSync(destinationFile("local_unique.json"));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const actual = JSON.parse(bytes.toString("utf8"));
    const expected = { ...before };
    delete expected.bridgeSessionIds;
    delete expected.error;
    delete expected.errorAt;
    assert.deepEqual(actual, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  });

  test("pull refuses to overwrite an existing destination", () => {
    writeJson(destinationFile("local_unique.json"), { title: "owned destination" });
    const result = run("pull", "unique");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SKIP local_unique\.json: already exists/);
    assert.deepEqual(JSON.parse(fs.readFileSync(destinationFile("local_unique.json"), "utf8")), {
      title: "owned destination",
    });
    assert.equal(fs.existsSync(path.join(fixture.home, ".claude", "clone-desktop-session-ledger.json")), false);
  });

  test("pull refuses ambiguous title matches without --all", () => {
    const result = run("pull", "alpha");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Multiple sessions match/);
    assert.match(result.stderr, /use a more specific title or add --all/);
    assert.equal(fs.existsSync(destinationFile("local_alpha.json")), false);
    assert.equal(fs.existsSync(destinationFile("local_alpha_two.json")), false);
  });

  test("--all copies every non-archived title match", () => {
    const result = run("pull", "alpha", "--all");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(destinationFile("local_alpha.json")), true);
    assert.equal(fs.existsSync(destinationFile("local_alpha_two.json")), true);
    assert.equal(fs.existsSync(destinationFile("local_archived.json")), false);
    assert.equal(ledger().entries.length, 2);
  });

  test("undo deletes only matching ledger entries", () => {
    assert.equal(run("pull", "unique").status, 0);
    writeJson(destinationFile("local_untracked.json"), record("Unique untracked"));
    const result = run("undo", "unique");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), false);
    assert.equal(fs.existsSync(destinationFile("local_untracked.json")), true);
    assert.equal(ledger().entries.length, 0);
  });

  test("undo refuses a matching file that is not in the ledger", () => {
    writeJson(destinationFile("local_untracked.json"), record("Unique untracked"));
    const result = run("undo", "unique");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no tool-created records/);
    assert.equal(fs.existsSync(destinationFile("local_untracked.json")), true);
  });

  test("pull dry-run writes no record, ledger, or learned label", () => {
    const labelsFile = path.join(fixture.home, ".claude", "clone-desktop-session-labels.json");
    const labelsBefore = fs.readFileSync(labelsFile, "utf8");
    const result = run("pull", "unique", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WOULD COPY/);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.home, ".claude", "clone-desktop-session-ledger.json")), false);
    assert.equal(fs.readFileSync(labelsFile, "utf8"), labelsBefore);
  });

  test("undo dry-run leaves the record and ledger unchanged", () => {
    assert.equal(run("pull", "unique").status, 0);
    const ledgerBefore = fs.readFileSync(path.join(fixture.home, ".claude", "clone-desktop-session-ledger.json"), "utf8");
    const result = run("undo", "unique", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WOULD DELETE/);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), true);
    assert.equal(fs.readFileSync(path.join(fixture.home, ".claude", "clone-desktop-session-ledger.json"), "utf8"), ledgerBefore);
  });
});
