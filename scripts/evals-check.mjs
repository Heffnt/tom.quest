// evals-check.mjs — the body of the `evals` check on a pull request.
// NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs says
// it too): this file is imported by scripts/evals-check.test.mjs and by
// worker/jobs/evals.mjs's dynamic import, and the test bundler rewrites such a
// module by prepending an import — which lands in front of a shebang and fails
// to parse. Every caller already names the interpreter (`node evals-check.mjs`).
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
// Environment: CONVEX_SITE_URL, EVALS_KEY, REPO, SHA, BASE_SHA, PR, PR_BODY.
// EVALS_KEY is a SECOND key, not TTS_WORKER_KEY: the worker key opens every
// /tts/* route including /tts/event, and CI needs exactly two things.

export const POLL_INTERVAL_MS = 30_000;
/**
 * How long the check waits for the box's answer.
 *
 * MEASURED, not guessed: on PR #170 (2026-09-11) the box took about fifty
 * minutes for one run — 29 golden items, and a fresh clone plus two worktrees
 * (head and base) before any of them were scored. The wait was 40 minutes, so
 * the check failed on silence while the run was still going, and a re-run paid
 * the whole cost again. 75 leaves a real margin over that measurement without
 * letting a box that is genuinely dead hold a pull request all afternoon —
 * .github/workflows/evals.yml's job timeout is set above it.
 */
export const POLL_TIMEOUT_MS = 75 * 60 * 1000;

/**
 * The paths that make an evals run worth asking for, in either repo.
 *
 * THIS LIST AND .github/workflows/evals.yml's `paths:` ARE ONE FACT SPELLED
 * TWICE, and they had already drifted: the workflow fired on the `**` forms of
 * AGENTS.md and CLAUDE.md, convex/ttsCompose.ts, convex/ttsDigest.ts,
 * worker/jobs/delegate.mjs and worker/bin/tts-ask, which this list had never
 * heard of, while this list watched model-of-tom/**, which the workflow did
 * not fire on. They are reconciled here to the UNION of the two, in one order,
 * and scripts/evals-check.test.mjs pins them equal — so the next divergence is
 * a red test naming the path, not a run nobody noticed was missing.
 *
 * UNION IS THE SAFE DIRECTION. A watched path that fires an unnecessary run
 * costs one run. An unwatched path that changes the context Tom's jobs read
 * changes his outputs with nothing scoring them, which is the exact failure
 * the whole gate exists to prevent.
 *
 * FOUR PATHS WERE ADDED WHEN THE SKILLS LANDED, and each is a context file in
 * exactly the sense this list means — a file whose content reaches a run's
 * prompt. scripts/skills.mjs is the table that decides what the skill set IS
 * and writes every description a run reads before it loads one;
 * scripts/publish-skills.mjs is the generator that turns that table into the
 * directories; worker/jobs/skill-router.mjs is what decides which of them a run
 * is granted. A change to any of the three changes what Tom's jobs are given
 * with nothing else scoring it. evals/triggers/** is watched for the reason
 * evals/golden/** is: it is the set, and a change to the set changes what a
 * comparison means.
 *
 * THE HARNESS'S OWN FILES ARE STILL NOT WATCHED. This one and
 * worker/jobs/evals.mjs are the machinery that runs the measurement, not the
 * context being measured, and watching them would fire a fifty-minute run on
 * every change to the evals code itself. evals/golden/runs/** needs no entry
 * either: it is already inside evals/golden/**.
 */
export const WATCHED_PATHS = [
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
  "model-of-tom/**",
  "scripts/prelude.mjs",
  "scripts/skills.mjs",
  "scripts/publish-skills.mjs",
  "convex/ttsShared.ts",
  "convex/claudeSessions.ts",
  "convex/ttsSkills.ts",
  "convex/ttsCompose.ts",
  "convex/ttsDigest.ts",
  "worker/jobs/plan-graphs.mjs",
  "worker/jobs/weekly.mjs",
  "worker/jobs/delegate.mjs",
  "worker/jobs/skill-router.mjs",
  "worker/bin/tts-ask",
  "evals/golden/**",
  "evals/tasks/**",
  "evals/triggers/**",
];

/** Where a golden item lives. A change that ships one of these is the thing
 *  the coverage rule asks for. */
