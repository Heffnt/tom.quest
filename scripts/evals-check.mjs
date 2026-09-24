// evals-check.mjs — the body of the `evals` check on a pull request.
// NO SHEBANG LINE: this file is imported by scripts/evals-check.test.mjs and by
// the Jarvis repository's worker/jobs/evals.mjs, and the test bundler rewrites
// such a module by prepending an import — which lands in front of a shebang
// and fails to parse. Every caller already names the interpreter
// (`node evals-check.mjs`).
//
// It asks the Jarvis Box for a run at this commit and waits for the answer,
// then compares that run with the base commit's. Merging is the persist gate,
// so this is where a change to a pinned file has to prove it did not make the
// outputs worse.
//
// ZERO imports on purpose. WikiTom's Action fetches this one file and runs it,
// and the Jarvis repository carries a copy beside its evals job so a run is
// stamped with the same gate() the check applies.
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
 * The paths that make an evals run worth asking for, in any repo.
 *
 * THE JARVIS REPOSITORY'S PATHS STAY HERE, though its files left this one. The
 * box reads this list out of tom.quest's main for every request that is not
 * tom.quest's own (the policy tree in Jarvis's worker/jobs/evals.mjs), so a
 * Jarvis pull request that changes worker/jobs/nightly.mjs is judged by the
 * line below that names it. Dropping those lines would call such a branch
 * unaffected and score nothing.
 *
 * THE ONLY SPELLING OF THAT LIST. It used to be spelled twice — here and in
 * .github/workflows/evals.yml's `paths:` — and the two drifted apart in both
 * directions before they were reconciled to their union. The workflow's copy
 * is now GONE: it fires on every pull request, and this list is what decides,
 * inside the check, whether a branch is affected at all. A list that exists
 * once cannot drift, and the answer is recorded on a row instead of being a
 * workflow that silently did not run.
 *
 * UNION IS THE SAFE DIRECTION, and the reconciliation stands. A watched path
 * that fires an unnecessary run costs one run. An unwatched path that changes
 * the context Tom's jobs read changes his outputs with nothing scoring them,
 * which is the exact failure the whole gate exists to prevent.
 *
 * FOUR PATHS WERE ADDED WHEN THE SKILLS LANDED, and each is a context file in
 * exactly the sense this list means — a file whose content reaches a run's
 * prompt. shared/skills.mjs is the table that decides what the skill set IS
 * and writes every description a run reads before it loads one;
 * scripts/publish-skills.mjs is the generator that turns that table into the
 * directories; shared/skill-router.mjs is what decides which of them a run
 * is granted. A change to any of the three changes what Tom's jobs are given
 * with nothing else scoring it. evals/triggers/** is watched for the reason
 * evals/golden/** is: it is the set, and a change to the set changes what a
 * comparison means. It is not ordinarily a pull-request coverage item: only a
 * skill description or router change may pay with a trigger case, because that
 * is the one change a trigger directly scores.
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
  // WHAT scripts/prelude.mjs READS. The eval runner executes the pinned
  // prelude, and skills.mjs and markdown-sections.mjs are its transitive
  // relative imports — change either one alone and the prompt every scored
  // item is built from changes while the file named above does not.
  // The Jarvis repository's scripts/prelude-watched.test.mjs walks the import
  // graph and fails when its copy of this list and that graph disagree, so a
  // new import lands there by being added rather than by being remembered. Phase 6 is why the graph moved:
  // the layers became skills, prelude-layers.mjs is gone, and skills.mjs is
  // what the prelude reads now.
  "shared/skills.mjs",
  // NOT IN THE PRELUDE GRAPH, AND WATCHED ANYWAY. publish-skills.mjs writes
  // the catalog the prelude reads and context-relevance.mjs is what a brief
  // is cut with; neither is imported by prelude.mjs, and both decide what a
  // run is given. The fence asks only that the graph be a SUBSET of this
  // list, so a file that earns its place by a second route keeps it.
  "scripts/publish-skills.mjs",
  "shared/context-relevance.mjs",
  "shared/markdown-sections.mjs",
  // The narrow list and the model table the prompts render, moved out of
  // convex/ttsShared.ts, which is watched below.
  "shared/session-constants.mjs",
  "convex/ttsShared.ts",
  "convex/claudeSessions.ts",
  "convex/ttsSkills.ts",
  "convex/ttsCompose.ts",
  "convex/ttsDigest.ts",
  "worker/jobs/plan-graphs.mjs",
  "worker/jobs/weekly.mjs",
  "worker/jobs/delegate.mjs",
  "shared/skill-router.mjs",
  "worker/bin/tts-ask",
  "evals/golden/**",
  "evals/tasks/**",
  // THE TRIGGER FILES ARE PART OF THE SET, and this line was missing from the
  // workflow's `paths:` list before it moved here. `loadTriggers` reads
  // evals/triggers/*.json into the run, and ITEM_PREFIXES below already names
  // the directory as a place a golden item lives — so a trigger-only change
  // moves what the set measures. While the filter lived in the workflow that
  // omission failed CLOSED: the job did not run, no row was written, and the
  // gate denied for want of one. Inside the check it fails OPEN — the check
  // runs, finds nothing watched, and writes a passing unaffected row for a
  // change to the set itself.
  "evals/triggers/**",
  // THE TWO JOBS WHOSE PROMPT NOTHING WATCHED. `checkin` builds its prompt from
  // worker/jobs/runner-checkin.mjs and `learning` from worker/jobs/nightly.mjs
  // and worker/jobs/learning-ground.mjs (worker/jobs/evals.mjs JOBS), and none
  // of the three was on this list — so a change to the check-in judge's own
  // prompt, or to the learning step's, was `unaffected`, wrote a passing row
  // with nothing scored, and merged with the nine items that exist to score it
  // never run. JOB_INPUTS below is where the mapping lives; these entries are
  // that mapping folded back in, and evals-check.test.mjs pins the two equal.
  "worker/jobs/runner-checkin.mjs",
  "worker/jobs/nightly.mjs",
  "worker/jobs/learning-ground.mjs",
];

/**
 * What every job's prompt reads, whatever the job is: the prelude assembler and
 * what it assembles, the rules files a run is given, and the set itself.
 *
 * A change to one of these moves every item, so a run that sees one regenerates
 * everything. They are the reason the per-job cut below is a saving on ORDINARY
 * pull requests rather than on all of them.
 */
