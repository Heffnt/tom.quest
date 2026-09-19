// runner-sensor.mjs — the facts a runner step sees before its model does.
//
// THE SENSOR RULE: a runner step observes through deterministic code and
// judges only. Before the model sees anything, the daemon runs this once in the
// step's own checkout and writes the facts block into the prompt under the
// document. The same facts ride the check-in (data.facts), so one step's
// numbers compare with the next's and the check-in renders numbers, not the
// model's paraphrase of them.
//
// THE FIELDS ARE FIXED, and every one is present on every step. A source that
// could not be read says so in its own field (`unavailable`), never by
// dropping the field, so a check-in with a missing number is visibly one.
//
//   jobs      the account's SLURM jobs, from `tts-turing jobs`
//   gpus      free GPUs by type, from `tts-turing gpus`
//   frontier  the runner's specs expanded to CMT's build frontier in the
//             checkout (_build_frontier(expand_specs(specs))), the nodes
//             known done on Turing, and the remainder
//   failures  step failures since the last check-in (handed in by the claim)
//   gpuHours  GPU-hours seen on this runner's own running jobs (named
//             runner:<id>:) since it began, against its budget; the pool's
//             jobs and Tom's own never count against it
//
// DONE-NESS IS READ ON TURING, AND IT IS BUDGETED. The results tree is on the
// cluster, not the box, and the read key opens one directory listing per call,
// so a node is done when its own listing holds done.json. A frontier runs to
// thousands of nodes, so each step checks at most CHECK_BUDGET of them and
// keeps what it learned in a cache: done.json is final, so a node once done is
// done for good and is never asked about again. A node whose directory is
// absent from its parent's listing is not done, and neither is anything under
// it. The facts say how many nodes were left unchecked, so an early step's
// count reads as a floor.
//
// The cache is a cache and nothing else: deleting it costs the next steps
// their checks again and loses no fact of record.

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const CHECK_BUDGET = 1500;
const CHECK_CONCURRENCY = 12;
const FACTS_VERSION = 1;
export const DEFAULT_CACHE_DIR = "/var/lib/tts/runners";

/** The Python the frontier count runs, in the checkout. It prints the frontier
 *  node paths relative to the output root, one JSON list. CMT_OUTPUT is a
 *  scratch root because expansion only names paths; nothing is written. */
const FRONTIER_PY = `
import json, sys
from pathlib import Path
sys.path.insert(0, ".")
from cmt.sweep.expand import expand_specs
from cmt.sweep.runner import _build_frontier
import os
root = Path(os.environ["CMT_OUTPUT"]).resolve()
specs = sorted({p for pattern in json.loads(sys.argv[1]) for p in Path(".").glob(pattern)})
if not specs:
    print(json.dumps({"error": "no spec matched"})); sys.exit(0)
frontier = _build_frontier(expand_specs(specs))
paths = [str(Path(step.path).resolve().relative_to(root)) for step in frontier.values()]
print(json.dumps({"specs": [str(p) for p in specs], "nodes": paths}))
`;

/** Default runners of the outside world, replaced in the test. */
const defaultDeps = {
  async turing(args) {
    const { stdout } = await execFile("tts-turing", [...args, "--raw"], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
  async python(cwd, program, args, env) {
    const { stdout } = await execFile("python3", ["-c", program, ...args], { cwd, env, timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split("\n").pop());
  },
  now: () => Date.now(),
};

/** Why a tts-turing read failed. Its first line names the cause (no read key,
 *  the status the API answered, the tunnel down); the lines after it are advice,
 *  and the last of them read alone said "every other verb is a 401" when the box
 *  simply had no key. */
function turingBecause(error) {
  const first = String(error?.stderr ?? "").split("\n").find((line) => line.startsWith("tts-turing: "));
  return first ? first.slice("tts-turing: ".length).trim().slice(0, 200) : because(error);
}

function because(error) {
  const text = String(error?.stderr || error?.message || error).trim().split("\n").pop() ?? "";
  return text.slice(0, 200) || "no reason given";
}

export function readCache(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      done: Array.isArray(cache.done) ? cache.done : [],
      jobs: cache.jobs && typeof cache.jobs === "object" ? cache.jobs : {},
      ...(typeof cache.budgetGpuHours === "number" ? { budgetGpuHours: cache.budgetGpuHours } : {}),
      ...(typeof cache.readAt === "number" ? { readAt: cache.readAt } : {}),
    };
  } catch {
    return { done: [], jobs: {} };
  }
}

function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(cache));
    fs.renameSync(temporary, file);
  } catch {
    // A cache that cannot be written costs the next step its checks, no more.
  }
}

