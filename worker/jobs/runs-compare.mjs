// runs-compare.mjs — the shadow-row cutover check. Convex owns both row sets,
// chooses the bounded set of eligible ended sessions, compares them without
// returning transcript text, and records each result. This job only triggers
// that transaction and maintains one standing digest condition for diffs.

import { pathToFileURL } from "node:url";

import { loadEnv, reportJobFailed, reportJobOk } from "./tts-lib.mjs";

export const JOB = "runs-compare";
export const DIFF_KEY = "runs-compare:diffs";

async function comparisonBatch(env, fetchImpl) {
  const url = `${env.CONVEX_SITE_URL.replace(/\/+$/, "")}/runs/compare`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sessions-Key": env.SESSIONS_WORKER_KEY,
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`/runs/compare -> HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result?.comparisons)) throw new Error("/runs/compare returned an invalid batch");
  return result.comparisons;
}

export async function compareEndedSessions(env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fail = deps.reportFailed ?? reportJobFailed;
  const ok = deps.reportOk ?? reportJobOk;
  const comparisons = await comparisonBatch(env, fetchImpl);
  const diffs = comparisons.filter((comparison) => comparison?.clean !== true);
  if (diffs.length > 0) {
    await fail(env, {
      job: JOB,
      key: DIFF_KEY,
      error: `${diffs.length} of ${comparisons.length} eligible session comparison${comparisons.length === 1 ? "" : "s"} differed: ${diffs.map((item) => item?.runId ?? "unknown run").join(", ")}`,
    });
  } else {
    await ok(env, { job: JOB, key: DIFF_KEY });
  }
  return { compared: comparisons.length, diffs: diffs.length, comparisons };
}

async function main() {
  const env = loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY", "SESSIONS_WORKER_KEY"] });
  const result = await compareEndedSessions(env);
  console.log(`[runs-compare] ${result.compared} compared, ${result.diffs} different`);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[runs-compare] ${error.message}`);
    process.exitCode = 1;
  });
}