const ITEM_PREFIXES = ["evals/golden/", "evals/triggers/"];

/**
 * One changed path against one WATCHED_PATHS entry. Three forms, because three
 * forms are all the list has: a leading `**` segment (this name anywhere), a
 * trailing one (anything under this directory), and an exact path.
 *
 * Hand-written on purpose. A glob library would be a fourth spelling of the
 * same three rules, and the first import into a file whose whole shape is that
 * it has none.
 */
function matchesPattern(path, pattern) {
  if (pattern.startsWith("**/")) {
    const tail = pattern.slice(3);
    return path === tail || path.endsWith(`/${tail}`);
  }
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

/** Whether a changed path is one the evals watch. */
export function matchesWatched(path) {
  if (typeof path !== "string" || path === "") return false;
  const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return WATCHED_PATHS.some((pattern) => matchesPattern(normalised, pattern));
}

/**
 * The `evals: no-item <reason>` line on a pull-request body, or null.
 *
 * ANCHORED AND ALONE ON ITS LINE, for convex/ttsMerge.ts auditVerdictOf's
 * reason: a body that discusses the escape hatch ("put `evals: no-item why`
 * on the body if…") must not be read as using it.
 *
 * The hatch exists because a rule with no way out gets satisfied with a junk
 * item — an item written to turn a check green is scored forever and teaches
 * nothing, which is worse than one sentence saying why this change owes none.
 */
export function noItemTrailer(prBody) {
  if (typeof prBody !== "string") return null;
  for (const line of prBody.split(/\r?\n/)) {
    const hit = /^[ \t]*evals:[ \t]*no-item[ \t]+(.+?)[ \t]*$/i.exec(line);
    if (hit !== null) return hit[1];
  }
  return null;
}

/** Coverage, and the reason when a trailer is what excused it. The reason
 *  travels on the verdict because report() is given no pull-request body. */
function coverageOf(changed, prBody) {
  // NO DIFF, NO VERDICT. A --weekly run and a run by hand supply no changed
  // list, and answering `false` there would fail a run that was never asked
  // about a pull request at all.
  if (!Array.isArray(changed)) return { coverage: null, excuse: null };
  const paths = changed
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!paths.some((path) => matchesWatched(path))) return { coverage: true, excuse: null };
  if (paths.some((path) => ITEM_PREFIXES.some((prefix) => path.startsWith(prefix)))) {
    return { coverage: true, excuse: null };
  }
  const excuse = noItemTrailer(prBody);
  return excuse === null ? { coverage: false, excuse: null } : { coverage: true, excuse };
}

/**
 * Did this change pay for itself? Three-valued.
 *
 *   true  — nothing watched changed, an item shipped with it, or a trailer
 *           excused it.
 *   false — a watched context file changed and no item came with it. FAILS,
 *           the same way a regression does: a context change nothing scores is
 *           a change to Tom's outputs that no one ever looked at.
 *   null  — no diff was supplied, so there is no verdict to give.
 */
export function goldenItemRule(changed, prBody) {
  return coverageOf(changed, prBody).coverage;
}

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
 *
 * The third argument is the pull request's own diff — `changed`, the paths it
 * touched, and `prBody` for the escape hatch. Absent (the box's own stamping
 * call, a run by hand), coverage answers null and gates nothing.
 */
