#!/usr/bin/env bash
# Run this after the proof session and its Claude subagent have ended. The
# subagent must have run tts-codex with TTS_RUN_PARENT_RUN_ID set to its own
# run id. Example arguments name only the three resulting files and the
# Convex session row id; successful stdout is exactly the four lines below.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --input-type=module - "$script_dir" "$@" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scriptDir = process.argv[2];
const argv = process.argv.slice(3);
const args = {};
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--session") args.session = argv[++index];
  else if (argv[index] === "--subagent") args.subagent = argv[++index];
  else if (argv[index] === "--codex") args.codex = argv[++index];
  else if (argv[index] === "--session-row-id") args.sessionRowId = argv[++index];
  else if (argv[index] === "--state") args.state = argv[++index];
}
if (!args.session || !args.subagent || !args.codex || !args.sessionRowId) {
  throw new Error("usage: proof-box.sh --session <root.jsonl> --subagent <agent.jsonl> --codex <rollout.jsonl> --session-row-id <Convex id> [--state <dir>]");
}

const at = (name) => import(pathToFileURL(path.join(scriptDir, name)).href);
const [{ runConfig }, { describeRunFile }, { parseClaudeFile, parseCodexFile }, { mergeRegistration, readRegistration }, { sweepRuns }] = await Promise.all([
  at("config.mjs"),
  at("discover.mjs"),
  at("ingest.mjs"),
  at("registration.mjs"),
  at("sweep.mjs"),
]);
const config = runConfig();
if (config.host !== "box") throw new Error("RUN_HOST must be box");
if (!config.convexSiteUrl || !config.sessionsKey) throw new Error("CONVEX_SITE_URL and SESSIONS_WORKER_KEY are required");
if (args.state) config.stateDir = path.resolve(args.state);

const send = async (route, body) => {
  if (!route.startsWith("/runs/")) return { ok: true };
  const response = await fetch(`${config.convexSiteUrl.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sessions-Key": config.sessionsKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
  return await response.json();
};

const files = [args.session, args.subagent, args.codex].map((file) => path.resolve(file));
for (const file of files) {
  const result = await sweepRuns({ config, file, post: send });
  if (!result.started) throw new Error("a proof sweep could not start");
}

const itemOf = (file) => describeRunFile(file, { roots: config.roots, host: "box" });
const rootItem = itemOf(files[0]); const childItem = itemOf(files[1]); const codexItem = itemOf(files[2]);
if (!rootItem || !childItem || !codexItem) throw new Error("a proof file could not be classified");
const rootThread = path.basename(files[0], ".jsonl");
const agentId = childItem.threadId.split("/").at(-1);
let agentMeta = { agentId, spawnDepth: 1 };
try { agentMeta = { ...JSON.parse(fs.readFileSync(files[1].replace(/\.jsonl$/i, ".meta.json"), "utf8")), agentId }; } catch {}
const dummyVersion = "0".repeat(64);
const parsedRoot = mergeRegistration({ parsed: parseClaudeFile({ path: files[0], text: fs.readFileSync(files[0], "utf8"), host: "box", fileVersion: dummyVersion }), envelope: readRegistration(files[0]), host: "box" });
const parsedChild = mergeRegistration({ parsed: parseClaudeFile({ path: files[1], text: fs.readFileSync(files[1], "utf8"), host: "box", fileVersion: dummyVersion, agentMeta, parentSessionId: rootThread }), envelope: readRegistration(files[1]), host: "box" });
const parsedCodex = mergeRegistration({ parsed: parseCodexFile({ path: files[2], text: fs.readFileSync(files[2], "utf8"), host: "box", fileVersion: dummyVersion }), envelope: readRegistration(files[2]), host: "box" });
const parsed = [parsedRoot, parsedChild, parsedCodex];
if (!parsedChild.run.linkKnown || !parsedChild.run.spawnedByToolUseId) throw new Error("the subagent hook carried no exact tool-use link");
if (parsedCodex.run.parentRunId !== parsedChild.run.runId) throw new Error("the Codex launcher did not name the subagent parent");

const manifest = [];
let cursor = null;
do {
  const url = new URL(`${config.convexSiteUrl.replace(/\/+$/, "")}/runs/manifest`);
  url.searchParams.set("since", "0");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, { headers: { "X-Sessions-Key": config.sessionsKey } });
  if (!response.ok) throw new Error(`/runs/manifest failed with HTTP ${response.status}`);
  const page = await response.json();
  manifest.push(...(page.entries ?? []));
  cursor = page.nextCursor ?? null;
} while (cursor);
const latest = new Map();
for (const entry of manifest) if (parsed.some((result) => result.run.runId === entry.run_id)) latest.set(entry.run_id, entry);
for (const result of parsed) {
  const entry = latest.get(result.run.runId);
  if (!entry || entry.depth !== result.run.depth || (entry.parent_run_id ?? undefined) !== result.run.parentRunId) throw new Error(`manifest tree mismatch for ${result.run.runId}`);
}

const compareResponse = await fetch(`${config.convexSiteUrl.replace(/\/+$/, "")}/runs/compare`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Sessions-Key": config.sessionsKey },
  body: JSON.stringify({ sessionId: args.sessionRowId }),
});
if (!compareResponse.ok) throw new Error(`/runs/compare failed with HTTP ${compareResponse.status}`);
const comparison = await compareResponse.json();
const rowDiffs = Object.values(comparison.byKind ?? {}).reduce((sum, value) => sum + Math.abs(Number(value.daemon ?? 0) - Number(value.file ?? 0)), 0);

for (const result of parsed) {
  console.log(`run id=${result.run.runId} depth=${result.run.depth} rows=${result.rows.length} tokens=${Number(result.run.outcome?.totals?.totalTokens ?? 0)}`);
}
console.log(`comparison clean=${comparison.clean === true} textDiffs=${comparison.firstDiffSeq === undefined ? 0 : 1} rowCountDiffs=${rowDiffs}`);
NODE