/** A GPU count out of a SLURM gres string ("gpu:a100:2" → 2, "gpu:1" → 1). */
export function gpusInGres(gres) {
  const match = /gpu(?::[^:,()]+)?:(\d+)/.exec(String(gres ?? ""));
  return match ? Number(match[1]) : 0;
}

function parseStart(start, now) {
  const at = Date.parse(start);
  return Number.isFinite(at) && at <= now ? at : null;
}

async function jobsFact(deps) {
  try {
    const jobs = await deps.turing(["jobs"]);
    return {
      live: jobs.length,
      running: jobs.filter((job) => String(job.status).startsWith("RUNNING")).length,
      list: jobs.slice(0, 30).map((job) => ({ id: String(job.job_id), name: String(job.job_name ?? ""), status: String(job.status), gpuType: String(job.gpu_type ?? "unknown") })),
      raw: jobs,
    };
  } catch (error) {
    return { unavailable: turingBecause(error) };
  }
}

async function gpusFact(deps) {
  try {
    const report = await deps.turing(["gpus"]);
    const free = report?.summary?.free;
    if (!free || typeof free !== "object") return { unavailable: "the GPU report had no free summary" };
    return { freeByType: free };
  } catch (error) {
    return { unavailable: turingBecause(error) };
  }
}

/** tts-turing prints "answered 404" when the results tree has no such
 *  directory (turing-api's /cmt-node). */
function notFound(error) {
  return /answered 404\b/.test(String(error?.stderr ?? error?.message ?? ""));
}

/** Whether each node is done, top-down, within the budget. `known` is the
 *  cached done set; returns the newly learned done nodes and how many were
 *  left unchecked. */
export async function checkDone(nodes, known, deps, budget = CHECK_BUDGET) {
  const done = new Set(known);
  const pending = nodes.filter((node) => !done.has(node)).sort((a, b) => a.localeCompare(b));
  const absent = new Set(); // directories known not to exist
  const listed = new Map(); // directory -> { dirs, files }
  let calls = 0;
  const underAbsent = (node) => {
    for (let at = node.lastIndexOf("/"); at > 0; at = node.lastIndexOf("/", at - 1)) {
      if (absent.has(node.slice(0, at))) return true;
    }
    return absent.has(node);
  };
  const list = async (dir) => {
    if (listed.has(dir)) return listed.get(dir);
    if (calls >= budget) return undefined;
    calls += 1;
    try {
      const listing = await deps.turing(["node", dir]);
      const value = { dirs: new Set(listing.dirs ?? []), files: new Set((listing.files ?? []).map((file) => file.name)) };
      listed.set(dir, value);
      return value;
    } catch (error) {
      // ONLY A 404 SAYS THE DIRECTORY IS ABSENT. Any other failure (no read
      // key, a 401, the tunnel down) says nothing about the tree; counting it
      // absent reported every node not done and none unchecked. The budget is
      // spent so the rest of this step's nodes are counted unchecked too.
      if (notFound(error)) {
        listed.set(dir, null);
        return null;
      }
      calls = budget;
      return undefined;
    }
  };
  let unchecked = 0;
  // ONE DEPTH AT A TIME. A node is checked only after every shallower node is,
  // so an absent parent prunes its children instead of racing them.
  const depths = [...new Set(pending.map((node) => node.split("/").length))].sort((a, b) => a - b);
  let wave = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < wave.length) {
      const node = wave[cursor++];
      if (underAbsent(node)) continue;
      const parent = node.includes("/") ? node.slice(0, node.lastIndexOf("/")) : "";
      // The parent's listing, when another node already fetched it, says
      // whether this node's directory exists without a call of its own.
      const parentListing = parent && listed.get(parent);
      if (parentListing && !parentListing.dirs.has(node.slice(parent.length + 1))) {
        absent.add(node);
        continue;
      }
      const own = await list(node);
      if (own === undefined) { unchecked += 1; continue; }
      if (own === null) { absent.add(node); continue; }
      if (own.files.has("done.json")) done.add(node);
    }
  };
  for (const depth of depths) {
    wave = pending.filter((node) => node.split("/").length === depth);
    cursor = 0;
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  }
  return { done: [...done], unchecked, calls };
}