export function gate(head, base, { changed, prBody } = {}) {
  const { coverage: goldenCoverage, excuse: goldenExcuse } = coverageOf(changed, prBody);
  // The early returns carry coverage too, so no caller ever reads `undefined`
  // off a verdict and has to guess whether that meant false or unasked.
  if (!head) {
    return { ok: false, reason: "no head run", regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, goldenCoverage, goldenExcuse };
  }
  // A run the box could not make at all (a sha it could not fetch or check
  // out) is posted as a row carrying `error`, so the request queue advances.
  // A row like that scored nothing, and a gate that reads "no failures" off it
  // would open on a run that never happened.
  if (typeof head.error === "string" && head.error !== "") {
    return { ok: false, reason: head.error, regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, goldenCoverage, goldenExcuse };
  }
  const headFailures = failuresOf(head);
  const baseFailures = failuresOf(base);
  const baseScored = scoredOf(base);
  const mismatch = Boolean(base) && head.goldenHash !== base.goldenHash;
  const regressions = [];
  const stillFailing = [];
  const newFailing = [];
  const unconfirmed = [];
  // THE PARTITION IS ON THE BASE RUN'S RESULT, NEVER ON THE ITEM'S KIND, and
  // that is deliberate. A capability item — one that asks whether the system
  // can do a thing it could not do before — passes in base and fails in head
  // exactly as a behaviour item does when a change breaks it, and that IS a
  // regression: the capability was there last week and is gone now. A gate
  // that read `kind` and waved capability items through would open a hole one
  // week wide after every fix, staying open until the weekly graduation pass
  // rewrote the file and the item stopped calling itself a capability. What
  // the base run did is a fact about this commit; what an item calls itself is
  // a label with a lifecycle.
  for (const [id, failure] of headFailures) {
    if (failure.confirmed === false) unconfirmed.push(failure);
    else if (baseFailures.has(id)) stillFailing.push(failure);
    else if (!base || (baseScored.size > 0 && !baseScored.has(id))) newFailing.push(failure);
    else regressions.push(failure);
  }
  const fixed = [...baseFailures.values()].filter((failure) => !headFailures.has(failure.id));
  // Coverage fails the check on `false` alone. `null` is the absence of a
  // question, not an answer of no, and a run with no diff to read must not
  // fail a check it was never given the input for.
  const ok = regressions.length === 0 && !mismatch && goldenCoverage !== false;
  return { ok, mismatch, regressions, stillFailing, newFailing, fixed, unconfirmed, noBaseline: !base, goldenCoverage, goldenExcuse };
}

