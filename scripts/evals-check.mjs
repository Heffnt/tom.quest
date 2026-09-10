#!/usr/bin/env node
// evals-check.mjs — the body of the `evals` check on a pull request.
//
// It asks the Jarvis Box for a run at this commit and waits for the answer,
// then compares that run with the base commit's. Merging is the persist gate,
// so this is where a change to a pinned file has to prove it did not make the
// outputs worse.
//
// ZERO imports on purpose. WikiTom's Action fetches this one file and runs it,
// and worker/setup.sh copies it beside the jobs on the box so worker/jobs/
// evals.mjs can stamp a run with the same gate() the check applies. One body,
// three homes, no second spelling of what a regression is.
//
// Environment: CONVEX_SITE_URL, EVALS_KEY, REPO, SHA, BASE_SHA, PR.
// EVALS_KEY is a SECOND key, not TTS_WORKER_KEY: the worker key opens every
// /tts/* route including /tts/event, and CI needs exactly two things.

export const POLL_INTERVAL_MS = 30_000;
export const POLL_TIMEOUT_MS = 40 * 60 * 1000;

/** The paths that make an evals run worth asking for, in either repo. */
export const WATCHED_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "model-of-tom/**",
  "scripts/prelude.mjs",
  "convex/ttsShared.ts",
  "convex/claudeSessions.ts",
  "convex/ttsSkills.ts",
  "worker/jobs/plan-graphs.mjs",
  "worker/jobs/weekly.mjs",
  "evals/golden/**",
  "evals/tasks/**",
];

/** Every failure of a run, golden items and repo tasks alike, by id. */
function failuresOf(run) {
  const map = new Map();
  for (const failure of run?.failures ?? []) map.set(failure.id, failure);
  for (const failure of run?.tasks?.failures ?? []) map.set(failure.id, failure);
  return map;
}

/** The ids a run actually scored — the row carries them so the gate can tell a
 *  newly added item apart from one that regressed. */
function scoredOf(run) {
  return new Set(run?.scoredIds ?? []);
}

/**
 * The gate. Pure, exported, tested.
 *
 * FAILS: a regression (an item that passes in base and fails in head), a
 * golden-set hash mismatch (the two runs scored different sets and the
 * comparison would be a lie), or no head run at all.
 *
 * REPORTED, does not fail: an item failing in both runs (standing debt, not
 * something this pull request did), an item failing in head that base never
 * scored (nothing to regress from), a fix, and an item Tom has not confirmed —
 * the mined explanations carry confirmedByTom: false, and a label he has not
 * ratified must not block a merge.
 */
export function gate(head, base) {
  if (!head) {
    return { ok: false, reason: "no head run", regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false };
  }
  const headFailures = failuresOf(head);
  const baseFailures = failuresOf(base);
  const baseScored = scoredOf(base);
  const mismatch = Boolean(base) && head.goldenHash !== base.goldenHash;
  const regressions = [];
  const stillFailing = [];
  const newFailing = [];
  const unconfirmed = [];
  for (const [id, failure] of headFailures) {
    if (failure.confirmed === false) unconfirmed.push(failure);
    else if (baseFailures.has(id)) stillFailing.push(failure);
    else if (!base || (baseScored.size > 0 && !baseScored.has(id))) newFailing.push(failure);
    else regressions.push(failure);
  }
  const fixed = [...baseFailures.values()].filter((failure) => !headFailures.has(failure.id));
  const ok = regressions.length === 0 && !mismatch;
  return { ok, mismatch, regressions, stillFailing, newFailing, fixed, unconfirmed, noBaseline: !base };
}

