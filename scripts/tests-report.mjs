// tests-report.mjs — the Guardrails run's own result, posted to the merge
// gate's first head row (POST /tts/tests, convex/ttsMerge.ts).
//
// NO SHEBANG LINE and ZERO IMPORTS, for scripts/evals-check.mjs's reasons: the
// test beside it imports this file, and the `report` job runs it with plain
// node before any install.
//
// IT IS ITS OWN JOB, and that is the whole reason this file exists rather than
// the `curl` that used to end the `tests` job. Four jobs now answer for one
// commit — static-boundaries, secret-scan, tests and e2e — and they run in
// PARALLEL, so no one of them can see the others' durations or results. A job
// that `needs` all four with `if: always()` can, which is what lets one row
// carry every job's wall time and what keeps e2e off the critical path.
//
// Environment: CONVEX_SITE_URL, EVALS_KEY, REPO, SHA, RUN_URL, the four
// <JOB>_RESULT words GitHub hands a dependent job, the four <JOB>_SECONDS each
// job measured of itself, and SUMMARY — scripts/tests-affected.mjs's own line.

/** The four jobs, in the order the detail sentence names them. Each is
 *  required, so `ok` is one word per job and no list of exceptions: a job that
 *  was skipped or cancelled is a check that did not answer, and the gate must
 *  not read that as one that did. */
export const JOBS = [
  { key: "static", name: "static-boundaries" },
  { key: "secret", name: "secret-scan" },
  { key: "tests", name: "tests" },
  { key: "e2e", name: "e2e" },
];

/** One sentence naming every job's answer and how the tests job chose its
 *  scope. This is what the merge gate prints when it denies on a red row, so it
 *  says the mode: a related-mode run that went green is a narrower fact than a
 *  full one, and a reader should not have to open the run to learn which. */
export function detailOf(results, summary) {
  const jobs = JOBS.map(({ key, name }) => `${name} ${results[key] || "absent"}`).join(", ");
  const scope = summary === null
    ? "scope unknown"
    : `${summary.mode} mode, ${summary.files} changed file${summary.files === 1 ? "" : "s"}`;
  return `guardrails — ${jobs}; ${scope}`;
}

/** The body the door takes. `durations` is seconds per job, and it is what
 *  convex/ttsMerge.ts measures its two thresholds against. */
export function bodyOf(env) {
  const results = {};
  const durations = {};
  for (const { key, name } of JOBS) {
    results[key] = (env[`${key.toUpperCase()}_RESULT`] ?? "").trim();
    const seconds = Number((env[`${key.toUpperCase()}_SECONDS`] ?? "").trim());
    if (Number.isFinite(seconds) && seconds > 0) durations[name] = seconds;
  }
  let summary = null;
  try {
    const text = (env.SUMMARY ?? "").trim();
    if (text !== "") summary = JSON.parse(text);
  } catch {
    // A job that died before writing its summary still has a result word, and
    // the row is worth more with the results and no scope than not at all.
  }
  // The vitest run's own wall time, which is the second threshold's subject:
  // the `tests` job also pays for install, typecheck and the build, and a
  // suite that crossed ten minutes is a different fact from a job that did.
  if (summary !== null && Number.isFinite(summary.seconds)) durations.suite = summary.seconds;
  return {
    repo: (env.REPO ?? "").trim(),
    sha: (env.SHA ?? "").trim(),
    ok: JOBS.every(({ key }) => results[key] === "success"),
    detail: detailOf(results, summary),
    ...(env.RUN_URL ? { url: env.RUN_URL } : {}),
    ...(summary === null ? {} : { mode: summary.mode, files: summary.files }),
    ...(summary === null || !Array.isArray(summary.slowest) ? {} : { slowest: summary.slowest }),
    durations,
  };
}

async function main() {
  const site = (process.env.CONVEX_SITE_URL ?? "").trim();
  // The same silence the curl step had: a fork's run holds no variables, and a
  // check that cannot reach Convex is not a check that failed.
  if (site === "") {
    process.stderr.write("tests-report: CONVEX_SITE_URL unset; nothing posted\n");
    return;
  }
  const body = bodyOf(process.env);
  const response = await fetch(`${site}/tts/tests`, {
    method: "POST",
    headers: { "X-Evals-Key": process.env.EVALS_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // LOUD, for the reason the curl carried `-f`: a 401 or a 503 leaves the gate
  // with no row and the log with nothing saying why.
  if (!response.ok) throw new Error(`POST /tts/tests answered ${response.status}: ${text}`);
  process.stdout.write(`tests-report: ${body.ok ? "green" : "red"} — ${body.detail}\n${text}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("tests-report.mjs")) {
  main().catch((error) => {
    process.stderr.write(`tests-report: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
