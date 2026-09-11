#!/usr/bin/env node
// End-to-end sweep proof. With no deployment variables the CLI uses a small
// in-memory Convex-shaped adapter, so the documented command works in a
// credential-free checkout. convex/runs.proof.test.ts imports runSweepProof
// with a convexTest-backed post/inspect pair. To exercise a real deployment,
// set CONVEX_SITE_URL and SESSIONS_WORKER_KEY; their values are never printed.

import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { discoverRunFiles } from "./discover.mjs";
import { writeRegistrationClaim } from "./registration.mjs";
import { openStore } from "./store.mjs";
import { sweepRuns } from "./sweep.mjs";

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--claude") result.claude = argv[++index];
    else if (argv[index] === "--state") result.state = argv[++index];
  }
  return result;
}

function runIdOf(item) {
  return `${item.runtime}:${item.host}:${item.threadId}`;
}

function sourceKind(entry) {
  if (entry?.type === "system") return `system/${entry.subtype ?? "unknown"}`;
  if (entry?.type === "attachment") return `attachment/${entry.attachment?.type ?? "unknown"}`;
  return String(entry?.type ?? "unknown");
}

function filesUnder(directory, fs) {
  let found = [];
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) found = found.concat(filesUnder(file, fs));
      else if (entry.isFile()) found.push(file);
    }
  } catch {}
  return found;
}

function inMemoryAdapters() {
  const runs = new Map();
  const rows = new Map();
  const overflows = new Map();
  return {
    async post(route, body) {
      if (route === "/runs/overflow") {
        overflows.set(`${body.runId}:${body.seq}:${body.index}`, body);
        return { ok: true };
      }
      if (route === "/runs/overflow/stamp") return { ok: true };
      if (route !== "/runs/ingest") return { ok: true };
      const existing = runs.get(body.run.runId);
      // A run named as somebody's child before it was swept holds a stub file.
      // runs.internalIngest treats that stub as "no file yet" — no fence, and
      // the first real page replaces it — so this adapter has to as well, or a
      // subagent ingested after its parent would keep the stub forever.
      const stub = !existing?.file?.path;
      if (!stub) {
        if (body.previousCommittedLine !== existing.file.committedLine
          || body.previousPrefixSha256 !== existing.file.committedPrefixSha256) {
          return { ok: false, reason: "file rewritten" };
        }
      }
      const advances = !existing || stub || body.run.file.committedLine >= existing.file.committedLine;
      runs.set(body.run.runId, advances ? structuredClone(body.run) : existing);
      for (const child of body.children) {
        if (!runs.has(child.runId)) runs.set(child.runId, { ...structuredClone(child), outcome: { totals: {} }, file: { path: "", committedLine: 0, committedPrefixSha256: "" } });
      }
      let inserted = 0; let skipped = 0;
      for (const row of body.rows) {
        const key = `${body.run.runId}:${row.seq}`;
        if (rows.has(key)) skipped += 1;
        else { rows.set(key, { ...structuredClone(row), runId: body.run.runId }); inserted += 1; }
      }
      return { ok: true, runId: body.run.runId, inserted, skipped, committedLine: runs.get(body.run.runId).file.committedLine };
    },
    async inspect({ runIds }) {
      const wanted = new Set(runIds);
      return {
        runs: [...runs.values()].filter((run) => wanted.has(run.runId)).map((run) => structuredClone(run)),
        rows: [...rows.values()].filter((row) => wanted.has(row.runId)).map((row) => structuredClone(row)),
      };
    },
  };
}

