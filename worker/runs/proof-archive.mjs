#!/usr/bin/env node
// proof-archive.mjs — ten archived sessions, imported out of WikiTom's gz.
//
// This proof runs on the laptop against the real archive and does not need the
// box: the archive is a WikiTom checkout and it is here, and a line's host comes
// from its manifest and never from the machine reading it. So ten `host: "box"`
// runs prove the archive source and the box host path without ssh.
//
// Structure and totals only, and the archive is read-only.

import fsDefault from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { archiveEntries } from "./backlog.mjs";
import { backlogProof } from "./proof-backlog.mjs";

const line = (...parts) => console.log(parts.join(" "));

/**
 * Import the newest `limit` archived runs. `host` picks which manifest's runs
 * are wanted, because the two manifests describe two machines and the laptop's
 * predates the host column entirely.
 */
export async function archiveProof({
  sessionsDir,
  stateDir,
  storeDir,
  limit = 10,
  fs = fsDefault,
  now = Date.now,
  say = line,
} = {}) {
  const built = archiveEntries({ sessionsDir });
  const byHost = built.entries.reduce((counts, entry) => ({ ...counts, [entry.host]: (counts[entry.host] ?? 0) + 1 }), {});
  const splits = built.entries.filter((entry) => entry.accountSplit);
  const workflows = built.entries.filter((entry) => (entry.children ?? []).some((child) => child.workflowId));
  say(`archive manifestLines=${built.manifestLines} parents=${built.entries.length} byHost=${JSON.stringify(byHost)}`);
  say(`archive workflowAgents=${built.workflowAgents} attachmentPointers=${built.attachmentPointers} unknownDest=${built.skippedUnknownDest}`);
  say(`archive accountSplitEntries=${splits.length} entriesWithWorkflowChildren=${workflows.length}`);

  const result = await backlogProof({
    source: "archive",
    stateDir,
    storeDir,
    sessionsDir,
    // The window here is a count of SESSIONS, not of runs: an archived parent
    // brings its children with it, and importing half a session's agents would
    // be a stranger thing to prove than importing ten whole ones.
    limit: 0,
    fs,
    now,
    say,
    // A Workflow's agents are the shape phase 3 changed and this import had to
    // be taught, so the window must hold at least one session that has them.
    // The newest such session is lifted to the front when the newest `limit`
    // sessions do not already include one; nothing is invented.
    curate: (listed) => {
      const has = (entry) => (entry.children ?? []).some((child) => child.workflowId);
      const head = listed.slice(0, limit);
      if (head.some(has)) return head;
      const found = listed.find(has);
      return found ? [found, ...head.slice(0, limit - 1)] : head;
    },
  });
  const chosen = result.ingests.map((body) => body.run);
  const splitIds = new Set(splits.map((entry) => entry.threadId));
  const hit = chosen.filter((run) => splitIds.has(run.runId.split(":").slice(2).join(":").split("/")[0]));
  say(hit.length
    ? `account-split among the chosen: ${hit.length} (the larger stored version is the one on the row)`
    : "account-split among the chosen: none");
  return result;
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
  if (!args.state || !args.sessions) {
    line('usage: node worker/runs/proof-archive.mjs --sessions "<WikiTom/sessions>" --state <scratch> [--limit 10]');
    process.exitCode = 2;
    return;
  }
  if (!/^(1|true|yes|on)$/i.test(String(process.env.RUN_BACKLOG_ALLOW_LOCAL_STORE ?? ""))) {
    line("refused: set RUN_BACKLOG_ALLOW_LOCAL_STORE=1 to import into a local scratch store");
    process.exitCode = 2;
    return;
  }
  await archiveProof({
    sessionsDir: path.resolve(args.sessions),
    stateDir: path.resolve(args.state),
    limit: Number(args.limit ?? 10),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`proof-archive failed: ${String(error?.message ?? error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
