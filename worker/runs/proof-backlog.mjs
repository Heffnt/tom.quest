#!/usr/bin/env node
// proof-backlog.mjs — the newest real files on this machine, imported into a
// scratch store and a scratch state directory.
//
// Structure and totals only: no row, no prompt, no source line, and no path
// beyond a basename. The store it writes is caller-owned scratch space and is
// never the production record; it reads `.claude/` and `.codex/` and writes
// nothing back to either.

import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BACKLOG_DEFAULTS } from "./config.mjs";
import { buildLists, backlogStatus, runBacklogPass } from "./backlog.mjs";
import { openStore } from "./store.mjs";

const line = (...parts) => console.log(parts.join(" "));

/** The default Claude and Codex trees on this machine, named once. */
export function laptopRoots(home = os.homedir()) {
  return {
    claude: [{ path: path.join(home, ".claude", "projects") }],
    codex: [{ path: path.join(home, ".codex", "sessions") }],
  };
}

/**
 * A config that points every writer at the scratch directory. The store is
 * local on purpose and the allowance is explicit: an import that writes
 * gigabytes onto the machine it exists to relieve is refused everywhere else.
 */
export function proofConfig({ stateDir, storeDir, host = "laptop", roots = laptopRoots(), sessionsDir }) {
  return {
    host,
    stateDir,
    storeConfig: { backend: "local", dir: storeDir },
    convexSiteUrl: null,
    sessionsKey: null,
    ttsKey: null,
    roots,
    flags: { backlog: false, deleteAfterUpload: false },
    backlog: { ...BACKLOG_DEFAULTS, allowLocalStore: true, ...(sessionsDir ? { sessionsDir } : {}) },
  };
}

/** Every index row a pass posted, in the order it posted them. */
export function recordingPost() {
  const calls = [];
  const post = async (route, body) => {
    calls.push({ route, body });
    return route === "/runs/ingest" ? { ok: true, committedLine: body.run?.file?.committedLine ?? 0 } : { ok: true };
  };
  post.calls = calls;
  post.ingests = () => calls.filter((call) => call.route === "/runs/ingest").map((call) => call.body);
  post.events = (kind) => calls.filter((call) => call.route === "/tts/event" && call.body.kind === kind).map((call) => call.body.data);
  return post;
}

const objectCount = (storeDir, fs) => {
  let total = 0;
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.isDirectory()) walk(path.join(dir, item.name));
      else total += 1;
    }
  };
  walk(storeDir);
  return total;
};

/**
 * Import the newest `limit` runs of one source into the scratch store, then do
 * it again and prove the second pass writes nothing.
 */