/** What Tom sees in the check's log. A clean check is one line. */
export function report(head, base, verdict) {
  const setLine = `evals — ${head.repo} ${String(head.sha).slice(0, 7)} vs base ` +
    `${base ? String(base.sha).slice(0, 7) : "none"} (golden set ${head.goldenHash}, ${head.items} items)`;
  const lines = [];
  if (typeof head.error === "string" && head.error !== "") {
    return [setLine, `FAILED: the run could not be made — ${head.error}`];
  }
  // The unconfirmed count is REPORTED, never gated: gate() routes an
  // unconfirmed failure out of `regressions` on purpose, and this is the one
  // place the CI log says how many went that way.
  const unconfirmedNote = verdict.unconfirmed.length > 0
    ? ` ${verdict.unconfirmed.length} unconfirmed failure${verdict.unconfirmed.length === 1 ? "" : "s"} reported, not gated.`
    : "";
  // Flaky is REPORTED, never gated, and it is printed even when it is zero:
  // the number is how Tom reads whether the set moved on its own. An item is
  // flaky when it passed one head trial and failed another (worker/jobs/
  // evals.mjs, HEAD_TRIALS) — it passed, so it is in the pass count and in no
  // failure list, and it can never be a regression.
  const flaky = (head.flaky ?? 0) + (head.tasks?.flaky ?? 0);
  const notes = [
    verdict.regressions.length === 0 ? "0 regressions" : null,
    `${flaky} flaky`,
    verdict.stillFailing.length > 0 ? `${verdict.stillFailing.length} still failing` : null,
    verdict.unconfirmed.length > 0 ? `${verdict.unconfirmed.length} failing but not confirmed by Tom` : null,
  ].filter((note) => note !== null);
  // An excused change is never the one-line check: the sentence Tom wrote to
  // get past the coverage rule is the whole value of the escape hatch, and a
  // hatch used silently is a hatch nobody audits.
  const quiet = verdict.stillFailing.length === 0 && verdict.newFailing.length === 0 &&
    verdict.unconfirmed.length === 0 && verdict.fixed.length === 0 &&
    !verdict.goldenExcuse;
  if (verdict.ok && quiet) {
    return [`${setLine}: ${head.pass} pass, ${head.fail} fail, ${notes.join(", ")}.`];
  }
  lines.push(setLine);
  lines.push(`  head: ${head.pass} pass, ${head.fail} fail, ${flaky} flaky` + (base ? `      base: ${base.pass} pass, ${base.fail} fail` : ""));
  if (verdict.noBaseline) lines.push(`  no baseline for the base commit; reporting only`);
  if (verdict.mismatch) {
    lines.push(`  GOLDEN SET MISMATCH  head ${head.goldenHash} vs base ${base.goldenHash} — re-run the base:`);
    lines.push(`    node /opt/tts/evals.mjs --repo ${head.repo} --sha ${base.sha} --force`);
  }
  // Coverage says nothing at all when it is null: a run with no diff was never
  // asked, and a line about a rule that did not apply is noise in every
  // by-hand and weekly log.
  if (verdict.goldenCoverage === false) {
    lines.push(`  NO GOLDEN ITEM  a watched context file changed and this branch ships no item under evals/golden/** or evals/triggers/** — add one, or put "evals: no-item <reason>" on the pull-request body`);
  } else if (verdict.goldenExcuse) {
    lines.push(`  golden item excused: ${verdict.goldenExcuse}`);
  }
  const say = (label, failure) => `  ${label}  ${failure.id} (${failure.partition}, ${failure.verdict}) — ${failure.reason}`;
  for (const failure of verdict.regressions) lines.push(say("REGRESSION", failure));
  for (const failure of verdict.stillFailing) lines.push(say("still failing", failure));
  for (const failure of verdict.newFailing) lines.push(say("new, failing", failure));
  for (const failure of verdict.unconfirmed) lines.push(say("unconfirmed", failure));
  for (const failure of verdict.fixed) lines.push(`  fixed  ${failure.id} (${failure.partition}, ${failure.verdict})`);
  // The summary line names WHAT failed. Coverage can fail a run with zero
  // regressions, and "FAILED: 0 regressions." is a sentence no one can act on.
  lines.push((verdict.ok
    ? `PASSED: 0 regressions.`
    : verdict.mismatch
      ? `FAILED: the two runs scored different golden sets.`
      : verdict.regressions.length > 0
        ? `FAILED: ${verdict.regressions.length} regression${verdict.regressions.length === 1 ? "" : "s"}.`
        : `FAILED: a watched context file changed and no golden item shipped with it.`) + unconfirmedNote);
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

/**
 * The paths this pull request touched, read out of the checkout the CI job
 * already has, or null.
 *
 * THE CHECK READS ITS OWN DIFF rather than taking a list from the workflow or
 * from the box: the list the log prints and the list the gate judged are then
 * the same list by construction, and no third party can hand this gate a
 * shorter one.
 *
 * `node:child_process` is imported HERE, inside the one function that needs
 * it, because the top-level import list of this file stays empty — WikiTom's
 * Action fetches this single file and runs it, with no package around it.
 *
 * NULL, NEVER FALSE, when git cannot answer: no checkout, a shallow clone with
 * no merge base, a sha that is not there. A gate that failed because it could
 * not SEE the diff would block every merge from a machine without one, and the
 * thing it would be reporting is its own blindness, not a missing item.
 */
async function changedPaths(baseSha, sha) {
  if (!baseSha || !sha) return null;
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("git", ["diff", "--name-only", `${baseSha}...${sha}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  } catch (error) {
    console.log(`evals: could not read the diff (${error.message.split("\n")[0]}); golden coverage is unjudged`);
    return null;
  }
}

async function main() {
  const site = required("CONVEX_SITE_URL");
  const key = required("EVALS_KEY");
  const repo = required("REPO");
  const sha = required("SHA");
  const baseSha = process.env.BASE_SHA || null;
  const pr = process.env.PR ? Number(process.env.PR) : undefined;
  const prBody = process.env.PR_BODY || undefined;
  const changed = await changedPaths(baseSha, sha);

  // `changed` rides the request so the box's row and this log read the same
  // list. It is OMITTED rather than sent as null when git could not answer: an
  // absent optional field is a field that was not supplied, which is exactly
  // what happened, and a null would have to be special-cased at every door it
  // passes through.
  await call(site, key, "/tts/evals-request", {
    repo,
    sha,
    baseSha: baseSha ?? undefined,
    pr,
    paths: WATCHED_PATHS,
    ...(changed === null ? {} : { changed }),
    ...(prBody === undefined ? {} : { prBody }),
  });
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
      `evals: the Jarvis Box did not answer within ${POLL_TIMEOUT_MS / 60_000} minutes. Re-run this check, or run it by hand: ` +
        `node /opt/tts/evals.mjs --repo ${repo} --sha ${sha}`,
    );
    process.exit(1);
  }
  const verdict = gate(answer.run, answer.base ?? null, { changed, prBody });
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
