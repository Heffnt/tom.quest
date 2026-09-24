// plan-graphs.mjs — THE PLANNER. One run, one pass: PREPARE.
//
// NO SHEBANG LINE, for nightly.mjs's reason (write-slack.mjs and
// scripts/check-writing-standard.mjs say it too): since the door check landed
// this file reaches check-writing-standard.mjs by a DYNAMIC IMPORT, and the
// test bundler rewrites such a module by prepending an import — which lands in
// front of a shebang and fails to parse, so the whole test file refuses to
// load. Every caller already names the interpreter: the cron line
// (worker/setup.sh) is `/usr/bin/node /opt/tts/plan-graphs.mjs`, and so is
// every manual run in worker/README.md.
//
// PREPARE — every unprepared life todo (a #dump capture, an email capture, a
// Canvas announcement, a todo Tom ruled "revise" on) gets its write-up: a
// brief, the smallest entry action, a work description, a ground-up
// explanation, and readiness "prepared". One headless-Claude call per todo.
// This pass used to be its own job (prepare-life-todos.mjs, every 2 minutes)
// and was absorbed here in the lifeos update, phase 7. A task inside a batch
// is skipped (isGraphTask below); a goal is not. Nothing here posts to Slack —
// the events route replies at capture.
//
// TWO PASSES ARE RETIRED. BRIEF wrote a brief for every open entry of CMT's
// vqc/todos.yaml (see "The code-brief prompt" below). PLAN bound todos into
// batches and wrote the graph of tasks inside each one; Tom ruled on
// 2026-09-24: "I dont want to have batches at all anymore because I want to
// remove structure to allow agents to freely move toward completing all todos
// in the best way they (or the orchistrator) see fit." The plan pass was
// deleted that day, so nothing here writes a batch, a task graph or a goal
// binding.
//
// Run by cron every 30 minutes under flock (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/plan-graphs.mjs            # the prepare pass
//   node /opt/tts/plan-graphs.mjs --force    # also re-prepare prepared todos
//
// THE PREPARE PASS NEVER REWRITES INTENT. It writes brief, entryAction,
// workDescription, groundUpExplanation and readiness; the statement and the
// status are Tom's (the server pen, tts.internalPrepareTodo, enforces the
// same). A date reaches a todo through this pass ONLY when the statement
// itself states one ("pay rent sept 3") — Tom's own words, never a guess —
// and only as a FIRST date (the pen refuses an overwrite and a resurrection
// of a date Tom already resolved). Whether a prepared todo is READY for Tom
// is computed on the server (convex/ttsShared.ts isReadyForTom), never
// written here.
//
// GROUND-UP EXPLANATIONS ARE HTML DOCUMENTS (Tom, 2026-08-29: rendered as
// prose they are "an incomprehensible wall of text"). Every explanation this
// job writes is a complete self-contained HTML page, which the /tts page shows
// fullscreen in a sandboxed, script-less iframe. The form is specified once,
// in the writing standard that rides in on /tts/batch-context; the prompt
// below only names the requirement.
//
// REVISE RULINGS. Tom can rule "revise" with one written sentence on a life
// todo; the prepare pass re-prepares it with the sentence in the prompt. The
// ruling is consumed via /tts/ruling-applied only once the re-preparation
// landed — a failed preparation leaves it pending, so the next run tries
// again on the same sentence.
//
// THE DOOR CHECK (phase 9). The prepare pass READS WHAT IT WROTE before
// posting it, against the writing standard's own rules — see THE DOOR CHECK
// below for the loop, the two-attempt bound and what a fault costs.
//
// NO-STATE RULE: Convex is read and written each run, and no local file is
// kept.
//
// TESTABLE HALVES. The pass is exported and takes its model call and its
// Convex writes as an `io` argument, so worker/jobs/plan-graphs.test.mjs runs
// it against stubs; main() below wires the real ones. Importing this module is
// safe: it only runs main() when node was pointed at the file (the
// `invokedDirectly` guard at the bottom).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadEnv,
  convexFetch,
  runClaude,
  extractJsonObject,
  nyNoonUtcMs,
  JSON_ONLY_ANSWER,
  MODELS,
} from "./tts-lib.mjs";