export const SHARED_PROMPT_INPUTS = [
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
  "model-of-tom/**",
  "scripts/prelude.mjs",
  "shared/skills.mjs",
  "scripts/publish-skills.mjs",
  "shared/context-relevance.mjs",
  "shared/markdown-sections.mjs",
  "shared/skill-router.mjs",
  "evals/golden/**",
  "evals/tasks/**",
  "evals/triggers/**",
];

/**
 * The files ONE JOB'S PROMPT READS, beyond the shared ones.
 *
 * WHAT THIS BUYS. WATCHED_PATHS answers one question — is this branch worth a
 * run at all — and its answer is all or nothing: a branch touching
 * worker/jobs/plan-graphs.mjs regenerates the nine check-in items and the two
 * learning items too, though neither job reads that file and neither result can
 * differ. Every one of those is a live model call on each side of the
 * comparison. This table is the same policy asked per item, so a run pays for
 * the items its diff can actually move and carries the rest over from the base
 * row unchanged.
 *
 * IT IS A SUBSET OF WATCHED_PATHS AND MUST STAY ONE. WATCHED_PATHS decides
 * whether anything runs; if a path were here and not there, the branch would be
 * called unaffected and this table would never be consulted. evals-check.test.mjs
 * fails on a path here that is not watched.
 *
 * A JOB WITH NO ROW REGENERATES ON EVERY AFFECTED RUN. That is the safe
 * direction and it is deliberate: a job added to worker/jobs/evals.mjs without
 * a row here costs calls, where a row quietly missing a module would carry a
 * stale result over a change that did move it.
 */