export async function backlogProof({
  source = "claude-live",
  stateDir,
  storeDir = path.join(stateDir, "store-objects"),
  host = "laptop",
  roots = laptopRoots(),
  sessionsDir,
  limit = 20,
  curate = null,
  fs = fsDefault,
  now = Date.now,
  say = line,
} = {}) {
  const config = proofConfig({ stateDir, storeDir, host, roots, sessionsDir });
  const store = openStore(config.storeConfig);

  const walkStart = now();
  const { built } = buildLists({ config, fs, now, sources: [source], log: () => {} });
  const walkMs = now() - walkStart;
  const list = built[0];
  say(`walk source=${source} files=${list.entries} runs=${list.runs} bytes=${list.bytes} walkMs=${walkMs}`);
  // How much of this machine's backlog is a Workflow's agents — the files the
  // importer used to count as skipped and now names as runs.
  const listFile = path.join(stateDir, "backlog", `list-${source}.jsonl`);
  const listed = fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row));
  const workflowEntries = listed.filter((entry) => entry.workflowId || (entry.children ?? []).some((child) => child.workflowId));
  say(`walk workflowAgentRuns=${workflowEntries.length} of=${listed.length}`);
  // A proof may ask for a particular shape to be inside the window it imports.
  // It reorders the list and says so; it never invents an entry.
  if (curate) {
    const curated = curate(listed, limit);
    if (curated !== listed) {
      fs.writeFileSync(listFile, `${curated.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
      say("walk curated=yes (the list was reordered so the window holds the shape this proof is about)");
    }
  }
  if (source === "archive") say(`archive manifestLines=${list.manifestLines ?? "-"} workflowAgents=${list.workflowAgents ?? 0} attachments=${list.attachmentPointers ?? 0}`);

  const post = recordingPost();
  const startedAt = now();
  const result = await runBacklogPass({ config, fs, now, post, store, log: () => {}, limit, source, gitTracked: () => false });
  const elapsedMs = now() - startedAt;
  const ingests = post.ingests();
  const pass = result.sources?.[0] ?? {};

  for (const body of ingests) {
    const run = body.run;
    const totals = run.outcome?.totals ?? {};
    say([
      `run=${run.runner}/${run.kind}`,
      `host=${run.host}`,
      `depth=${run.depth}`,
      `workflow=${run.context?.workflowId ?? "-"}`,
      `totalLines=${run.file.totalLines}`,
      `rows=${body.rows.length}`,
      `children=${body.children.length}`,
      `attachments=${run.attachments.length}`,
      `sourceBytes=${run.file.bytes}`,
      `storedBytes=${run.file.storedBytes}`,
      `key=…${String(run.file.storeKey ?? "").slice(-12)}`,
      `in=${totals.inputTokens ?? 0}`,
      `out=${totals.outputTokens ?? 0}`,
      `cost=${run.outcome?.costUsd ?? "-"}`,
      `committedLine=${run.file.committedLine}`,
    ].join(" "));
  }

  const objects = objectCount(storeDir, fs);
  const sourceBytes = pass.sourceBytes ?? 0;
  const storedBytes = pass.storedBytes ?? 0;
  say(`pass imported=${pass.imported ?? 0} already=${pass.alreadyImported ?? 0} duplicates=${pass.duplicates ?? 0} splits=${pass.accountSplits ?? 0} failed=${pass.failed ?? 0} tooLarge=${pass.skippedTooLarge ?? 0} pausedBy=${result.pausedBy ?? "none"}`);
  say(`bytes source=${sourceBytes} stored=${storedBytes} ratio=${sourceBytes ? (storedBytes / sourceBytes).toFixed(3) : "-"} objects=${objects} elapsedMs=${elapsedMs}`);
  const status = backlogStatus({ config, fs, now });
  say(`budget used=${status.budget.bytesUsed} perHour=${status.budget.bytesPerHour} windowRemainingMs=${status.budget.windowRemainingMs}`);
  say(`rowsWritten=${ingests.reduce((sum, body) => sum + body.rows.length, 0)} (an index row and no transcript rows is the whole point)`);

  // The second pass is the assertion: everything already imported is skipped in
  // O(1) off its state file, and not one new object reaches the store. The
  // cursor is wound back first, because a pass that simply continued would be
  // importing the NEXT twenty runs and proving nothing about these ones.
  // The list is cut to exactly the entries this pass consumed and the cursor
  // wound back to zero, so the second pass is the SAME work again rather than
  // the next twenty runs — which would prove nothing about these ones.
  const backlogDirectory = path.join(stateDir, "backlog");
  const consumed = fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean).slice(0, pass.cursor ?? 0);
  fs.writeFileSync(listFile, `${consumed.join("\n")}\n`, { mode: 0o600 });
  const cursorFile = path.join(backlogDirectory, "cursor.json");
  const cursors = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  fs.writeFileSync(cursorFile, JSON.stringify({ ...cursors, [source]: 0 }), { mode: 0o600 });
  const second = recordingPost();
  const again = await runBacklogPass({ config, fs, now, post: second, store, log: () => {}, limit: 0, source, gitTracked: () => false });
  const againPass = again.sources?.[0] ?? {};
  const objectsAfter = objectCount(storeDir, fs);
  say(`rerun entries=${consumed.length} imported=${againPass.imported ?? 0} already=${againPass.alreadyImported ?? 0} newObjects=${objectsAfter - objects} newIngests=${second.ingests().length}`);
  if ((againPass.imported ?? 0) !== 0 || objectsAfter !== objects || second.ingests().length !== 0) {
    throw new Error("a second pass imported something; the skip is not idempotent");
  }
  return { config, store, storeDir, ingests, pass, walkMs, elapsedMs, objects };
}

function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.state) {
    line("usage: node worker/runs/proof-backlog.mjs --state <scratch> [--limit 20] [--source claude-live]");
    process.exitCode = 2;
    return;
  }
  if (!/^(1|true|yes|on)$/i.test(String(process.env.RUN_BACKLOG_ALLOW_LOCAL_STORE ?? ""))) {
    line("refused: set RUN_BACKLOG_ALLOW_LOCAL_STORE=1 to import into a local scratch store");
    process.exitCode = 2;
    return;
  }
  await backlogProof({
    stateDir: path.resolve(args.state),
    limit: Number(args.limit ?? 20),
    source: args.source ?? "claude-live",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`proof-backlog failed: ${String(error?.message ?? error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