// ── The prepare pass's bounds ────────────────────────────────────────────────
// Todos prepared per run. One Claude call each, so the bound is the run's
// worst case: PREPARE_MAX × PREPARE_TIMEOUT_MS, inside the 30-minute cadence
// only because the cron line's flock makes an overrun a skipped tick rather
// than a second run. A backlog drains PREPARE_MAX per run.
export const PREPARE_MAX = 10;
export const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
// The one value preparation produces (ruling 18); ready is computed.
export const PREPARED = "prepared";

// ── THE DOOR CHECK ───────────────────────────────────────────────────────────
// Both writing passes below read what the model wrote before posting it. Until
// this round they read only the JSON's SHAPE — the field types — and the
// writing standard reached them as text inside the prompt and nothing more:
// this was the one generation door in TTS with no mechanical check behind it.
//
// WHAT A FAULT COSTS. Tom ruled on 2026-09-12 ("Agreed.") that a write-up that
// fails this check on both attempts is STILL POSTED and reaches him CARRYING
// THE MARK. It is never withheld, never retried forever and never silently
// downgraded: a silent hole — a todo with no brief — costs him more than a
// brief he can see is faulty. The mark rides the "prepared" event, and /tts
// prints it under the brief. (The retired code-brief pass carried the same
// mark on its brief row.)
//
// TWO ATTEMPTS, ONE RETRY, and the number is the digest writer's
// (worker/jobs/write-slack.mjs writeOne) for the digest writer's reason: a
// second retry buys a THIRD live model call per item on a cron that already
// runs one per item, and that job's record shows the first retry is where the
// fault is fixed — a draft that fails the same check twice fails it because
// the model reads the rule differently, not because it was unlucky.
//
// DETERMINISTIC ONLY. There is no model judge here and no flag for one. First,
// a judge whose agreement with Tom has never been measured must not stand in
// front of the prose he reads, and the replay that would measure it is landing
// in this same round with no history to measure against yet. Second, a judge
// at this door is one more live model call per todo on the planner's cadence.
// THE SEAM IS doorFaults: a judge's complaints would join the list the two
// functions below return, and nothing else in either pass would change.

/**
 * The writing standard's RULE BODIES — scripts/check-writing-standard.mjs,
 * loaded as a module.
 *
 * NOT the same thing as the `writingStandard` string the passes take. That
 * value is the published model-of-tom prelude, assembled by Convex and served
 * on /tts/batch-context (main() below refuses to run without it); it is PROSE
 * FOR THE MODEL and has no rule objects in it. This is the executable half:
 * RULES (the HTML-document form), BRIEF_RULES (the four mechanical demands on
 * a stored brief) and briefFormRules() (the two of those four that bind any
 * short prose field), plus failuresFor, which is the one implementation of
 * what a rule means — the door never reimplements a rule, and never
 * reimplements the split between them either.
 *
 * THE FILE HAS TWO HOMES — /opt/tts/scripts/ below the flat jobs (worker/setup.sh
 * copies it there) and scripts/ in a checkout — so both are tried, in that order, exactly
 * as worker/jobs/evals.mjs loadWritingStandard() does. AN ABSENT FILE IS "NO
 * RULES RAN", NEVER A FAILURE, for that function's stated reason: a box whose
 * setup.sh has not copied it must not start refusing every item on a check it
 * cannot perform.
 */
export async function loadStandardRules() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "scripts", "check-writing-standard.mjs"),
    path.join(here, "..", "..", "scripts", "check-writing-standard.mjs"),
  ]) {
    if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  }
  return null;
}

// WHICH RULES BIND WHICH FIELD, and it is not "all of them on everything".
// The two SIZE rules in BRIEF_RULES — brief-sentences and brief-length — bind
// the LIFE TODO'S brief and nothing else; the two FORM rules bind every short
// prose field this door reads (workDescription, and the retired code brief's
// brief and recommendation, which the evals still score).
// That split has ONE HOME and this file does not keep a copy of it: it is
// BRIEF_SIZE_RULE_IDS and briefFormRules() in scripts/check-writing-standard.mjs,
// where the argument is written out at length — a size rule pointed at a
// one-word recommendation or a 400-WORD code brief refuses every item on every
// run, and a door that fires on everything is one nobody reads. This door
// reaches briefFormRules() through the loaded module, exactly as it reaches
// RULES and BRIEF_RULES; a module that is absent (or too old to export it)
// answers nothing, which checks nothing and fails nothing.