export const JOB_INPUTS = {
  prepare: ["worker/jobs/plan-graphs.mjs", "convex/ttsCompose.ts", "convex/ttsShared.ts"],
  "code-brief": ["worker/jobs/plan-graphs.mjs", "shared/context-relevance.mjs"],
  explanation: [],
  run: ["shared/skill-router.mjs", "worker/bin/tts-ask", "worker/jobs/delegate.mjs"],
  learning: ["worker/jobs/nightly.mjs", "worker/jobs/learning-ground.mjs"],
  checkin: ["worker/jobs/runner-checkin.mjs"],
};

/**
 * The job names a diff can move, or null when it moves all of them.
 *
 * `null` is the answer to a shared input changing and to a changed list nobody
 * supplied — a weekly run, a run by hand — and it means "regenerate
 * everything". A caller that read it as "nothing" would carry every base result
 * over a change that moved them all, which is the one way this shortcut could
 * open the gate on an unmeasured tree, so the three-valued answer is never
 * collapsed here.
 */
export function jobsAffectedBy(changed) {
  if (!Array.isArray(changed)) return null;
  const paths = changed
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (paths.some((path) => SHARED_PROMPT_INPUTS.some((pattern) => matchesPattern(path, pattern)))) return null;
  // A watched path that names no job is a file some job may read through a
  // route this table does not describe. It is not a shared input and it is not
  // one job's, so the honest answer is the unnarrowed one.
  const named = new Set(Object.values(JOB_INPUTS).flat());
  const watched = paths.filter((path) => matchesWatched(path));
  if (watched.some((path) => !named.has(path))) return null;
  return Object.entries(JOB_INPUTS)
    .filter(([, inputs]) => inputs.some((input) => watched.includes(input)))
    .map(([job]) => job)
    .sort();
}

/** Where a golden item lives. A change that ships one of these is the thing
 *  the coverage rule asks for. */
const ITEM_PREFIXES = ["evals/golden/"];
const TRIGGER_COVERED_SKILL_PATHS = new Set([
  "shared/skills.mjs",
  "scripts/publish-skills.mjs",
  "shared/skill-router.mjs",
]);

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
 * What an UNAFFECTED run answers the coverage question with.
 *
 * A STRING, NOT `true`, because it is a different fact and the merge gate's
 * sentence about it is a different sentence: `true` means a watched file
 * changed and this branch paid for it, while this means the question never
 * arose. Both open the gate; only one of them was earned by a run.
 *
 * THREE HOMES, one fact, the same three homes gate() has: this file, the box
 * runner (worker/jobs/evals.mjs unaffectedRun) and the Convex door
 * (convex/ttsEvals.ts COVERAGE_NOT_REQUIRED, which convex/ttsMerge.ts reads).
 * Neither of those can import this one — the box loads it by path at runtime,
 * and Convex runs it nowhere — so the word is written out in each and the
 * tests on both sides pin it.
 */
export const COVERAGE_NOT_REQUIRED = "not-required";

/**
 * The `supersededBy` on a request the queue refused because it was filed
 * before the box's current evals row contract (shared/evals-row.mjs
 * PROTOCOL_SUPERSEDED, the one place it is defined; this file imports nothing,
 * so the word is written out here too and the tests on both sides pin it).
 *
 * The ANSWER IS THE SAME as for a head a later push replaced — nothing ran,
 * re-run at the head — and only the sentence differs, because "a later push
 * replaced this head" would be false about a sha nobody pushed over.
 */
export const PROTOCOL_SUPERSEDED = "protocol-2";

/** A sha is shown short; the protocol's name is shown whole. */
function supersededName(by) {
  if (typeof by !== "string" || by === "") return "a later push";
  return /^[0-9a-f]{7,40}$/i.test(by) ? by.slice(0, 7) : by;
}

/**
 * Does this branch need an evals run at all?
 *
 * TRUE ONLY ON A DIFF THAT WAS ACTUALLY READ. `null` — no checkout, a shallow
 * clone, a sha git could not find — is NOT an unaffected branch: it is a
 * branch nobody looked at, and answering "nothing watched changed" from a list
 * that was never computed would skip the evals on exactly the runs that lost
 * their diff. Those pay for a full run instead, which is the safe direction.
 *
 * An EMPTY diff is unaffected: a branch that changed no file changed no
 * watched file.
 */