function deploymentPost({ siteUrl, sessionsKey, fetch: fetchImpl = globalThis.fetch }) {
  return async (route, body) => {
    if (!route.startsWith("/runs/")) return { ok: true };
    const response = await fetchImpl(`${siteUrl.replace(/\/+$/, "")}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": sessionsKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
    return await response.json();
  };
}

/**
 * Drive the real discovery/store/sweeper path. `post(route, body)` implements
 * the three /runs routes; `inspect({rootRunId, runIds})` returns
 * `{ runs: Run[], rows: (RunRow & {runId})[] }` after ingestion.
 * @param {any} options
 * @returns {Promise<any>}
 */
export async function runSweepProof({
  claude,
  state,
  post,
  inspect,
  host = "laptop",
  fs = fsDefault,
  emit = (line) => console.log(line),
  now = Date.now,
} = {}) {
  if (!claude || !state) throw new Error("--claude and --state are required");
  const runFile = path.resolve(claude);
  const stateDir = path.resolve(state);
  const temporaryRoot = `${path.resolve(os.tmpdir()).replace(/[\\/]+$/, "")}${path.sep}`.toLowerCase();
  if (!`${stateDir}${path.sep}`.toLowerCase().startsWith(temporaryRoot)) throw new Error("proof state must be under the OS temp directory");
  if (!fs.statSync(runFile).isFile()) throw new Error("Claude proof file does not exist");

  writeRegistrationClaim({
    runFile,
    writer: { file: "worker/runs/proof-sweep.mjs", job: "runs-proof" },
    registration: {
      host,
      origin: "laptop",
      kind: "session",
      // What scripts/session-start-hook.mjs gives a laptop session: the stable
      // prefix is operate and write, and the know layer is expanded per subject
      // rather than given or denied whole.
      layersKnown: true,
      layersGiven: ["operate", "write"],
      layersDenied: [],
    },
    claim: { by: "proof:manual-envelope", threadId: path.basename(runFile, ".jsonl"), hookPayloadKeys: [] },
    fs,
    now,
  });

  const claudeRoot = path.dirname(path.dirname(runFile));
  const roots = { claude: [{ path: claudeRoot }], codex: [] };
  const discovered = discoverRunFiles({ roots, since: 0, host, fs })
    .filter((item) => item.kind === "root" || item.kind === "subagent")
    .filter((item) => item.path === runFile || item.threadId.startsWith(`${path.basename(runFile, ".jsonl")}/`));
  const rootItem = discovered.find((item) => item.path === runFile);
  if (!rootItem) throw new Error("proof root was not discovered");
  const ordered = [rootItem, ...discovered.filter((item) => item !== rootItem).sort((a, b) => a.threadId.localeCompare(b.threadId))];
  const runIds = ordered.map(runIdOf);
  const rootRunId = runIdOf(rootItem);
  const localStore = openStore({ backend: "local", dir: path.join(stateDir, "store") });
  const fallback = inMemoryAdapters();
  const deliver = post ?? fallback.post;
  const look = inspect ?? fallback.inspect;
  let inserted = 0;
  const countedPost = async (route, body) => {
    if (!route.startsWith("/runs/")) return { ok: true };
    const response = await deliver(route, body);
    if (post) await fallback.post(route, body);
    if (route === "/runs/ingest") inserted += Number(response?.inserted ?? 0);
    return response;
  };
  const proofConfig = {
    host,
    stateDir,
    storeConfig: { backend: "local", dir: path.join(stateDir, "store") },
    convexSiteUrl: null,
    sessionsKey: null,
    ttsKey: null,
    roots,
    flags: { backlog: true, deleteAfterUpload: false },
  };
  const pass = async () => {
    const before = inserted;
    for (const item of ordered) {
      const result = await sweepRuns({ config: proofConfig, file: item.path, store: localStore, post: countedPost, fs, now, log: () => {} });
      if (!result.started) throw new Error("proof sweep could not start");
    }
    return inserted - before;
  };
  const firstInserted = await pass();
  const secondInserted = await pass();
  const observed = await look({ rootRunId, runIds });
  if (!Array.isArray(observed?.runs) || !Array.isArray(observed?.rows)) throw new Error("proof inspector returned an invalid result");
  const byId = new Map(observed.runs.map((run) => [run.runId, run]));
  const runIdSet = new Set(runIds);
  const proofRows = observed.rows.filter((row) => runIdSet.has(row.runId));
  for (const runId of runIds) {
    const run = byId.get(runId);
    if (!run?.file?.path) throw new Error(`proof run missing: ${runId}`);
    if (runId === rootRunId && (run.depth !== 0 || run.parentRunId !== undefined)) throw new Error("proof root link is wrong");
    if (runId !== rootRunId && (run.depth < 1 || !run.parentRunId)) throw new Error(`proof child link is wrong: ${runId}`);
  }
  const root = byId.get(rootRunId);
  if (root.context?.registered !== true || root.context?.layersKnown !== true || root.origin !== "laptop" || root.kind !== "session" || !root.envelopeKey) {
    throw new Error("proof registration envelope was not applied");
  }

  const rowsByRun = new Map(runIds.map((runId) => [runId, proofRows.filter((row) => row.runId === runId)]));
  const objectFiles = filesUnder(path.join(stateDir, "store"), fs).filter((file) => file.endsWith(".gz"));
  const storedBytes = objectFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const totalTokens = observed.runs.reduce((sum, run) => sum + Number(run.outcome?.totals?.totalTokens ?? 0), 0);
  const priced = observed.runs.filter((run) => Number.isFinite(run.outcome?.costUsd));
  const totalCost = priced.reduce((sum, run) => sum + run.outcome.costUsd, 0);

  const sample = proofRows.find((row) => row.provenance?.sourceKind !== "context" && byId.has(row.runId));
  if (!sample) throw new Error("proof has no source row to inspect");
  const sampleRun = byId.get(sample.runId);
  const prefix = `${sampleRun.runner}:${sampleRun.host}:`;
  const threadId = sampleRun.runId.startsWith(prefix) ? sampleRun.runId.slice(prefix.length) : sampleRun.runId;
  const stored = localStore.get({ runtime: sampleRun.runner, host: sampleRun.host, threadId, fileVersion: sample.provenance.fileVersion });
  const raw = stored.toString("utf8").split("\n")[sample.provenance.lineStart];
  let exact = false;
  try { exact = sourceKind(JSON.parse(raw)) === sample.provenance.sourceKind; } catch {}
  if (!exact) throw new Error("proof provenance did not resolve to its stored source line");

  emit(`proof root=${rootRunId} subagents=${ordered.length - 1} firstInserted=${firstInserted} secondInserted=${secondInserted}`);
  for (const runId of runIds) {
    const run = byId.get(runId);
    const parent = run.parentRunId ?? "none";
    const cost = Number.isFinite(run.outcome?.costUsd) ? run.outcome.costUsd.toFixed(8) : "unpriced";
    emit(`run id=${runId} depth=${run.depth} parent=${parent} rows=${rowsByRun.get(runId).length} tokens=${Number(run.outcome?.totals?.totalTokens ?? 0)} cost=${cost}`);
  }
  // The shape of the tree, not just its size: one line per depth, and how
  // many of its children came out of a Workflow's nested folder.
  const byDepth = new Map();
  for (const runId of runIds) byDepth.set(byId.get(runId).depth, (byDepth.get(byId.get(runId).depth) ?? 0) + 1);
  const workflowRuns = runIds.filter((runId) => byId.get(runId).origin === "workflow");
  const workflowIds = new Set(workflowRuns.map((runId) => byId.get(runId).context?.workflowId).filter(Boolean));
  emit(`depth ${[...byDepth.keys()].sort((a, b) => a - b).map((depth) => `${depth}=${byDepth.get(depth)}`).join(" ")}`);
  emit(`workflow children=${workflowRuns.length} workflows=${workflowIds.size} named=${workflowRuns.filter((runId) => byId.get(runId).context?.workflowId).length}`);
  emit(`tree runs=${runIds.length} rows=${proofRows.length} tokens=${totalTokens} priced=${priced.length} cost=${totalCost.toFixed(8)}`);
  emit(`store objects=${objectFiles.length} storedBytes=${storedBytes}`);
  emit(`raw file=${path.basename(sampleRun.file.path)} line=${sample.provenance.lineStart} matched=true`);
  emit(`envelope registered=true layersKnown=true origin=${root.origin} kind=${root.kind} key=true`);
  emit(`idempotency secondInserted=${secondInserted}`);
  if (secondInserted !== 0) throw new Error("second proof sweep inserted rows");
  return { rootRunId, runIds, firstInserted, secondInserted, runs: observed.runs, rows: proofRows, objects: objectFiles.length, storedBytes };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.claude || !args.state) {
    console.error("usage: node worker/runs/proof-sweep.mjs --claude <session.jsonl> --state <OS-temp-directory>");
    process.exitCode = 2;
    return;
  }
  const siteUrl = process.env.CONVEX_SITE_URL;
  const sessionsKey = process.env.SESSIONS_WORKER_KEY;
  const post = siteUrl && sessionsKey ? deploymentPost({ siteUrl, sessionsKey }) : undefined;
  await runSweepProof({ ...args, post });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`runs proof failed: ${String(error?.message ?? error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}