/**
 * One complaint per broken rule, in THE RULE'S OWN WORDS: `<field>: <rule id>
 * — <the rule's why>`. The complaint the model is given to fix and the mark
 * Tom reads are then the same sentence, which is the point of reading `why`
 * off the rule rather than writing a second description of it here.
 *
 * No standard module, no rules, or an empty value: no complaints. An empty
 * value is the shape check's business (below), not this one's.
 */
function standardComplaints(field, value, rules, standard) {
  if (standard === null || standard === undefined) return [];
  if (!Array.isArray(rules) || rules.length === 0) return [];
  if (typeof value !== "string" || value.trim() === "") return [];
  const why = new Map(rules.map((r) => [r.id, r.why]));
  return standard
    .failuresFor(value, rules)
    .map((id) => `${field}: ${id} — ${why.get(id) ?? "fails the writing standard"}`);
}

/** The refusal block, appended to the next attempt's prompt verbatim — the
 *  same words draftPrompt() in write-slack.mjs uses, because it is the same
 *  instruction: fix these, change nothing else. */
function refusalBlock(complaints) {
  return [
    ``,
    `YOUR LAST DRAFT WAS REFUSED. Fix exactly these and change nothing else:`,
    ...complaints.map((c) => `- ${c}`),
  ];
}

// ── PASS 1: prepare ──────────────────────────────────────────────────────────

/**
 * The prompt that prepares ONE life todo.
 *
 * `complaints` is the door check's fault list from the PREVIOUS attempt, empty
 * on the first. It is appended last, after every fixed instruction and after
 * the item itself, exactly as draftPrompt() appends it in write-slack.mjs.
 */
export function preparePrompt(todo, reviseSentence, today, writingStandard, complaints = []) {
  return [
    writingStandard,
    ``,
    `You are preparing one item in TTS, Tom's personal todo system. It was`,
    `captured as a raw thought; your job is to make it arrive pre-chewed.`,
    ``,
    `Write:`,
    `1. "brief" - 2-5 sentences. If the statement is too terse to interpret`,
    `   confidently, say so plainly in the brief and phrase what needs clarifying.`,
    `2. "entryAction" - the SMALLEST first action, imperative, under 10 words`,
    `   (e.g. "Open the reservation page", "Draft two sentences to Ana").`,
    `3. "workDescription" - the kind/size of engagement, qualitatively, a few`,
    `   words (e.g. "a two-minute errand", "a short ruling", "a session's`,
    `   worth of writing"). NEVER a numeric time estimate.`,
    `4. "groundUpExplanation"`,
    `5. "dueDate" - ONLY when the statement ITSELF names an explicit date`,
    `   ("pay rent sept 3", "call the bank on Friday the 12th"). Then give it`,
    `   as "YYYY-MM-DD". Otherwise give null.`,
    `   NEVER infer, estimate, or invent a date - no "this seems urgent, so`,
    `   next week". A date you were not told in the statement is a date that`,
    `   does not exist. Only the words in "statement" count; a date mentioned`,
    `   anywhere else is not this item's date.`,
    `6. "dateKind" - ONLY when you gave a dueDate. "external" if the statement`,
    `   shows the deadline was imposed by someone or something else (a bill, a`,
    `   landlord, a booking window, a court date); "self-imposed" if it reads`,
    `   as Tom's own choice of when. When the statement does not say, answer`,
    `   "self-imposed". Otherwise give null.`,
    ``,
    JSON_ONLY_ANSWER,
    `{"brief": "...", "entryAction": "...", "workDescription": "...",`,
    ` "groundUpExplanation": "<explanation>",`,
    ` "dueDate": null, "dateKind": null}`,
    ``,
    `The item (JSON):`,
    JSON.stringify({
      statement: todo.statement,
      source: todo.source,
      provenance: todo.provenance ?? null,
      category: todo.category ?? null,
      createdAt: todo.createdAt,
    }, null, 2),
    ``,
    ...(reviseSentence ? [
      `Tom reviewed an earlier preparation of this item and ruled "revise" -`,
      `his one written sentence below redirects this re-preparation and`,
      `overrides any other reading of the item:`,
      ``,
      `Tom's revise ruling: ${reviseSentence}`,
      ``,
    ] : []),
    `Today is ${today} in New York, which is how you resolve a bare month+day`,
    `or weekday to a year.`,
    ...(complaints.length > 0 ? refusalBlock(complaints) : []),
  ].join("\n");
}