async function frontierFact({ cwd, specs, cache, deps, scratchRoot }) {
  if (!specs || specs.length === 0) return { unavailable: "this runner names no sweep specs" };
  if (!cwd) return { unavailable: "the step has no checkout" };
  let expanded;
  try {
    fs.mkdirSync(scratchRoot, { recursive: true });
    expanded = await deps.python(cwd, FRONTIER_PY, [JSON.stringify(specs)], { ...process.env, CMT_OUTPUT: scratchRoot, PYTHONPATH: cwd });
  } catch (error) {
    return { unavailable: `the frontier could not be expanded: ${because(error)}` };
  }
  if (expanded.error) return { unavailable: `the frontier could not be expanded: ${expanded.error}` };
  const nodes = expanded.nodes;
  const knownDone = cache.done.filter((node) => nodes.includes(node));
  const checked = await checkDone(nodes, knownDone, deps);
  cache.done = [...new Set([...cache.done, ...checked.done])];
  const done = checked.done.length;
  return { specs: expanded.specs.length, size: nodes.length, done, remaining: nodes.length - done, unchecked: checked.unchecked };
}

/** GPU-hours one job from the job list has used so far; null when it is not
 *  running or its start cannot be read. */
function jobGpuHours(job, now) {
  if (!String(job.status).startsWith("RUNNING")) return null;
  const started = parseStart(job.start_time, now);
  if (started === null) return null;
  return ((now - started) / 3_600_000) * (gpusInGres(job.gres) || 1);
}

/** Whether a job from the job list is this runner's: tts-turing-act names
 *  every job it launches runner:<id>:<label>. */
function ownJob(job, runnerId) {
  return String(job.job_name ?? "").startsWith(`runner:${runnerId}:`);
}

/** Fold a job list into the cache's per-job hours (a job's hours only ever
 *  grow) and return the total. Only this runner's jobs count, and a cached
 *  entry counts only if it carries this runner's job name, so hours an
 *  earlier sensor cached for other jobs on the account drop out. The ONE spend
 *  sum: the sensor's facts row and tts-turing-act's budget check both read it.
 *  `cacheJobs` is changed in place. */
function spentGpuHours(cacheJobs, jobs, runnerId, now) {
  for (const job of jobs ?? []) {
    if (!ownJob(job, runnerId)) continue;
    const hours = jobGpuHours(job, now);
    if (hours === null) continue;
    const seen = cacheJobs[job.job_id]?.gpuHours ?? 0;
    cacheJobs[job.job_id] = { gpuHours: Math.max(seen, hours), name: String(job.job_name) };
  }
  return Object.values(cacheJobs)
    .filter((job) => ownJob({ job_name: job.name }, runnerId))
    .reduce((sum, job) => sum + job.gpuHours, 0);
}

/**
 * Whether a launch fits the runner's budget, decided before anything is sent.
 *
 * input: { cache (the sensor's cache file, parsed, or null), jobs (the job
 *          list, or null when it could not be read), runnerId, gpus, minutes,
 *          now }
 * returns { ok: true, spent, committed, request, budget } or
 *         { ok: false, reason } with the sentence the step raises.
 *
 * Spent is the sensor's own sum over this runner's jobs. Committed is the time still left on this
 * runner's live jobs, so two launches in one step cannot each pass against the
 * same spend. The job list must be readable: a launch is refused rather than
 * counted against a spend of zero that nobody saw.
 */
export function launchVerdict({ cache, jobs, runnerId, gpus, minutes, now }) {
  const budget = cache?.budgetGpuHours;
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return { ok: false, reason: "no GPU-hour budget is recorded for this runner, so it cannot launch; ask Tom to set one" };
  }
  if (!Array.isArray(jobs)) {
    return { ok: false, reason: "the cluster's job list could not be read, so the spend is unknown and the launch is refused rather than assumed free" };
  }
  const spent = spentGpuHours({ ...(cache.jobs ?? {}) }, jobs, runnerId, now);
  const committed = jobs
    .filter((job) => ownJob(job, runnerId))
    .reduce((sum, job) => sum + (Math.max(0, Number(job.time_remaining_seconds) || 0) / 3600) * (gpusInGres(job.gres) || 1), 0);
  const request = (gpus * minutes) / 60;
  const total = spent + committed + request;
  const numbers = { spent: round(spent), committed: round(committed), request: round(request), budget };
  if (total > budget + 1e-9) {
    return {
      ok: false,
      ...numbers,
      reason: `this launch asks for ${numbers.request} GPU-hours; with ${numbers.spent} spent and ${numbers.committed} still booked on this runner's live jobs, it would cross the ${budget}-hour budget`,
    };
  }
  return { ok: true, ...numbers };
}

