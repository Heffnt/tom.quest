import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// vitest, like every other test in this repository: `npx vitest run` collects
// every *.test.mjs, and a file importing node:test cannot even be loaded by it.
import { afterEach, beforeEach, describe, test } from "vitest";

// Resolved from the repository root, the way every other script test spells it:
// under the test runner `import.meta.url` is not always a file URL.
const SCRIPT = path.resolve("scripts/clone-desktop-session.mjs");
const CURRENT_ACCOUNT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CURRENT_ORG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SECOND_CURRENT_ORG = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
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
    createdAt: 1789207200000,
    lastActivityAt: 1789313400000,
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
      emailAddress: "source@example.test",
      accountUuid: SOURCE_ACCOUNT,
      organizationUuid: SOURCE_ORG,
      tokenThatMustNotMatter: "fixture-secret",
    },
  });
  writeJson(path.join(fixture.home, ".claude", "clone-desktop-session-labels.json"), {
    version: 1,
    labels: [],
  });
  writeJson(sourceFile("local_alpha.json"), record("Alpha investigation"));
  writeJson(sourceFile("local_alpha_two.json"), record("Alpha follow-up", { lastActivityAt: 1789315200000 }));
  writeJson(sourceFile("local_archived.json"), record("Archived Alpha", { isArchived: true }));
  writeJson(sourceFile("local_unique.json"), record("Unique handoff", { customField: "preserve me" }));
});

afterEach(() => {
  fs.rmSync(fixture.temporary, { recursive: true, force: true });
});

describe("clone-desktop-session", () => {
  test("list trusts the desktop account and labels the different CLI account", () => {
    const result = run("list");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${CURRENT_ACCOUNT}/${CURRENT_ORG} \\[current\\]`));
    assert.match(result.stdout, /source@example\.test/);
    assert.match(result.stdout, /Unique handoff/);
    assert.match(result.stdout, /last active:/);
    assert.match(result.stdout, /worktree\/cwd:/);
    assert.match(result.stdout, /isArchived: false/);
    assert.doesNotMatch(result.stdout, /Archived Alpha/);
    const labels = JSON.parse(fs.readFileSync(
      path.join(fixture.home, ".claude", "clone-desktop-session-labels.json"),
      "utf8",
    )).labels;
    assert.deepEqual(labels.find((label) => label.emailAddress === "source@example.test"), {
      emailAddress: "source@example.test",
      accountUuid: SOURCE_ACCOUNT,
      organizationUuid: SOURCE_ORG,
    });
  });

  test("list formats numeric activity timestamps and orders newest first", () => {
    const result = run("list");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"Alpha follow-up" \| last active: (?!unknown)[^|]+ \|/);
    assert.ok(
      result.stdout.indexOf('"Alpha follow-up"') < result.stdout.indexOf('"Alpha investigation"'),
      result.stdout,
    );
  });

  test("account disagreement does not prevent pull or undo", () => {
    const pulled = run("pull", "unique", "--from", "source@example.test");
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), true);
    const undone = run("undo", "unique");
    assert.equal(undone.status, 0, undone.stderr);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), false);
  });

  test("missing CLI identity is ignored and provides no label", () => {
    fs.unlinkSync(path.join(fixture.home, ".claude.json"));
    const listed = run("list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /source@example\.test/);
    const pulled = run("pull", "unique");
    assert.equal(pulled.status, 0, pulled.stderr);
    const undone = run("undo", "unique");
    assert.equal(undone.status, 0, undone.stderr);
  });

  test("malformed CLI identity is ignored", () => {
    fs.writeFileSync(path.join(fixture.home, ".claude.json"), "not JSON", "utf8");
    const result = run("list");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /source@example\.test/);
  });

  test("selects the only current-account org containing records", () => {
    const emptyOrg = path.join(fixture.root, CURRENT_ACCOUNT, SECOND_CURRENT_ORG);
    fs.mkdirSync(emptyOrg, { recursive: true });
    writeJson(destinationFile("local_current.json"), record("Current account record"));
    const result = run("list");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${CURRENT_ACCOUNT}/${CURRENT_ORG} \\[current\\]`));
    assert.match(result.stdout, new RegExp(`${CURRENT_ACCOUNT}/${SECOND_CURRENT_ORG}`));
  });

  test("refuses multiple current orgs with records and --org prefix selects one", () => {
    const secondOrg = path.join(fixture.root, CURRENT_ACCOUNT, SECOND_CURRENT_ORG);
    fs.mkdirSync(secondOrg, { recursive: true });
    writeJson(destinationFile("local_current.json"), record("First current org record"));
    writeJson(path.join(secondOrg, "local_second.json"), record("Second current org record"));

    const ambiguous = run("list");
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, new RegExp(CURRENT_ORG));
    assert.match(ambiguous.stderr, new RegExp(SECOND_CURRENT_ORG));
    assert.match(ambiguous.stderr, /use --org/);

    const selected = run("pull", "unique", "--org", "eeeeeeee", "--from", SOURCE_ACCOUNT.slice(0, 8));
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(fs.existsSync(path.join(secondOrg, "local_unique.json")), true);
    assert.equal(fs.existsSync(destinationFile("local_unique.json")), false);
  });

  test("reports when the desktop account has no session folder", () => {
    fs.rmSync(path.join(fixture.root, CURRENT_ACCOUNT), { recursive: true });
    const result = run("list");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /app has not created a session folder for this account yet/);
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