/**
 * What is missing or unusable in a prepare answer — the checks this pass has
 * always made, moved in here so there is ONE fault list.
 *
 * A SHAPE FAULT IS NOT A WRITING FAULT, and the difference decides what
 * happens on the second attempt: a missing field is NOTHING TO POST — there is
 * no write-up to mark — so the item fails as it always has, is logged, and the
 * next run retries it. A badly-written field is SOMETHING TO POST, marked.
 */
export function prepareShapeFaults(parsed) {
  const faults = [];
  for (const field of ["brief", "entryAction", "workDescription", "groundUpExplanation"]) {
    if (typeof parsed?.[field] !== "string") {
      faults.push(`${field}: missing — the answer must carry ${field} as a string`);
    }
  }
  if (
    typeof parsed?.groundUpExplanation === "string" &&
    parsed.groundUpExplanation.trim() === ""
  ) {
    faults.push(
      `groundUpExplanation: empty — the explanation is a complete HTML document, not an empty string`,
    );
  }
  return faults;
}

/**
 * Everything wrong with one prepare answer, as one list of short sentences.
 *
 * Shape first and alone: with a field missing there is no prose to read, and a
 * complaint about the writing of a string that is not there would send the
 * retry after the wrong thing. Otherwise the writing standard, over the fields
 * it binds — the full BRIEF_RULES on the life todo's brief, the FORM rules on
 * workDescription (WHICH RULES BIND WHICH FIELD above says where that split
 * lives).
 */
export function prepareDoorFaults(parsed, standard) {
  const shape = prepareShapeFaults(parsed);
  if (shape.length > 0) return shape;
  return [
    ...standardComplaints(
      "groundUpExplanation",
      parsed.groundUpExplanation,
      standard?.RULES,
      standard,
    ),
    ...standardComplaints("brief", parsed.brief, standard?.BRIEF_RULES, standard),
    ...standardComplaints(
      "workDescription",
      parsed.workDescription,
      standard?.briefFormRules?.(),
      standard,
    ),
  ];
}

/** A row inside a batch that is not a goal: a step of a graph, never prepared
 * on its own ("unprepared" is a task's resting state; briefing one would
 * flood the needs-me feed with plan steps). */
const isGraphTask = (t) =>
  t.batchId !== undefined && t.batchId !== null && t.kind !== "goal";

/**
 * Which todos this run prepares, and the revise ruling each carries, from the
 * pending-rulings feed and the todo list:
 *   - a graph task is never prepared here (see isGraphTask); a GOAL is — it is
 *     one of Tom's own todos the planner bound, and binding must not be what
 *     stops it getting prepared;
 *   - an active unprepared todo is prepared; with `force`, a prepared one too;
 *   - a todo with a pending life "revise" ruling is re-prepared REGARDLESS of
 *     status (the verdict dropped its readiness server-side; the sentence is
 *     what pulls it back in, and preparation touches no status, so
 *     re-preparing an archived todo is safe — an active-only filter would
 *     strand the ruling pending forever if Tom changed the status after
 *     ruling).
 */
export function selectPrepareTargets(todos, pending, { force = false } = {}) {
  const all = Array.isArray(todos) ? todos : [];
  const reviseByTodo = new Map();
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "life" || r.verdict !== "revise" || !r.todoId) continue;
    reviseByTodo.set(r.todoId, r);
  }
  const targets = all.filter(
    (t) =>
      !isGraphTask(t) &&
      (reviseByTodo.has(t._id) ||
        (t.status === "active" && (t.readiness === "unprepared" || force))),
  );
  return { targets, reviseByTodo };
}