function gpuHoursFact(jobs, cache, runnerId, budget, now) {
  if (jobs.unavailable) {
    const spent = spentGpuHours(cache.jobs, [], runnerId, now);
    return { spent: round(spent), ...(budget !== undefined ? { budget } : {}), note: "no jobs read this step; the total is as last seen" };
  }
  const spent = spentGpuHours(cache.jobs, jobs.raw, runnerId, now);
  return { spent: round(spent), ...(budget !== undefined ? { budget } : {}) };
}

const round = (n) => Math.round(n * 10) / 10;

/**
 * Read the facts for one step. Never throws: a source that fails is named in
 * its own field.
 *
 * input: { runnerId, cwd, specs, budgetGpuHours, failures: [{ at, text }],
 *          cacheDir }
 */
export async function sense(input, deps = defaultDeps) {
  const now = deps.now();
  const cacheDir = input.cacheDir ?? DEFAULT_CACHE_DIR;
  const cachePath = path.join(cacheDir, `${input.runnerId}.json`);
  const cache = readCache(cachePath);
  const [jobs, gpus] = await Promise.all([jobsFact(deps), gpusFact(deps)]);
  const frontier = await frontierFact({
    cwd: input.cwd, specs: input.specs, cache, deps,
    scratchRoot: path.join(cacheDir, "scratch-output"),
  });
  const gpuHours = gpuHoursFact(jobs, cache, input.runnerId, input.budgetGpuHours, now);
  // THE BUDGET RIDES THE CACHE, written here from the claim, so tts-turing-act
  // reads it from the record's own copy and never from its command line. A
  // runner with no budget leaves none, and cannot launch.
  if (input.budgetGpuHours !== undefined) cache.budgetGpuHours = input.budgetGpuHours;
  else delete cache.budgetGpuHours;
  cache.readAt = now;
  writeCache(cachePath, cache);
  const jobsOut = { ...jobs };
  delete jobsOut.raw;
  return {
    version: FACTS_VERSION,
    at: now,
    jobs: jobsOut,
    gpus,
    frontier,
    failures: { sinceLastStep: (input.failures ?? []).length, lines: (input.failures ?? []).map((failure) => failure.text).slice(0, 10) },
    gpuHours,
  };
}

/** The facts as the lines a step reads. The same fields in the same order on
 *  every step. */
export function renderFacts(facts) {
  const lines = [];
  const j = facts.jobs;
  lines.push(j.unavailable ? `Jobs: not read (${j.unavailable}).` : `Jobs: ${j.live} on the account, ${j.running} running.`);
  if (!j.unavailable) for (const job of j.list) lines.push(`- job ${job.id} ${job.name} ${job.status} on ${job.gpuType}`);
  const g = facts.gpus;
  lines.push(g.unavailable ? `Free GPUs: not read (${g.unavailable}).` : `Free GPUs by type: ${Object.entries(g.freeByType).map(([type, n]) => `${type} ${n}`).join(", ") || "none"}.`);
  const f = facts.frontier;
  lines.push(f.unavailable
    ? `Frontier: not counted (${f.unavailable}).`
    : `Frontier: ${f.size} nodes from ${f.specs} specs, ${f.done} known done, ${f.remaining} remaining${f.unchecked > 0 ? `, ${f.unchecked} not checked this step so the done count is a floor` : ""}.`);
  lines.push(`Step failures since the last check-in: ${facts.failures.sinceLastStep}.`);
  for (const line of facts.failures.lines) lines.push(`- ${line}`);
  const h = facts.gpuHours;
  lines.push(`GPU-hours seen on this runner's running jobs since it began: ${h.spent}${h.budget !== undefined ? ` of a ${h.budget}-hour budget` : ", no budget set"}${h.note ? ` (${h.note})` : ""}.`);
  return lines.join("\n");
}