export function unaffectedBy(changed) {
  if (!Array.isArray(changed)) return false;
  return !changed.some((path) => matchesWatched(path));
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
function coverageOf(changed, prBody, triggerFilesRun = []) {
  // NO DIFF, NO VERDICT. A --weekly run and a run by hand supply no changed
  // list, and answering `false` there would fail a run that was never asked
  // about a pull request at all.
  if (!Array.isArray(changed)) return { coverage: null, excuse: null };
  const paths = changed
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""));
  const watched = paths.filter((path) => matchesWatched(path));
  if (watched.length === 0) return { coverage: true, excuse: null };
  if (paths.some((path) => ITEM_PREFIXES.some((prefix) => path.startsWith(prefix)))) {
    return { coverage: true, excuse: null };
  }
  // A trigger case directly scores the published skill description or the
  // router. It does not score an arbitrary watched context file, so only those
  // three changes may use a trigger file to satisfy pull-request coverage.
  const triggerCoveredOnly = watched.every((path) =>
    path.startsWith("evals/triggers/") || TRIGGER_COVERED_SKILL_PATHS.has(path));
  const changedTriggers = paths
    .filter((path) => path.startsWith("evals/triggers/") && path.endsWith(".json"))
    .map((path) => path.slice("evals/triggers/".length));
  const ranTriggers = new Set(Array.isArray(triggerFilesRun) ? triggerFilesRun : []);
  if (triggerCoveredOnly &&
    changedTriggers.length > 0 &&
    changedTriggers.every((file) => ranTriggers.has(file)) &&
    watched.some((path) => TRIGGER_COVERED_SKILL_PATHS.has(path))) {
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
export function goldenItemRule(changed, prBody, triggerFilesRun) {
  return coverageOf(changed, prBody, triggerFilesRun).coverage;
}

/** Every failure of a run, golden items and repo tasks alike, by id. */
function failuresOf(run) {
  const map = new Map();
  for (const failure of run?.failures ?? []) map.set(failure.id, failure);
  for (const failure of run?.tasks?.failures ?? []) map.set(failure.id, failure);
  return map;
}

/**
 * Two runs compared on the INTERSECTION of what they scored: the ids both ran
 * with the same content are the only measurement, an id only at head is new,
 * an id only at base is removed, and an id whose content moved is both. A pair
 * with no intersection measured nothing, and says so with its reason.
 */
function mismatchOf(head, base) {
  if (!base) return null;
  // Box rows are regenerated under PR #172's protocol, so there is no
  // scoredIds compatibility path: per-item hashes are the measurement.
  if (head?.scoredHashes === null || typeof head?.scoredHashes !== "object" ||
    base?.scoredHashes === null || typeof base?.scoredHashes !== "object") {
    return { kind: "nonmeasurement", reason: "one or both runs lack per-item content hashes", comparable: [], new: [], removed: [], changed: [] };
  }
  const headIds = Object.keys(head.scoredHashes).filter((id) => typeof head.scoredHashes[id] === "string");
  const baseIds = Object.keys(base.scoredHashes).filter((id) => typeof base.scoredHashes[id] === "string");
  const baseSet = new Set(baseIds);
  const headSet = new Set(headIds);
  const comparable = headIds.filter((id) => baseSet.has(id) && head.scoredHashes[id] === base.scoredHashes[id]).sort();
  const changed = headIds.filter((id) => baseSet.has(id) && head.scoredHashes[id] !== base.scoredHashes[id]).sort();
  const added = headIds.filter((id) => !baseSet.has(id)).sort();
  const removed = baseIds.filter((id) => !headSet.has(id)).sort();
  const detail = {
    comparable,
    // A same-id changed body is new at head and removed at base, so neither
    // result is evidence that the other body regressed.
    new: [...added, ...changed].sort(),
    removed: [...removed, ...changed].sort(),
    changed,
  };
  if (comparable.length === 0) {
    return { kind: "nonmeasurement", reason: "the runs share no scored item with the same content hash", ...detail };
  }
  return detail;
}

/**
 * The gate. Pure, exported, tested.
 *
 * FAILS: a regression on the equal-id, equal-content intersection, a run with
 * no such intersection, or no head run at all.
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
  const { coverage: goldenCoverage, excuse: goldenExcuse } = coverageOf(changed, prBody, head?.triggerFilesRun);
  // The early returns carry coverage too, so no caller ever reads `undefined`
  // off a verdict and has to guess whether that meant false or unasked.
  if (!head) {
    return { ok: false, reason: "no head run", regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, goldenCoverage, goldenExcuse };
  }
  // AN UNAFFECTED ROW IS AN ANSWER, not a run: no watched path changed, so
  // nothing was scored and nothing could have regressed. It passes, and its
  // coverage is `not-required` rather than `true` — the question never arose,
  // and convex/ttsMerge.ts says so in its own words. Read off the ROW, not
  // re-derived from the diff here, so what the gate opens on and what the log
  // prints are the one fact the door recorded.
  // A LATER PUSH REPLACED THIS HEAD, and the box answered the request without
  // running anything (worker/jobs/evals.mjs supersededRun). Before the `error`
  // branch, which the same row also carries for readers that predate this one:
  // both fail, and this one says the thing that can be acted on.
  if (head.superseded === true) {
    const by = supersededName(head.supersededBy);
    const reason = head.supersededBy === PROTOCOL_SUPERSEDED
      ? "filed before the box's evals protocol, re-run at head"
      : `superseded by ${by}, re-run at head`;
    return { ok: false, reason, regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, goldenCoverage, goldenExcuse };
  }
  // A run the box could not make at all (a sha it could not fetch or check
  // out) is posted as a row carrying `error`, so the request queue advances.
  // A row like that scored nothing, and a gate that reads "no failures" off it
  // would open on a run that never happened.
  if (head.error === true || (typeof head.error === "string" && head.error !== "")) {
    const reason = typeof head.reason === "string" && head.reason !== ""
      ? head.reason
      : typeof head.error === "string" && head.error !== "" ? head.error : "runner failed";
    return { ok: false, reason, errored: [], regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, goldenCoverage, goldenExcuse };
  }
  if (head.unaffected === true) {
    return { ok: true, errored: [], regressions: [], stillFailing: [], newFailing: [], fixed: [], unconfirmed: [], mismatch: false, noBaseline: !base, goldenCoverage: COVERAGE_NOT_REQUIRED, goldenExcuse: null };
  }
  const headFailures = failuresOf(head);
  const baseFailures = failuresOf(base);
  const mismatchDetail = mismatchOf(head, base);
  const mismatch = mismatchDetail?.kind === "nonmeasurement";
  const comparable = new Set(mismatchDetail?.comparable ?? []);
  const regressions = [];
  const errored = [];
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
    // A RUNNER FAILURE IS NOT A FAILING ITEM. It is an item that was never
    // measured, so it belongs in neither the regression bucket nor the
    // new-failing one, and it is read first for that reason.
    if (failure.errored === true) errored.push(failure);
    else if (failure.confirmed === false) unconfirmed.push(failure);
    else if (!base || !comparable.has(id)) newFailing.push(failure);
    else if (baseFailures.has(id)) stillFailing.push(failure);
    else regressions.push(failure);
  }
  const fixed = [...baseFailures.values()].filter((failure) => comparable.has(failure.id) && !headFailures.has(failure.id));
  // Coverage fails the check on `false` alone. `null` is the absence of a
  // question, not an answer of no, and a run with no diff to read must not
  // fail a check it was never given the input for.
  const ok = errored.length === 0 && regressions.length === 0 && !mismatch && goldenCoverage !== false;
  return {
    ok, mismatch, mismatchDetail, errored, regressions, stillFailing, newFailing, fixed,
    unconfirmed, noBaseline: !base, goldenCoverage, goldenExcuse,
  };
}

/**
 * How long a run took and what it spent that on, when the row says.
 *
 * WHY THE CHECK PRINTS IT AT ALL. The pull-request wait is 75 minutes
 * (POLL_TIMEOUT_MS) and runs measured at 20 to 31 minutes were the reason it is
 * that long. A duration with no breakdown beside it cannot be acted on — a slow
 * run because thirty items were regenerated and a slow run because one call
 * hung are the same number — so the four counts travel with it. They are a
 * partition of the items the run was handed.
 *
 * REPORTED, NEVER GATED, and deliberately not a threshold yet. A check that
 * failed a merge on a slow box would fail it on a busy afternoon; what a
 * threshold needs first is a few weeks of this line on real rows, which is what
 * it is here to produce.
 */
export const SLOW_RUN_MS = 45 * 60 * 1000;

export function costLine(head) {
  const timing = head?.timing;
  if (timing === null || typeof timing !== "object" || typeof timing.durationMs !== "number") return [];
  const minutes = Math.round(timing.durationMs / 60_000);
  const spent = [
    `${timing.regenerated ?? 0} regenerated`,
    `${timing.cached ?? 0} carried over from the base`,
    `${timing.unreplayable ?? 0} unreplayable`,
    `${timing.skipped ?? 0} skipped`,
  ].join(", ");
  const slow = timing.durationMs > SLOW_RUN_MS
    ? `  SLOW: over ${Math.round(SLOW_RUN_MS / 60_000)} minutes, against a ${Math.round(POLL_TIMEOUT_MS / 60_000)}-minute wait.`
    : null;
  return [
    `  ${minutes} min at ${timing.concurrency ?? 1} at a time, ${head.calls ?? 0} calls: ${spent}.`,
    ...(slow === null ? [] : [slow]),
  ];
}

/** What Tom sees in the check's log. A clean check is one line. */
export function report(head, base, verdict) {
  if (head.superseded !== true && (head.error === true || (typeof head.error === "string" && head.error !== ""))) {
    const reason = typeof head.reason === "string" && head.reason !== ""
      ? head.reason
      : typeof head.error === "string" && head.error !== "" ? head.error : "runner failed";
    return [`the evals could not run on the box: ${reason}`];
  }
  // ONE LINE, and it names the sha and the count, because the whole content of
  // an unaffected check is "we looked at the diff and it touched nothing the
  // evals watch". THE SAME WORDS the merge gate's `why` uses (convex/
  // ttsMerge.ts), so the CI log and the #tts-decisions merge line say the same
  // thing about the same commit.
  if (head.unaffected === true) {
    const changed = Array.isArray(head.changed) ? head.changed.length : null;
    return [
      `evals — ${head.repo} ${String(head.sha).slice(0, 7)}: the evals are unaffected — no watched path changed` +
        (changed === null ? "." : ` in the ${changed} path${changed === 1 ? "" : "s"} this branch touched.`),
    ];
  }
  // A STALE SHA'S CHECK, in two lines and no numbers. This run never happened
  // — the branch moved on before the box reached it — so there is no set, no
  // base and nothing to compare, and the only useful sentence is which sha to
  // look at instead.
  if (head.superseded === true) {
    const by = supersededName(head.supersededBy);
    if (head.supersededBy === PROTOCOL_SUPERSEDED) {
      return [
        `evals — ${head.repo} ${String(head.sha).slice(0, 7)}: filed before the box's evals protocol.`,
        `FAILED: this request predates the evals row contract the box now writes, so it was never run. Re-run this check at the head of the branch.`,
      ];
    }
    return [
      `evals — ${head.repo} ${String(head.sha).slice(0, 7)}: superseded by ${by}.`,
      `FAILED: a later push replaced this head before the box reached it — nothing was run. Re-run this check at the head of the branch.`,
    ];
  }
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
    verdict.errored.length > 0 ? `${verdict.errored.length} errored` : null,
    verdict.stillFailing.length > 0 ? `${verdict.stillFailing.length} still failing` : null,
    verdict.unconfirmed.length > 0 ? `${verdict.unconfirmed.length} failing but not confirmed by Tom` : null,
  ].filter((note) => note !== null);
  // An excused change is never the one-line check: the sentence Tom wrote to
  // get past the coverage rule is the whole value of the escape hatch, and a
  // hatch used silently is a hatch nobody audits.
  const quiet = verdict.stillFailing.length === 0 && verdict.newFailing.length === 0 &&
    verdict.unconfirmed.length === 0 && verdict.fixed.length === 0 &&
    !verdict.goldenExcuse && (verdict.mismatchDetail?.new?.length ?? 0) === 0 &&
    (verdict.mismatchDetail?.removed?.length ?? 0) === 0;
  const cost = costLine(head);
  if (verdict.ok && quiet) {
    return [`${setLine}: ${head.pass} pass, ${head.fail} fail, ${notes.join(", ")}.`, ...cost];
  }
  lines.push(setLine);
  lines.push(...cost);
  lines.push(`  head: ${head.pass} pass, ${head.fail} fail, ${flaky} flaky` + (base ? `      base: ${base.pass} pass, ${base.fail} fail` : ""));
  if (verdict.noBaseline) lines.push(`  no baseline for the base commit; reporting only`);
  if (verdict.mismatch) {
    lines.push(`  GOLDEN SET COMPARISON UNAVAILABLE  ${verdict.mismatchDetail?.reason} — re-run the base and head:`);
    lines.push(`    node /opt/jarvis/worker/jobs/evals.mjs --repo ${head.repo} --sha ${base.sha} --force`);
  }
  if (verdict.mismatchDetail?.new?.length > 0) {
    lines.push(`  new scored items: ${verdict.mismatchDetail.new.join(", ")}`);
  }
  if (verdict.mismatchDetail?.removed?.length > 0) {
    lines.push(`  removed scored items: ${verdict.mismatchDetail.removed.join(", ")}`);
  }
  // Coverage says nothing at all when it is null: a run with no diff was never
  // asked, and a line about a rule that did not apply is noise in every
  // by-hand and weekly log.
  if (verdict.goldenCoverage === false) {
    lines.push(`  NO GOLDEN ITEM  a watched context file changed and this branch ships no item under evals/golden/** — a trigger file satisfies coverage only after its cases ran in this pull-request run and only with shared/skills.mjs, scripts/publish-skills.mjs, or shared/skill-router.mjs — add one, or put "evals: no-item <reason>" on the pull-request body`);
  } else if (verdict.goldenExcuse) {
    lines.push(`  golden item excused: ${verdict.goldenExcuse}`);
  }
  const say = (label, failure) => `  ${label}  ${failure.id} (${failure.partition}, ${failure.verdict}) — ${failure.reason}`;
  for (const failure of verdict.errored) lines.push(say("errored", failure));
  for (const failure of verdict.regressions) lines.push(say("REGRESSION", failure));
  for (const failure of verdict.stillFailing) lines.push(say("still failing", failure));
  for (const failure of verdict.newFailing) lines.push(say("new, failing", failure));
  for (const failure of verdict.unconfirmed) lines.push(say("unconfirmed", failure));
  for (const failure of verdict.fixed) lines.push(`  fixed  ${failure.id} (${failure.partition}, ${failure.verdict})`);
  // The summary line names WHAT failed. Coverage can fail a run with zero
  // regressions, and "FAILED: 0 regressions." is a sentence no one can act on.
  lines.push((verdict.ok
    ? `PASSED: 0 regressions.`
    : verdict.errored.length > 0
      ? `FAILED: ${verdict.errored.length} errored.`
      : verdict.mismatch
      ? `FAILED: the runs have no comparable scored item.`
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
 * Wait for the row, except that a named protocol gap is already a complete
 * answer: another seventy-five minutes cannot roll the box. The exit hook is
 * injectable only so the one-poll, non-zero behavior can be pinned without a
 * child process in the unit test.
 */
export async function waitForEvals(
  { site, key, repo, sha, baseSha, deadline },
  {
    callFn = call,
    sleepFn = sleep,
    now = () => Date.now(),
    log = (line) => console.log(line),
    error = (line) => console.error(line),
    exit = (code) => process.exit(code),
  } = {},
) {
  let answer = null;
  while (now() < deadline) {
    const query = `/tts/evals-run?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}` +
      (baseSha ? `&base=${encodeURIComponent(baseSha)}` : "");
    answer = await callFn(site, key, query);
    if (typeof answer?.protocolGap === "string" && answer.protocolGap !== "") {
      error(answer.protocolGap);
      exit(1);
      return { answer, protocolGap: true };
    }
    if (answer?.run) return { answer, protocolGap: false };
    log(`evals: waiting for the Jarvis Box (${Math.round((deadline - now()) / 1000)}s left)`);
    await sleepFn(POLL_INTERVAL_MS);
  }
  return { answer, protocolGap: false };
}

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
/** Git's -z output: filenames can contain newlines and must never be quoted. */
export function changedPathsFromGit(out) {
  return out.split("\0").filter((path) => path !== "");
}

export async function changedPaths(baseSha, sha) {
  if (!baseSha || !sha) return null;
  try {
    const { execFileSync } = await import("node:child_process");
    // `--no-renames` IS LOAD-BEARING, not tidiness. With rename detection on,
    // `--name-only` prints a rename as its DESTINATION alone: move
    // `model-of-tom/intent.md` to `docs/intent.md` and the only path this list
    // carries is the unwatched one, so `unaffectedBy` answers true and a watched
    // context file leaves the tree with no run scoring it — the exact failure the
    // watch list exists to prevent. Off, a rename is a delete and an add, and the
    // delete is watched.
    const out = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${baseSha}...${sha}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return changedPathsFromGit(out);
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
  // WHICH PUSH CAME FIRST, and the only fact on hand that answers it.
  //
  // GitHub creates one workflow run per push event, in the order the events
  // arrive, and stamps each with an increasing id. The queue needs that order
  // to tell a pull request's live head from the shas behind it (convex/
  // ttsEvals.ts), and it cannot use the order the REQUESTS arrive in: two
  // pushes a minute apart start two jobs that each spend twenty to forty
  // seconds on checkout and node before reaching this line, so the newer
  // push's request can be filed first — and a queue that read arrival order
  // would then answer the LIVE head away as superseded, permanently, since
  // the row it writes is what stops the box picking that sha up again.
  //
  // A re-run keeps its run's id, so re-running an old sha's check never makes
  // that sha look like the newest. A force-push back to an earlier commit gets
  // a NEW run with a HIGHER id, which is right: that commit is the head now.
  const runIdRaw = Number(process.env.RUN_ID);
  const runId = Number.isSafeInteger(runIdRaw) && runIdRaw > 0 ? runIdRaw : undefined;
  const changed = await changedPaths(baseSha, sha);
  // THE FILTER THAT USED TO BE THE WORKFLOW'S. It lives here now because a
  // workflow that does not run records nothing, and the merge gate needs a row
  // (convex/ttsMerge.ts denies without one). An unaffected request is answered
  // by the door itself, in the same breath it is filed, so the poll below ends
  // on its first pass and no model is spent.
  const unaffected = unaffectedBy(changed);
  if (unaffected) {
    console.log(
      `evals: no watched path changed in the ${changed.length} path${changed.length === 1 ? "" : "s"} ` +
        `this branch touched — asking for an unaffected row, not a run.`,
    );
  }

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
    ...(runId === undefined ? {} : { runId }),
    paths: WATCHED_PATHS,
    ...(changed === null ? {} : { changed }),
    ...(prBody === undefined ? {} : { prBody }),
    ...(unaffected ? { unaffected: true } : {}),
  });
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const waited = await waitForEvals({ site, key, repo, sha, baseSha, deadline });
  if (waited.protocolGap) return;
  const answer = waited.answer;
  // A check that passes on silence proves nothing.
  if (!answer?.run) {
    console.error(
      `evals: the Jarvis Box did not answer within ${POLL_TIMEOUT_MS / 60_000} minutes. Re-run this check, or run it by hand: ` +
        `node /opt/jarvis/worker/jobs/evals.mjs --repo ${repo} --sha ${sha} --force`,
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