/**
 * The prepare pass. `io.runClaude(prompt, opts)` answers the model call and
 * `io.post(path, body)` is the Convex write; both are the real functions in
 * main() and stubs in the tests. `standard` is the writing standard's rule
 * MODULE (loadStandardRules above), null when the file is not reachable —
 * which checks nothing and fails nothing. Returns the counts and the ids
 * prepared.
 */
export async function prepareLifeTodos(
  { todos, pending, today, writingStandard, standard = null, force = false },
  io,
) {
  const { targets, reviseByTodo } = selectPrepareTargets(todos, pending, { force });
  if (targets.length === 0) return { prepared: 0, failed: 0, preparedIds: [] };
  const batch = targets.slice(0, PREPARE_MAX);
  console.log(
    `[plan-graphs] prepare: ${targets.length} to prepare ` +
      `(${reviseByTodo.size} revise ruling(s) pending), processing ${batch.length}`,
  );
  let failed = 0;
  const preparedIds = [];
  for (const todo of batch) {
    const revise = reviseByTodo.get(todo._id) ?? null;
    try {
      // TWO ATTEMPTS, ONE RETRY (see THE DOOR CHECK above for the number).
      // `receipt` and `parsed` are the LAST attempt's when the loop ends,
      // whichever way it ended, because the last attempt is the one whose text
      // is posted.
      let receipt;
      let parsed;
      let faults = [];
      let complaints = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // A FRESH RECEIPT PER CALL, never one object hoisted out of the loop:
        // runClaude fills it with the token of the CHILD run this call spawns,
        // and a shared receipt would report the last pass's token for every
        // todo in the batch — every ruling after the first scored against the
        // wrong run's output. PER ATTEMPT for the same reason the digest
        // writer takes a fresh one per attempt: the second attempt is a second
        // run, and the token that matters is the one whose text was accepted.
        //
        // NOT process.env.TTS_RUN_REG_TOKEN, which is this job's own run: the
        // write-up Tom reads was written by the child, and the job only carried
        // it.
        receipt = {};
        const answer = io.runClaude(
          preparePrompt(todo, revise?.sentence ?? null, today, writingStandard, complaints),
          {
            timeoutMs: PREPARE_TIMEOUT_MS,
            model: MODELS.planner,
            registration: {
              origin: "cron:plan-graphs",
              kind: "job",
              todoId: todo._id,
              layersKnown: false,
              layersGiven: [],
              layersDenied: [],
              writingStandardSource: "/tts/batch-context",
            },
            receipt,
          },
        );
        // An answer that is not JSON at all throws here and the item fails as
        // it always has: a broken envelope is not a door fault, and there is
        // nothing to put in a complaint but "this was not JSON", which the
        // answer shape in the prompt already says.
        parsed = extractJsonObject(answer);
        faults = prepareDoorFaults(parsed, standard);
        if (faults.length === 0) break;
        complaints = faults;
        console.error(
          `[plan-graphs] prepare ${todo._id}: the door check refused attempt ${attempt} — ` +
            faults.join("; "),
        );
      }
      // A SHAPE FAULT ON THE LAST ATTEMPT IS NOTHING TO POST. A missing field
      // means there is no write-up at all, so this item fails exactly as it
      // did before the door existed and the next run retries it. A STANDARD
      // fault is a different thing entirely: the write-up exists and Tom's
      // ruling is that it reaches him carrying the mark.
      if (prepareShapeFaults(parsed).length > 0) {
        throw new Error(`bad shape: ${JSON.stringify(parsed).slice(0, 120)}`);
      }
      // A date the STATEMENT states, in Tom's own words. Sent only when the
      // todo has no date AND no date HISTORY — a todo whose date Tom already
      // resolved (missed, renegotiated) must never have that same date handed
      // back to it by a re-prep of the same sentence. The server enforces both
      // halves regardless (internalPrepareTodo); this filter keeps the job
      // from asking. A malformed date is dropped, never guessed at: the rest
      // of the preparation still lands.
      let dueAt;
      const dateSettled =
        todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0;
      if (typeof parsed.dueDate === "string" && !dateSettled) {
        try {
          dueAt = nyNoonUtcMs(parsed.dueDate.trim());
        } catch (e) {
          console.error(`[plan-graphs] ${todo._id} ignoring dueDate: ${e.message}`);
        }
      }
      // Whose deadline it is, as the statement reads it — passed through, not
      // assumed. Anything but a clean "external" is self-imposed.
      const dateKind = parsed.dateKind === "external" ? "external" : "self-imposed";
      await io.post("/tts/prepare-todo", {
        id: todo._id,
        brief: parsed.brief,
        entryAction: parsed.entryAction,
        workDescription: parsed.workDescription,
        groundUpExplanation: parsed.groundUpExplanation,
        readiness: PREPARED,
        ...(dueAt !== undefined ? { dueAt, dateKind } : {}),
        // THE MARK, and only when there is one. A pass that got through the
        // door sends NO doorFaults KEY AT ALL, so the newest "prepared" event
        // for this todo answers "was the last write-up refused" by itself,
        // with nothing to clear: the next clean preparation writes a fresh
        // event that simply does not carry the key.
        ...(faults.length > 0 ? { doorFaults: faults } : {}),
        // The edge from the row Tom reads back to the run that wrote it. Sent
        // only when there is one: an unregistered call fills no receipt, and
        // the row then carries no token rather than a false one.
        ...(receipt.runToken ? { runToken: receipt.runToken } : {}),
      });
      if (revise) {
        // The re-prep landed — consume the ruling so the UI shows the
        // outcome and the next run doesn't re-prepare on the same sentence.
        await io.post("/tts/ruling-applied", {
          id: revise._id,
          result: "revised: brief re-prepared",
        });
      }
      preparedIds.push(todo._id);
      console.log(
        `[plan-graphs] prepared ${todo._id}` +
          `${revise ? " (revise ruling applied)" : ""} ` +
          `"${todo.statement.slice(0, 50).replace(/\s+/g, " ")}"` +
          `${faults.length > 0 ? " — posted CARRYING THE DOOR MARK" : ""}`,
      );
    } catch (err) {
      // Per-item failure: log and continue — the item stays unprepared (or
      // its revise ruling stays pending) and the next run retries it. One
      // bad item must not starve the batch.
      failed++;
      console.error(
        `[plan-graphs] prepare ${todo._id} FAILED: ${String(err.message ?? err).slice(-200)}`,
      );
    }
  }
  return { prepared: preparedIds.length, failed, preparedIds };
}

