#!/usr/bin/env node
/**
 * Clone Claude desktop sidebar records between accounts on this machine.
 * Transcripts are shared, but the desktop indexes sessions per account/org.
 * Copies keep their desktop session IDs so existing worktree leases still fit.
 * Only records created by this tool can be removed with `undo`.
 *
 * Usage:
 *   node scripts/clone-desktop-session.mjs list
 *   node scripts/clone-desktop-session.mjs pull "title" [--from account-or-email] [--all]
 *   node scripts/clone-desktop-session.mjs undo "title"
 *   Add --root <dir>, --home <dir>, or --dry-run as needed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DROP_KEYS = ["bridgeSessionIds", "error", "errorAt"];
const RECORD_PATTERN = /^local_.+\.json$/;
const KNOWN_LABELS = [{
  emailAddress: "ntheffernan@wpi.edu",
  accountUuid: "26454c9d-4301-4636-8348-6fefa877ef6c",
  organizationUuid: "ed2cc159-af2f-4c1a-822a-0787a572e3a1",
}];

const HELP = `Usage:
  node scripts/clone-desktop-session.mjs list [--root <dir>] [--home <dir>] [--dry-run]
  node scripts/clone-desktop-session.mjs pull <title substring> [--from <accountUuid-or-email-or-prefix>] [--all] [--root <dir>] [--home <dir>] [--dry-run]
  node scripts/clone-desktop-session.mjs undo <title substring> [--root <dir>] [--home <dir>] [--dry-run]

Commands:
  list   Show account/org folders and their non-archived desktop sessions.
  pull   Copy matching sidebar records into the currently logged-in account.
  undo   Remove matching records created by this tool from the current account.

Options:
  --from <value>  Choose a source by account UUID, email label, or prefix.
  --all           Pull every title match instead of refusing an ambiguous match.
  --root <dir>    Override the claude-code-sessions root (useful for tests).
  --home <dir>    Override the home containing .claude.json and tool state.
  --dry-run       Print actions without writing or deleting anything.
  -h, --help      Show this help.`;

function refuse(message) {
  const error = new Error(message);
  error.isRefusal = true;
  throw error;
}

function parseArgs(argv) {
  const options = { all: false, dryRun: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (["--from", "--root", "--home"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) refuse(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) refuse(`unknown option: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function readJson(file, description) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    refuse(`cannot read ${description} at ${file}: ${error.message}`);
  }
}

function readOptionalJson(file, fallback, description) {
  if (!fs.existsSync(file)) return fallback;
  return readJson(file, description);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created, or rename may have consumed it.
    }
    throw error;
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function discoverFolders(root) {
  if (!fs.existsSync(root)) refuse(`sessions root does not exist: ${root}`);
  const folders = [];
  for (const accountEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!accountEntry.isDirectory()) continue;
    const accountPath = path.join(root, accountEntry.name);
    for (const orgEntry of fs.readdirSync(accountPath, { withFileTypes: true })) {
      if (!orgEntry.isDirectory()) continue;
      folders.push({
        accountUuid: accountEntry.name,
        organizationUuid: orgEntry.name,
        path: path.join(accountPath, orgEntry.name),
      });
    }
  }
  return folders.sort((a, b) => a.path.localeCompare(b.path));
}

function stringsIn(value, result = new Set()) {
  if (typeof value === "string") result.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, result);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      result.add(key);
      stringsIn(item, result);
    }
  }
  return result;
}

function archivedNames(folder) {
  const indexFile = path.join(folder.path, "archived-sessions.idx");
  if (!fs.existsSync(indexFile)) return new Set();
  const text = fs.readFileSync(indexFile, "utf8");
  try {
    return stringsIn(JSON.parse(text));
  } catch {
    return new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
}

function recordsIn(folder, { includeArchived = false } = {}) {
  const archived = archivedNames(folder);
  const records = [];
  for (const entry of fs.readdirSync(folder.path, { withFileTypes: true })) {
    if (!entry.isFile() || !RECORD_PATTERN.test(entry.name)) continue;
    const file = path.join(folder.path, entry.name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.error(`WARN ${file}: invalid JSON (${error.message})`);
      continue;
    }
    const isArchived = record.isArchived === true
      || archived.has(entry.name)
      || archived.has(path.basename(entry.name, ".json"))
      || (typeof record.sessionId === "string" && archived.has(record.sessionId));
    if (!includeArchived && isArchived) continue;
    records.push({ file, name: entry.name, record, isArchived });
  }
  return records.sort((a, b) => {
    const right = Date.parse(b.record.lastActivityAt ?? "") || 0;
    const left = Date.parse(a.record.lastActivityAt ?? "") || 0;
    return right - left || a.name.localeCompare(b.name);
  });
}

function loadIdentity(root, home) {
  const configFile = path.join(path.dirname(root), "config.json");
  const identityFile = path.join(home, ".claude.json");
  const config = readJson(configFile, "Claude desktop config");
  const identity = readJson(identityFile, "Claude login identity");
  const accountUuid = config.lastKnownAccountUuid;
  const oauth = identity.oauthAccount;
  if (!accountUuid || typeof accountUuid !== "string") {
    refuse(`Claude desktop config has no lastKnownAccountUuid: ${configFile}`);
  }
  if (!oauth || typeof oauth !== "object"
      || typeof oauth.accountUuid !== "string"
      || typeof oauth.organizationUuid !== "string") {
    refuse(`Claude login identity is missing its account/org pair: ${identityFile}`);
  }
  if (oauth.accountUuid !== accountUuid) {
    refuse("Claude desktop config and login identity disagree about the current account");
  }
  return {
    accountUuid,
    organizationUuid: oauth.organizationUuid,
    emailAddress: typeof oauth.emailAddress === "string" ? oauth.emailAddress : undefined,
  };
}

function stateFiles(home) {
  const claudeHome = path.join(home, ".claude");
  return {
    labels: path.join(claudeHome, "clone-desktop-session-labels.json"),
    ledger: path.join(claudeHome, "clone-desktop-session-ledger.json"),
  };
}

function loadLabels(file) {
  const stored = readOptionalJson(file, { version: 1, labels: [] }, "label cache");
  if (!stored || !Array.isArray(stored.labels)) refuse(`invalid label cache: ${file}`);
  const valid = stored.labels.filter((label) => label
    && typeof label.emailAddress === "string"
    && typeof label.accountUuid === "string"
    && typeof label.organizationUuid === "string");
  const cachedPairs = new Set(valid.map((label) => `${label.accountUuid}\0${label.organizationUuid}`));
  return [...KNOWN_LABELS.filter((label) => !cachedPairs.has(`${label.accountUuid}\0${label.organizationUuid}`)), ...valid];
}

function learnCurrentLabel(file, labels, current, dryRun) {
  if (!current.emailAddress) return labels;
  const remaining = labels.filter((label) => !(
    label.emailAddress.toLowerCase() === current.emailAddress.toLowerCase()
    || (label.accountUuid === current.accountUuid
      && label.organizationUuid === current.organizationUuid)
  ));
  const next = [...remaining, current];
  if (!dryRun) writeJson(file, { version: 1, labels: next });
  return next;
}

function labelFor(folder, labels) {
  return labels.find((label) => label.accountUuid === folder.accountUuid
    && label.organizationUuid === folder.organizationUuid)?.emailAddress;
}

function currentFolder(folders, current) {
  const folder = folders.find((candidate) => candidate.accountUuid === current.accountUuid
    && candidate.organizationUuid === current.organizationUuid);
  if (!folder) {
    refuse(`current account/org folder does not exist: ${current.accountUuid}/${current.organizationUuid}`);
  }
  return folder;
}

function folderName(folder, labels, current) {
  const markers = [];
  if (folder.accountUuid === current.accountUuid
      && folder.organizationUuid === current.organizationUuid) markers.push("current");
  const email = labelFor(folder, labels);
  if (email) markers.push(email);
  const suffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
  return `${folder.accountUuid}/${folder.organizationUuid}${suffix}`;
}

function formatTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? "unknown" : new Date(parsed).toLocaleString();
}

function listCommand(context) {
  for (const folder of context.folders) {
    console.log(folderName(folder, context.labels, context.current));
    const records = recordsIn(folder);
    if (records.length === 0) {
      console.log("  (no non-archived sessions)");
      continue;
    }
    for (const { record, isArchived } of records) {
      const location = record.worktreePath || record.cwd || "unknown";
      console.log(`  ${JSON.stringify(record.title ?? "(untitled)")} | last active: ${formatTime(record.lastActivityAt)} | worktree/cwd: ${location} | isArchived: ${isArchived}`);
    }
  }
  return 0;
}

function sourceFolder(context, from) {
  const others = context.folders.filter((folder) => !samePath(folder.path, context.destination.path));
  if (!from) {
    const withRecords = others.filter((folder) => recordsIn(folder, { includeArchived: true }).length > 0);
    if (withRecords.length !== 1) {
      refuse(`found ${withRecords.length} other account/org folders with records; use --from to choose one`);
    }
    return withRecords[0];
  }
  const needle = from.toLowerCase();
  const matches = others.filter((folder) => {
    const email = labelFor(folder, context.labels)?.toLowerCase();
    return folder.accountUuid.toLowerCase().startsWith(needle)
      || (email && email.startsWith(needle));
  });
  if (matches.length !== 1) {
    const detail = matches.length === 0 ? "no folders match" : `${matches.length} folders match`;
    refuse(`${detail} --from ${JSON.stringify(from)}`);
  }
  return matches[0];
}

function loadLedger(file) {
  const ledger = readOptionalJson(file, { version: 1, entries: [] }, "clone ledger");
  if (!ledger || !Array.isArray(ledger.entries)) refuse(`invalid clone ledger: ${file}`);
  return ledger;
}

function pullCommand(context, query, options) {
  const source = sourceFolder(context, options.from);
  const needle = query.toLowerCase();
  const matches = recordsIn(source).filter(({ record }) =>
    typeof record.title === "string" && record.title.toLowerCase().includes(needle));
  if (matches.length === 0) refuse(`no non-archived titles in the source match ${JSON.stringify(query)}`);
  if (matches.length > 1 && !options.all) {
    console.error(`Multiple sessions match ${JSON.stringify(query)}:`);
    for (const match of matches) console.error(`  ${match.record.title} (${match.name})`);
    refuse("use a more specific title or add --all");
  }

  const ledger = loadLedger(context.state.ledger);
  let refused = false;
  for (const match of matches) {
    const destination = path.join(context.destination.path, match.name);
    if (fs.existsSync(destination)) {
      console.error(`SKIP ${match.name}: already exists in the current account folder`);
      refused = true;
      continue;
    }
    const copy = { ...match.record };
    const dropped = DROP_KEYS.filter((key) => Object.hasOwn(copy, key));
    for (const key of DROP_KEYS) delete copy[key];
    const output = JSON.stringify(copy);
    const action = options.dryRun ? "WOULD COPY" : "COPIED";
    if (!options.dryRun) {
      try {
        fs.writeFileSync(destination, output, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") {
          console.error(`SKIP ${match.name}: appeared in the current account folder before it could be copied`);
          refused = true;
          continue;
        }
        throw error;
      }
      ledger.entries.push({
        sourcePath: match.file,
        destinationPath: destination,
        createdAt: new Date().toISOString(),
        title: copy.title,
      });
      try {
        writeJson(context.state.ledger, ledger);
      } catch (error) {
        fs.unlinkSync(destination);
        throw new Error(`copy was rolled back because its ledger entry could not be saved: ${error.message}`);
      }
    }
    console.log(`${action} ${JSON.stringify(copy.title ?? "(untitled)")} (${match.name}; dropped: ${dropped.join(", ") || "none"})`);
  }
  console.log("If it does not appear in the sidebar within a minute, restart the Claude desktop app.");
  return refused ? 1 : 0;
}

function safeLedgerEntry(entry, destinationFolder) {
  return entry
    && typeof entry.destinationPath === "string"
    && typeof entry.title === "string"
    && RECORD_PATTERN.test(path.basename(entry.destinationPath))
    && samePath(path.dirname(entry.destinationPath), destinationFolder.path);
}

function undoCommand(context, query, options) {
  const ledger = loadLedger(context.state.ledger);
  const needle = query.toLowerCase();
  const matches = ledger.entries.filter((entry) => safeLedgerEntry(entry, context.destination)
    && entry.title.toLowerCase().includes(needle));
  if (matches.length === 0) refuse(`no tool-created records in the current account match ${JSON.stringify(query)}`);

  const removed = new Set();
  for (const entry of matches) {
    if (fs.existsSync(entry.destinationPath)) {
      if (!options.dryRun) fs.unlinkSync(entry.destinationPath);
      console.log(`${options.dryRun ? "WOULD DELETE" : "DELETED"} ${JSON.stringify(entry.title)} (${path.basename(entry.destinationPath)})`);
    } else {
      console.log(`MISSING ${JSON.stringify(entry.title)} (${path.basename(entry.destinationPath)}); removing its stale ledger entry`);
    }
    removed.add(entry);
  }
  if (!options.dryRun) {
    ledger.entries = ledger.entries.filter((entry) => !removed.has(entry));
    writeJson(context.state.ledger, ledger);
  }
  return 0;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const [command, ...operands] = options.positional;
  if (!command || !["list", "pull", "undo"].includes(command)) refuse("expected one command: list, pull, or undo");
  if (command === "list" && operands.length !== 0) refuse("list takes no title");
  if ((command === "pull" || command === "undo") && operands.length !== 1) {
    refuse(`${command} requires exactly one title substring`);
  }
  if (operands[0] === "") refuse("title substring must not be empty");
  if (command !== "pull" && (options.from || options.all)) refuse("--from and --all are only valid with pull");

  const home = path.resolve(options.home ?? os.homedir());
  const root = path.resolve(options.root
    ?? path.join(process.env.APPDATA ?? "", "Claude", "claude-code-sessions"));
  if (!options.root && !process.env.APPDATA) refuse("APPDATA is not set; pass --root explicitly");
  const current = loadIdentity(root, home);
  const folders = discoverFolders(root);
  const state = stateFiles(home);
  let labels = loadLabels(state.labels);
  labels = learnCurrentLabel(state.labels, labels, current, options.dryRun);
  const context = {
    current,
    folders,
    labels,
    state,
    destination: currentFolder(folders, current),
  };

  if (command === "list") return listCommand(context);
  if (command === "pull") return pullCommand(context, operands[0], options);
  return undoCommand(context, operands[0], options);
}

function main() {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`clone-desktop-session: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