/** What Tom sees in the check's log. A clean check is one line. */
export function report(head, base, verdict) {
  const setLine = `evals — ${head.repo} ${String(head.sha).slice(0, 7)} vs base ` +
    `${base ? String(base.sha).slice(0, 7) : "none"} (golden set ${head.goldenHash}, ${head.items} items)`;
  const lines = [];
  const notes = [
    verdict.regressions.length === 0 ? "0 regressions" : null,
    verdict.stillFailing.length > 0 ? `${verdict.stillFailing.length} still failing` : null,
    verdict.unconfirmed.length > 0 ? `${verdict.unconfirmed.length} failing but not confirmed by Tom` : null,
  ].filter((note) => note !== null);
  const quiet = verdict.stillFailing.length === 0 && verdict.newFailing.length === 0 &&
    verdict.unconfirmed.length === 0 && verdict.fixed.length === 0;
  if (verdict.ok && quiet) {
    return [`${setLine}: ${head.pass} pass, ${head.fail} fail, ${notes.join(", ")}.`];
  }
  lines.push(setLine);
  lines.push(`  head: ${head.pass} pass, ${head.fail} fail` + (base ? `      base: ${base.pass} pass, ${base.fail} fail` : ""));
  if (verdict.noBaseline) lines.push(`  no baseline for the base commit; reporting only`);
  if (verdict.mismatch) {
    lines.push(`  GOLDEN SET MISMATCH  head ${head.goldenHash} vs base ${base.goldenHash} — re-run the base:`);
    lines.push(`    node /opt/tts/evals.mjs --repo ${head.repo} --sha ${base.sha} --force`);
  }
  const say = (label, failure) => `  ${label}  ${failure.id} (${failure.partition}, ${failure.verdict}) — ${failure.reason}`;
  for (const failure of verdict.regressions) lines.push(say("REGRESSION", failure));
  for (const failure of verdict.stillFailing) lines.push(say("still failing", failure));
  for (const failure of verdict.newFailing) lines.push(say("new, failing", failure));
  for (const failure of verdict.unconfirmed) lines.push(say("unconfirmed", failure));
  for (const failure of verdict.fixed) lines.push(`  fixed  ${failure.id} (${failure.partition}, ${failure.verdict})`);
  lines.push(verdict.ok
    ? `PASSED: 0 regressions.`
    : verdict.mismatch
      ? `FAILED: the two runs scored different golden sets.`
      : `FAILED: ${verdict.regressions.length} regression${verdict.regressions.length === 1 ? "" : "s"}.`);
  return lines;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`evals: ${name} must be set (CONVEX_SITE_URL as a repository variable, EVALS_KEY as a repository secret).`);
    process.exit(2);
  }
  return value;
}

async function call(site, key, route, body) {
  const response = await fetch(`${site.replace(/\/+$/, "")}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Evals-Key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}`);
  return await response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const site = required("CONVEX_SITE_URL");
  const key = required("EVALS_KEY");
  const repo = required("REPO");
  const sha = required("SHA");
  const baseSha = process.env.BASE_SHA || null;
  const pr = process.env.PR ? Number(process.env.PR) : undefined;

  await call(site, key, "/tts/evals-request", { repo, sha, baseSha: baseSha ?? undefined, pr, paths: WATCHED_PATHS });
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let answer = null;
  while (Date.now() < deadline) {
    const query = `/tts/evals-run?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}` +
      (baseSha ? `&base=${encodeURIComponent(baseSha)}` : "");
    answer = await call(site, key, query);
    if (answer.run) break;
    console.log(`evals: waiting for the Jarvis Box (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(POLL_INTERVAL_MS);
  }
  // A check that passes on silence proves nothing.
  if (!answer?.run) {
    console.error(
      `evals: the Jarvis Box did not answer within 40 minutes. Re-run this check, or run it by hand: ` +
        `node /opt/tts/evals.mjs --repo ${repo} --sha ${sha}`,
    );
    process.exit(1);
  }
  const verdict = gate(answer.run, answer.base ?? null);
  for (const line of report(answer.run, answer.base ?? null, verdict)) console.log(line);
  process.exit(verdict.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && /evals-check\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`evals: ${error.message}`);
    process.exit(1);
  });
}