// ── The code-brief prompt (the brief PASS is retired) ────────────────────────
// This file used to run a second pass between prepare and plan: every open
// entry of ComplexMultiTrigger's vqc/todos.yaml got a ground-up brief against
// the current tree and a recommendation in the four verdict words, posted to
// /tts/code-briefs. That file was the only one the pass ever read, and Tom's
// ruling of 2026-09-22 (CMT adoption ruling 70, 2026-09-24) moved CMT's todos
// into TTS, where the prepare pass above writes them up like any other todo —
// so the pass, its hash cursor and its door check are gone. The prompt stays
// for one reader: the evals' "code-brief" job (worker/jobs/evals.mjs) replays
// the recorded briefs through it, and retiring that partition is its own
// change.

// Build the per-entry prompt. `entryYaml` is the entry's RAW block from
// todos.yaml (real YAML beats re-serialized JSON: Tom's comments and block
// scalars survive), `replanNote` is Tom's revise sentence when he ruled
// revise, else null, and `complaints` is the door check's fault list from the
// previous attempt (empty on the first), appended last.
export function briefPrompt(entryYaml, replanNote, writingStandard, complaints = []) {
  return [
    writingStandard,
    ``,
    `You are briefing Tom on ONE entry of vqc/todos.yaml in the ComplexMultiTrigger`,
    `repo. Your working directory is a checkout of that repo at current master -`,
    `use your file-reading tools to open the files, ledger entries, and constitution`,
    `articles the entry cites, and any code the plan touches. Verify, don't assume.`,
    ``,
    `Write a GROUND-UP brief for Tom (~250-400 words).`,
    ``,
    `End with a recommendation - the verdict Tom will most likely rule, in`,
    `the four words he rules in - chosen by EXACTLY these criteria, in order;`,
    `the first that applies wins:`,
    `1. The completion condition is already satisfied by landed work, or the`,
    `   intent is moot/superseded -> "archive", and set "evidence" to the`,
    `   commits/files that prove it.`,
    `2. The intent is live but the plan is stale against the tree -> "revise".`,
    `3. The plan is live but embeds an open judgment call Tom has not made -`,
    `   ALL tier-C entries land here by definition -> "session".`,
    `4. All clean -> "approve".`,
    ``,
    `Also classify execClass: "needs-turing" if executing the plan requires the`,
    `SLURM cluster / GPUs, else "box" (runnable on an ordinary Linux box).`,
    ``,
    JSON_ONLY_ANSWER,
    `{"brief": "...", "recommendation": "approve|revise|session|archive",`,
    ` "execClass": "needs-turing|box", "evidence": "..." (optional)}`,
    ``,
    `The entry:`,
    ``,
    entryYaml,
    ``,
    ...(replanNote !== null ? [
      `Tom ruled "revise" on this entry's existing brief and plan` +
        (replanNote ? ` with the sentence: ${replanNote}` : `.`),
      `His sentence overrides any other reading of the entry. Propose a`,
      `FRESH plan inside the brief, grounded in the current tree.`,
      ``,
    ] : []),
    ...(complaints.length > 0 ? refusalBlock(complaints) : []),
  ].join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes("--force");
  const env = loadEnv();
  const io = {
    runClaude,
    post: (path, body) => convexFetch(env, path, body),
  };

  // --- Gather context (one read each) ----------------------------------------
  const context = await convexFetch(env, "/tts/batch-context");
  const { pending } = await convexFetch(env, "/tts/rulings");

  // The writing standard is the published write + know prelude. It rides this
  // payload because this file is Node ESM on the Jarvis Box, which never
  // loads TypeScript and holds no WikiTom checkout. A run without it would
  // quietly produce prose written to no standard at all, which is worse than
  // not running — so it is fatal.
  if (typeof context.writingStandard !== "string" || context.writingStandard.trim() === "") {
    throw new Error("model-of-tom layer write is not stored");
  }
  // The New York calendar date, for resolving "sept 3" in a statement. The
  // server owns the clock (the /tts/state convention); the planner repeats it
  // back and never computes a day of its own.
  if (typeof context.nyCalendarDay !== "string") {
    throw new Error("/tts/batch-context returned no nyCalendarDay");
  }

  let failures = 0;

  // The DOOR CHECK's rules, loaded once for the prepare pass. A different
  // thing from context.writingStandard above, which is the prose the model is
  // given: this is the executable half, and an unreachable file is "no rules
  // ran" rather than a failure (loadStandardRules says why).
  const standard = await loadStandardRules();
  if (standard === null) {
    console.log(
      "[plan-graphs] check-writing-standard.mjs is not reachable — the door " +
        "check runs its shape checks only this run",
    );
  }

  // --- Pass 1: prepare ------------------------------------------------------
  // A failure inside the pass is per-item and counted; a failure of the pass
  // itself (the feed unreadable, say) is logged and fails the run.
  try {
    const result = await prepareLifeTodos(
      {
        todos: context.todos,
        pending,
        today: context.nyCalendarDay,
        writingStandard: context.writingStandard,
        standard,
        force,
      },
      io,
    );
    failures += result.failed;
  } catch (err) {
    failures++;
    console.error(`[plan-graphs] prepare pass FAILED: ${err.message}`);
  }

  if (failures > 0) process.exitCode = 1;
}

// Run ONLY when node was pointed at this file — the guard every job with
// tested pure halves carries, so a test that imports the passes above does
// not fire the job.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[plan-graphs] FAILED: ${err.message}`);
    process.exit(1);
  });
}
