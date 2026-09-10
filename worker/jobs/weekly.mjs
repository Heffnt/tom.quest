#!/usr/bin/env node
// weekly.mjs — the Friday job (the lifeos update, phase 8; spec §11). Runs at
// 4:00 a.m. New York on Fridays and does four things in order, each failure
// a "weekly-failure" dtsEvents row and the next step still run:
//
//   1. gather — GET /tts/weekly-input: every fact of the seven days ending
//      now, read deterministically on indexes (convex/ttsWeekly.ts). Then the
//      one fact that lives in the WikiTom checkout: last week's agenda file
//      under tts/weekly/ and its Outcome section. The first week has none and
//      the agenda says so.
//   2. the one model call — Opus turns the facts into descriptive lines and
//      into every fork the facts support, each with its two sides, both
//      costs, and a recommendation, ordered by dependency. No caps: every
//      fork the facts support, and zero is a valid answer. Descriptive, never
//      evaluative; no score, no grade. A failed call still yields an agenda:
//      the facts rendered by this job, and no forks.
//   3. the file — tts/weekly/YYYY-MM-DD.md: facts first, then the
//      sustainability question verbatim, then the forks numbered, then an
//      empty Outcome section. Written, committed and pushed under the WikiTom
//      writer lock through the nightly job's helpers (withWikiTomLock,
//      commitTree, syncRemote — never a second copy). With the checkout
//      absent (the deploy key not yet on GitHub) the file is a failure row and
//      the session still opens with the agenda text.
//   4. the session — one session of kind "weekly" on the sessions page,
//      opened through POST /tts/session, whose opening prompt is the agenda
//      and whose instructions say what the session does with Tom: read the
//      facts, ask the question, take his rulings by number in his words,
//      review the area pages past their window, append the outcome.
//
// Then one "weekly-run" row with the summary, keyed on the day.
//
// ONE RUN PER DAY: a day whose agenda file is in the checkout or whose
// "weekly-run" row exists is refused before anything is written — the file
// may already carry the session's Outcome, and the session it opened is the
// weekly session. `--overwrite` rewrites the file (the Outcome with it) and
// keeps that session.
//
// THE JOB WRITES NOTHING TO A TODO. Its writes are the agenda file, the
// session row, and its own event rows. Tom's rulings are written by the
// session, through the ruling route, in his words.
//
// TWO PENS FOR THE SESSION, both under the same lock and helpers:
//   node /opt/tts/weekly.mjs reviewed model-of-tom/areas/<page>.md YYYY-MM-DD
//       sets `reviewed:` on the page Tom confirmed, commits and pushes, and
//       records the review through POST /tts/area-reviewed.
//   node /opt/tts/weekly.mjs outcome YYYY-MM-DD <file>
//       appends the file's text under the agenda's "## Outcome" heading,
//       commits and pushes.
//
// Cron fires the run at 08:00 AND 09:00 UTC on Fridays; the NY-hour guard
// keeps the one that is 4 a.m. New York. By hand:
//   node /opt/tts/weekly.mjs --force              (outside the 4 a.m. hour)
//   node /opt/tts/weekly.mjs --force --overwrite  (a day already run)
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). Never prints
// TTS_WORKER_KEY; the deploy key is a file the helpers use, never a string.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  convexFetch,
  extractJsonObject,
  loadEnv,
  nyHour,
  runClaude,
  JSON_ONLY_ANSWER,
} from "./tts-lib.mjs";
import {
  MODEL_OF_TOM_AREAS_DIR,
  WIKITOM_DIR,
  abortStaleRebase,
  commitTree,
  syncRemote,
  utcDay,
  withWikiTomLock,
} from "./nightly.mjs";
import { extractSections, isIsoDay, setFrontmatterField, withoutHeading } from "./markdown-sections.mjs";

// ── Names ────────────────────────────────────────────────────────────────────
export const WEEKLY_DIR = "tts/weekly";
export const SESSION_KIND = "weekly";
/** The Opus tier, by the name the claude CLI and the session model list use. */
export const WEEKLY_MODEL = "opus";
export const MODEL_TIMEOUT_MS = 15 * 60 * 1000;
/** The failure row's kind (convex/ttsWeekly.ts WEEKLY_FAILURE). */
export const WEEKLY_FAILURE = "weekly-failure";
export const WEEKLY_RUN = "weekly-run";

// The words the agenda carries, fixed. The question is Tom's own variable
// (spec §11.6b) and is asked in exactly these words every week.
export const SUSTAINABILITY_QUESTION = "did this week feel sustainable?";
export const NO_FORKS_LINE = "no forks this week";
export const FIRST_WEEK_LINE = "No prior agenda: this is the first week.";
export const CHECKOUT_ABSENT_LINE =
  "The WikiTom checkout was absent when this agenda was written, so last week's agenda could not be read and this one was not written to a file.";
export const OUTCOME_HEADING = "## Outcome";
export const TIMING_WORDS = ["on time", "late", "skipped"];
/** Spec §11: two consecutive misses put this at the top of the next agenda.
 * The rule is the job's, deterministic (cadenceLine), never the model's. */
export const CADENCE_LINE = "the cadence isn't working — change the system";

// ── Small pure helpers (tested in weekly.test.mjs) ───────────────────────────

export function agendaFileName(day) {
  return `${WEEKLY_DIR}/${day}.md`;
}

/** "1h 30m", "2d 3h", "45m", "under a minute". */
export function duration(ms) {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.floor(ms / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d${h > 0 ? ` ${h}h` : ""}`;
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
  return `${m}m`;
}

function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Every fact as one line each, deterministically, from the gather's answer.
 * This is what the model reads, and what the agenda carries when the model
 * call fails. Nothing is left out and nothing is graded: a count, a list, an
 * age, a duration.
 */
export function renderFactLines(facts) {
  const lines = [];
  lines.push(`Window: ${utcDay(facts.since)} to ${utcDay(facts.until)} (seven days).`);

  lines.push(`Completed: ${facts.completions.length}.`);
  for (const c of facts.completions) {
    const where = [c.kind, c.batch ? `batch "${c.batch}"` : null].filter(Boolean).join(", ");
    lines.push(`- ${c.statement} (${utcDay(c.doneAt)}${where ? `; ${where}` : ""}; id ${c.id})`);
  }

  const captured = facts.captures.reduce((n, c) => n + c.count, 0);
  lines.push(
    `Captured: ${captured}${captured > 0 ? ` — by source: ${facts.captures.map((c) => `${c.source} ${c.count}`).join(", ")}` : ""}.`,
  );
  for (const c of facts.captures) {
    for (const item of c.items) {
      lines.push(`- (${c.source}) ${item.statement} (${utcDay(item.createdAt)}; id ${item.id})`);
    }
  }

  const outcomes = { done: 0, renegotiated: 0, missed: 0 };
  for (const o of facts.dateOutcomes) outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1;
  lines.push(
    `Date outcomes: ${facts.dateOutcomes.length}${facts.dateOutcomes.length > 0 ? ` — done ${outcomes.done}, renegotiated ${outcomes.renegotiated}, missed ${outcomes.missed}` : ""}.`,
  );
  for (const o of facts.dateOutcomes) {
    const extra = [
      o.newDueAt !== null && o.outcome === "renegotiated" ? `new date ${utcDay(o.newDueAt)}` : null,
      o.note ? `note: ${o.note}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`- ${o.outcome}: ${o.statement} (${utcDay(o.at)}${extra ? `; ${extra}` : ""}; id ${o.todoId})`);
  }

  lines.push(`Surfaced three or more times and untouched: ${facts.surfacedUntouched.length}.`);
  for (const s of facts.surfacedUntouched) {
    lines.push(`- ${s.statement} (surfaced ${count(s.surfaced, "time")} since ${utcDay(s.firstAt)}; id ${s.id})`);
  }

  lines.push(`Goals with no open task in their batch: ${facts.goalsWithoutOpenTask.length}.`);
  for (const g of facts.goalsWithoutOpenTask) {
    lines.push(`- ${g.statement}${g.batch ? ` (batch "${g.batch}")` : ""} (id ${g.id})`);
  }

  lines.push(`Open goals no worker has evaluated in seven days: ${facts.goalsNotEvaluated.length}.`);
  for (const g of facts.goalsNotEvaluated) {
    lines.push(
      `- ${g.statement}${g.batch ? ` (batch "${g.batch}")` : ""} — last evaluated ${g.lastEvaluatedAt === null ? "never" : utcDay(g.lastEvaluatedAt)} (id ${g.id})`,
    );
  }

  lines.push(
    `Integrations: ${facts.integrations
      .map((i) => {
        if (i.state === "running") return `${i.name} running`;
        if (i.state === "waiting-on-credential") {
          return `${i.name} waiting on a credential since ${utcDay(i.since)}${i.detail ? ` (${i.detail})` : ""}`;
        }
        return `${i.name} declined on ${utcDay(i.since)}${i.detail ? ` ("${i.detail}")` : ""}`;
      })
      .join("; ")}.`,
  );

  lines.push(`Area pages: ${facts.areaPages.length}, past their window: ${facts.areaPages.filter((p) => p.pastWindow).length}.`);
  for (const p of facts.areaPages) {
    const name = p.path.slice(p.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const reviewed =
      p.reviewedOn === null
        ? "never reviewed"
        : `reviewed ${p.reviewedOn} (${count(p.reviewedAgeDays, "day")} ago)`;
    const window = p.windowDays === null ? "no window" : `window ${count(p.windowDays, "day")}`;
    lines.push(`- ${name}: ${reviewed}, ${window}${p.pastWindow ? " — past its window" : ""}`);
  }

  const m = facts.modelOfTom;
  const blockBytes = new Map(m.blocks.map((block) => [block.name, block.bytes]));
  const publishedBlocks = ["operate", "write", "know"]
    .map((name) => {
      const bytes = blockBytes.get(name);
      return bytes === undefined ? `${name} not published` : `${name} ${bytes} bytes`;
    })
    .join(", ");
  lines.push(
    `Model-of-tom published blocks: ${publishedBlocks}. Source files: ${count(m.files.length, "file")}, ${m.totalBytes} bytes in all${m.commit ? `, at WikiTom commit ${m.commit.slice(0, 12)}${m.syncedAt ? ` (${utcDay(m.syncedAt)})` : ""}` : ", no commit posted yet"}.`,
  );
  for (const f of m.files) lines.push(`- ${f.path}: ${f.bytes} bytes`);

  const l = facts.learning;
  lines.push(`Nightly learning: ${count(l.changes, "change")}, ${l.reverted} reverted, ${l.revertFailed} revert${l.revertFailed === 1 ? "" : "s"} failed.`);
  for (const line of l.lines) {
    const what =
      line.kind === "learning-change"
        ? `${line.file ?? "?"}: "${line.before ?? ""}" → "${line.after ?? ""}"${line.evidence ? ` (evidence: ${line.evidence})` : ""}`
        : line.kind === "learning-reverted"
          ? `reverted ${line.id ?? "?"}${line.file ? ` in ${line.file}` : ""}`
          : `revert of ${line.id ?? "?"} failed${line.error ? `: ${line.error}` : ""}`;
    lines.push(`- ${utcDay(line.at)} ${what}`);
  }

  lines.push(
    `Job failures: ${facts.jobFailures.length === 0 ? "none" : facts.jobFailures.map((j) => `${j.job} ${j.count}`).join(", ")}.`,
  );
  for (const j of facts.jobFailures) {
    for (const line of j.lines) lines.push(`- ${j.job} ${utcDay(line.at)}: ${line.error}`);
  }

  const replied = facts.threads.filter((t) => t.replyMs !== null);
  lines.push(
    `Threads that needed Tom: ${facts.threads.length}${facts.threads.length > 0 ? ` — replied ${replied.length}, unanswered ${facts.threads.length - replied.length}` : ""}.`,
  );
  for (const t of facts.threads) {
    lines.push(
      `- ${t.statement}: asked ${utcDay(t.askedAt)}, ${t.replyMs === null ? "no reply yet" : `replied after ${duration(t.replyMs)}`} (id ${t.todoId})`,
    );
  }

  lines.push(`Todos: ${facts.readiness.prepared} prepared, ${facts.readiness.unprepared} unprepared.`);
  return lines;
}

/**
 * Last week's agenda from the checkout: the newest tts/weekly/YYYY-MM-DD.md
 * before `today` and its Outcome section. `checkout: false` when the
 * directory is not a git checkout at all; `file: null` on the first week.
 * Today's own file — a rerun's — is never last week's, so it is skipped.
 * `recent` is the two newest agendas' timing words, newest first (null where
 * no outcome was recorded), for the consecutive-miss rule (cadenceLine).
 */
export function readPriorAgenda(dir, today = null) {
  const none = { file: null, day: null, outcome: null, recent: [] };
  if (!fs.existsSync(path.join(dir, ".git"))) return { checkout: false, ...none };
  const weekly = path.join(dir, WEEKLY_DIR);
  if (!fs.existsSync(weekly)) return { checkout: true, ...none };
  const names = fs
    .readdirSync(weekly)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .filter((n) => today === null || n.slice(0, "YYYY-MM-DD".length) < today)
    .sort()
    .reverse();
  if (names.length === 0) return { checkout: true, ...none };
  const outcomeOf = (name) => {
    const text = fs.readFileSync(path.join(weekly, name), "utf8");
    const section = extractSections(text, ["Outcome"]);
    const outcome = withoutHeading(section).trim();
    return outcome === "" ? null : outcome;
  };
  const dayOfName = (name) => name.slice(0, -".md".length);
  const outcome = outcomeOf(names[0]);
  const recent = names.slice(0, 2).map((name, i) => {
    const o = i === 0 ? outcome : outcomeOf(name);
    return { day: dayOfName(name), timing: o === null ? null : outcomeTimingOf(o) };
  });
  return {
    checkout: true,
    file: `${WEEKLY_DIR}/${names[0]}`,
    day: dayOfName(names[0]),
    outcome,
    recent,
  };
}

/**
 * THE CONSECUTIVE-MISS RULE (spec §11), decided here and nowhere else: when
 * the two newest agendas were both missed, the fixed line goes first in the
 * next agenda, before the facts. A miss is an outcome of "late" or
 * "skipped", or no outcome recorded at all — a session that never wrote its
 * record did not happen as far as the record knows. One prior agenda, or
 * either of the two on time, is no line. Returns the line, or null.
 */
export function cadenceLine(recent) {
  if (recent.length < 2) return null;
  const missed = (r) => r.timing === null || r.timing === "late" || r.timing === "skipped";
  if (!recent.slice(0, 2).every(missed)) return null;
  const said = recent
    .slice(0, 2)
    .map((r) => `${r.day} ${r.timing === null ? "no outcome recorded" : r.timing}`)
    .join(", ");
  return `${CADENCE_LINE} — the last two weekly sessions: ${said}.`;
}

/** The lines the agenda carries about last week. */
export function priorAgendaLines(prior) {
  if (!prior.checkout) return [CHECKOUT_ABSENT_LINE];
  if (prior.file === null) return [FIRST_WEEK_LINE];
  if (prior.outcome === null) {
    return [`Last week's agenda (${prior.file}): its Outcome section is empty — the session was not held, or its outcome was not written.`];
  }
  return [`Last week's agenda (${prior.file}), outcome:`, ...prior.outcome.split("\n").map((l) => `  ${l}`)];
}

/** The one prompt of the one model call. */
export function buildAgendaPrompt({ writingStandard, factLines, priorLines }) {
  return [
    writingStandard,
    "",
    "You are writing the agenda for Tom's weekly reflective session (TTS, Toms Todo System). Below are the facts of the last seven days, gathered deterministically from the record, and last week's agenda outcome. Nothing else is available to you and nothing else is needed.",
    "",
    "Write two things, as one JSON object and nothing else:",
    "",
    '1. "lines": the week - one string per line, plain sentences, each carrying its date or count from the facts. Every fact section below is represented; a fact with nothing in it is one line saying so.',
    "",
    '2. "forks": every fork the facts support — a real trade-off Tom has to rule on, where the record cannot decide for him: an item surfaced and never touched, a goal with no open task, a date missed twice, an integration waiting on him, a page past its window, a thread that waited days. (The cadence of these sessions is not yours to raise: the job puts a fixed line at the top of the agenda when two in a row were missed.) Each fork is an object: "title" (one line naming the fork), "subject" (null, or {"type": "life"|"batch", "id": "<the id from the facts>"} when the fork is about one todo or batch), "sides": exactly two objects each with "option" (what would be done) and "cost" (what that side gives up, from the facts), "recommendation" (one sentence naming which side and why, from the facts; Tom rules, this is only what you would pick). Order the forks by dependency: a fork whose answer changes another comes first. NO CAPS: write every fork the facts support and not one more; ZERO forks is a valid answer when the facts support none, and then "forks" is an empty array. A recommendation with no trade-off behind it is not a fork; do not manufacture one.',
    "",
    "Do not ask the sustainability question and do not answer it; the agenda asks it in fixed words after your lines.",
    "",
    JSON_ONLY_ANSWER,
    '{"lines": [...], "forks": [...]}',
    "",
    "THE FACTS:",
    ...factLines,
    "",
    "LAST WEEK:",
    ...priorLines,
  ].join("\n");
}

/**
 * The model's answer, checked: `lines` is a list of non-empty strings and
 * every fork has a title, exactly two sides each with an option and a cost,
 * and a recommendation. A malformed answer throws — the run then carries the
 * facts alone, which is better than an agenda with half a fork in it.
 */
export function parseAgendaAnswer(answerText) {
  const obj = extractJsonObject(answerText);
  if (!Array.isArray(obj.lines) || !obj.lines.every((l) => typeof l === "string" && l.trim() !== "")) {
    throw new Error("the model's answer has no `lines` array of non-empty strings");
  }
  if (!Array.isArray(obj.forks)) throw new Error("the model's answer has no `forks` array");
  const forks = obj.forks.map((f, i) => {
    const where = `fork ${i + 1}`;
    if (typeof f !== "object" || f === null) throw new Error(`${where} is not an object`);
    if (typeof f.title !== "string" || f.title.trim() === "") throw new Error(`${where} has no title`);
    if (!Array.isArray(f.sides) || f.sides.length !== 2) throw new Error(`${where} does not have exactly two sides`);
    const sides = f.sides.map((s, j) => {
      if (typeof s?.option !== "string" || s.option.trim() === "" || typeof s?.cost !== "string" || s.cost.trim() === "") {
        throw new Error(`${where}, side ${j + 1} needs an option and a cost`);
      }
      return { option: s.option.trim(), cost: s.cost.trim() };
    });
    if (typeof f.recommendation !== "string" || f.recommendation.trim() === "") {
      throw new Error(`${where} has no recommendation`);
    }
    let subject = null;
    if (f.subject !== null && f.subject !== undefined) {
      const s = f.subject;
      if ((s.type === "life" || s.type === "batch") && typeof s.id === "string" && s.id.trim() !== "") {
        subject = { type: s.type, id: s.id.trim() };
      }
    }
    return { title: f.title.trim(), subject, sides, recommendation: f.recommendation.trim() };
  });
  return { lines: obj.lines.map((l) => l.trim()), forks };
}

/**
 * The agenda file: the cadence line when the rule fires, then the facts,
 * then the question verbatim, then the forks numbered (or the one line
 * saying there are none), then an empty Outcome section for the session to
 * fill. Pure.
 */
export function renderAgenda({ day, lines, priorLines, forks, modelError = null, recent = [] }) {
  const out = [`# Weekly agenda — ${day}`, ""];
  // The consecutive-miss rule's line, first, before anything else.
  const cadence = cadenceLine(recent);
  if (cadence !== null) out.push(`**${cadence}**`, "");
  out.push("## Facts", "");
  if (modelError !== null) {
    out.push(`(the model call failed — ${modelError} — so these are the gathered facts as the job rendered them, and no forks were written)`, "");
  }
  for (const l of lines) out.push(`- ${l}`);
  out.push("", "## Last week", "");
  for (const l of priorLines) out.push(l.startsWith("  ") ? l : `- ${l}`);
  out.push("", "## The question", "", SUSTAINABILITY_QUESTION, "", "## Forks", "");
  if (forks.length === 0) {
    out.push(NO_FORKS_LINE);
  } else {
    forks.forEach((f, i) => {
      out.push(`${i + 1}. ${f.title}${f.subject ? ` (${f.subject.type} ${f.subject.id})` : ""}`);
      out.push(`   - A: ${f.sides[0].option} — cost: ${f.sides[0].cost}`);
      out.push(`   - B: ${f.sides[1].option} — cost: ${f.sides[1].cost}`);
      out.push(`   - recommendation: ${f.recommendation}`);
      if (i < forks.length - 1) out.push("");
    });
  }
  out.push("", OUTCOME_HEADING, "");
  return out.join("\n");
}

/** The todo and batch ids the forks name, each once, in agenda order — what
 * POST /tts/session stores on the session row as the subjects its turns may
 * rule on. */
export function agendaSubjects(forks) {
  return [...new Set(forks.filter((f) => f.subject !== null).map((f) => f.subject.id))];
}

/** The agenda with `text` under its Outcome heading (appended after whatever
 * is already there, so a second write never erases the first). */
export function appendOutcome(markdown, text) {
  const at = markdown.indexOf(`\n${OUTCOME_HEADING}`);
  const body = text.trim();
  if (at === -1) return `${markdown.trimEnd()}\n\n${OUTCOME_HEADING}\n\n${body}\n`;
  return `${markdown.trimEnd()}\n\n${body}\n`;
}

/** The outcome text the session writes: its first line names the timing. */
export function outcomeTimingOf(text) {
  const first = String(text ?? "").split("\n")[0]?.trim().toLowerCase() ?? "";
  const m = /^timing:\s*(.+)$/.exec(first);
  if (!m) return null;
  const word = m[1].trim();
  return TIMING_WORDS.includes(word) ? word : null;
}

/** The session's opening prompt: the agenda, then what the session does. */
export function sessionPrompt({ day, agenda, file, checkout }) {
  const where = checkout
    ? `It is the file ${file} in the WikiTom checkout on this box (${WIKITOM_DIR}), committed and pushed.`
    : "The WikiTom checkout was absent when the job ran, so the agenda exists only in this prompt (a weekly-failure row records it).";
  return [
    `This is the weekly session for the week ending ${day} (WikiTom tts/spec.md section 11). The agenda below was written by the Friday job from the week's record — one deterministic gather, one model call. ${where}`,
    "",
    "Do these, in order, with Tom:",
    "",
    `0. If the agenda opens with "${CADENCE_LINE}", take that up first: the last two weekly sessions were missed, and what is to be decided is what to change so the next one happens — the day, the hour, the length, the form. His answer goes into the outcome (step 5) in his words.`,
    "1. Read the facts with him, as they are.",
    `2. Ask him, in exactly these words: "${SUSTAINABILITY_QUESTION}" Keep his answer verbatim; it is the primary variable and goes into the outcome as he said it.`,
    `3. Go through the forks by number. Take his ruling on each in his own words. A fork that names a subject (a todo or a batch, by id) is ruled through the ruling route the moment he says it: curl -s -X POST "$CONVEX_SITE_URL/tts/ruling" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"inboundId": "<the id after \\"inbound row:\\" at the end of the turn he said it in>", "verdict": "<approve|revise|session|archive>", "subjectType": "<life|batch>", "subjectId": "<the id the fork names>", "quote": "<one whole sentence of that turn, copied exactly>", "sentence": "<on revise only: the one sentence of that turn that redirects the preparing agent, copied exactly; omit on every other verdict>"}' — this session may rule only on the subjects the forks name (the ruling route refuses any other id), and the morning digest quotes every ruling written this way. If his words leave the verdict unclear, do not guess; ask. A fork with no subject is a ruling about the system, recorded in the outcome (step 5) in his words. Zero forks is a real answer: then there is nothing to rule on.`,
    `4. The area pages past their window are named under the facts. For each, read ${WIKITOM_DIR}/${MODEL_OF_TOM_AREAS_DIR}/<page>.md with him. When he confirms a page, run: node /opt/tts/weekly.mjs reviewed ${MODEL_OF_TOM_AREAS_DIR}/<page>.md <today, YYYY-MM-DD> — it sets reviewed: on that page, commits and pushes under the WikiTom writer lock, and records the review. Never run it for a page he did not confirm, and never edit a page's Ideal state or Must not break lines.`,
    `5. At the end, write the outcome to a file and run: node /opt/tts/weekly.mjs outcome ${day} <that file>. The file's first line is one of "timing: on time" (the session held by Sunday), "timing: late", or "timing: skipped"; then "sustainable: <his answer, verbatim>"; then "rulings:" and one line per fork, "<number>. <his ruling, in his words>". The command appends the text under the agenda's Outcome heading, commits and pushes. Next Friday's agenda reads it.`,
    "",
    "This session writes to a todo's record only through the ruling route, and never records a ruling Tom did not state.",
    "",
    "---",
    "",
    agenda,
  ].join("\n");
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * The run's doors — Convex, the model, the checkout's lock and git, the
 * clock — as one object, so the job can be run whole against fakes
 * (weekly.test.mjs) and never reads a global on its own. Everything above
 * this line is pure.
 */
export const REAL_IO = {
  fetch: convexFetch,
  model: runClaude,
  lock: withWikiTomLock,
  abortStaleRebase,
  commit: commitTree,
  sync: syncRemote,
  now: () => Date.now(),
};

async function recordFailure(run, step, err) {
  const error = String(err?.message ?? err).slice(0, 2000);
  console.error(`[weekly] ${step} FAILED: ${error}`);
  run.failures.push({ step, error });
  try {
    await run.io.fetch(run.env, "/tts/event", {
      kind: WEEKLY_FAILURE,
      data: { day: run.day, step, error },
    });
  } catch (postErr) {
    console.error(`[weekly] could not record the ${step} failure: ${postErr.message}`);
  }
}

/**
 * THE ONE WAY THIS FILE WRITES TO THE CHECKOUT: under the WikiTom writer
 * lock, a stale rebase aborted ONCE and before the write (the abort resets the
 * work tree hard, so it must not come after; commitTree is told not to repeat
 * it), then `write()`, then one commit of `paths` and a pull-rebase-push, all
 * through the nightly job's own helpers. The agenda, the reviewed pen and the
 * outcome pen all come here.
 */
async function commitUnderLock(io, dir, { write, paths, message, day }) {
  return await io.lock(async () => {
    const failures = io.abortStaleRebase(dir);
    write();
    const committed = io.commit(dir, [{ paths, message }], day, { guardRebase: false });
    const sync = io.sync(dir);
    return {
      made: committed.made,
      pulled: sync.pulled,
      pushed: sync.pushed,
      failures: [...failures, ...committed.failures, ...sync.failures],
    };
  });
}

/** Write, commit and push the agenda under the writer lock. */
async function writeAgendaFile(io, dir, day, agenda) {
  const rel = agendaFileName(day);
  const abs = path.join(dir, rel);
  const result = await commitUnderLock(io, dir, {
    write: () => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `${agenda.trimEnd()}\n`);
    },
    paths: [WEEKLY_DIR],
    message: `weekly: ${day} — the agenda`,
    day,
  });
  return { rel, ...result };
}

/**
 * The whole job, returning its record: { day, file, sessionId, failures,
 * refused }. `null` when the NY-hour guard skipped this cron slot. Sets no
 * exit code itself — main() reads the record.
 *
 * ONE RUN PER DAY. A day that already has its agenda file in the checkout or
 * its "weekly-run" row in Convex is not run again: the file may carry the
 * session's Outcome by then, and the session it opened is the weekly
 * session. `overwrite` (the --overwrite flag, by hand) rewrites the file —
 * an appended Outcome with it — and keeps the session the first run opened.
 */
export async function runWeekly({ force = false, overwrite = false, env = null, dir = WIKITOM_DIR, io = REAL_IO } = {}) {
  const now = io.now();
  if (!force && nyHour(now) !== 4) {
    console.log(`[weekly] NY hour is ${nyHour(now)}, not 4 — this is the off-season cron slot, exiting (use --force to override)`);
    return null;
  }
  const run = { env: env ?? loadEnv(), io, now, day: utcDay(now), dir, failures: [], results: {} };

  // 0. has this day been run? Nothing is written before this is known.
  const existing = { file: fs.existsSync(path.join(run.dir, agendaFileName(run.day))), run: null };
  try {
    existing.run = (await io.fetch(run.env, `/tts/weekly-run?day=${run.day}`)).run;
  } catch (err) {
    await recordFailure(run, "run-check", err);
  }
  if ((existing.file || existing.run !== null) && !overwrite) {
    const what = [
      existing.file ? `the agenda file ${agendaFileName(run.day)} is in the checkout` : null,
      existing.run !== null ? `a weekly-run row for ${run.day} names ${existing.run.sessionId ? `session ${existing.run.sessionId}` : "no session"}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const refused = `${run.day} was already run: ${what}. Nothing written; rerun with --overwrite to rewrite the agenda (the session the first run opened stays).`;
    console.log(`[weekly] refused: ${refused}`);
    return { day: run.day, file: null, sessionId: existing.run?.sessionId ?? null, failures: run.failures, refused };
  }
  if (existing.file || existing.run !== null) {
    console.log(`[weekly] --overwrite: rewriting ${run.day} (an Outcome already appended to the file is lost with it)`);
  }

  // 1. gather
  let facts = null;
  try {
    facts = await io.fetch(run.env, `/tts/weekly-input?until=${now}`);
    if (typeof facts.writingStandard !== "string" || facts.writingStandard.trim() === "") {
      throw new Error("model-of-tom block write is not stored");
    }
  } catch (err) {
    await recordFailure(run, "gather", err);
  }
  const prior = readPriorAgenda(run.dir, run.day);
  if (!prior.checkout) {
    await recordFailure(run, "checkout", new Error(`${run.dir} is not a git checkout — setup.sh clones WikiTom there; the agenda was not written to a file`));
  }
  const priorLines = priorAgendaLines(prior);
  const factLines = facts === null ? ["The gather failed; no facts were read this week (see the job failures)."] : renderFactLines(facts);

  // 2. the one model call
  let lines = factLines;
  let forks = [];
  let modelError = null;
  if (facts !== null) {
    try {
      const answer = io.model(buildAgendaPrompt({ writingStandard: facts.writingStandard, factLines, priorLines }), {
        model: WEEKLY_MODEL,
        timeoutMs: MODEL_TIMEOUT_MS,
        cwd: os.tmpdir(),
      });
      ({ lines, forks } = parseAgendaAnswer(answer));
    } catch (err) {
      modelError = String(err?.message ?? err).slice(0, 500);
      await recordFailure(run, "model", err);
      lines = factLines;
      forks = [];
    }
  } else {
    modelError = "the gather failed, so there was nothing to give the model";
  }
  const agenda = renderAgenda({ day: run.day, lines, priorLines, forks, modelError, recent: prior.recent });
  console.log(`[weekly] agenda: ${lines.length} line(s), ${forks.length} fork(s)${modelError ? " (model call failed)" : ""}`);

  // 3. the file, under the lock
  let file = null;
  if (prior.checkout) {
    try {
      const result = await writeAgendaFile(io, run.dir, run.day, agenda);
      for (const f of result.failures) await recordFailure(run, f.step, new Error(f.error));
      file = result.rel;
      run.results.file = result;
      console.log(`[weekly] file: ${result.rel}, ${result.made.length} commit(s), pull ${result.pulled ? "ok" : "FAILED"}, push ${result.pushed ? "ok" : "not done — the commit stays local"}`);
    } catch (err) {
      await recordFailure(run, "file", err);
    }
  }

  // 4. the session — one per day (POST /tts/session refuses a second): an
  // --overwrite rerun keeps the one the first run opened. The forks' subject
  // ids ride on the row: the session's turns rule on those and nothing else
  // (convex/ttsRulings.ts).
  if (existing.run?.sessionId) {
    run.results.sessionId = existing.run.sessionId;
    console.log(`[weekly] session ${existing.run.sessionId} was opened by the earlier run for ${run.day} and stays; the agenda file is rewritten under it`);
  } else {
    try {
      const res = await io.fetch(run.env, "/tts/session", {
        title: `Weekly ${run.day}`,
        kind: SESSION_KIND,
        day: run.day,
        agendaSubjects: agendaSubjects(forks),
        repos: [],
        model: WEEKLY_MODEL,
        initialPrompt: sessionPrompt({ day: run.day, agenda, file, checkout: file !== null }),
      });
      run.results.sessionId = res.sessionId;
      console.log(`[weekly] session opened: ${res.sessionId}`);
    } catch (err) {
      await recordFailure(run, "session", err);
    }
  }

  try {
    await io.fetch(run.env, "/tts/event", {
      kind: WEEKLY_RUN,
      key: run.day,
      data: {
        day: run.day,
        file,
        pushed: run.results.file?.pushed ?? false,
        sessionId: run.results.sessionId ?? null,
        lines: lines.length,
        forks: forks.length,
        firstWeek: prior.checkout && prior.file === null,
        failures: run.failures,
      },
    });
  } catch (err) {
    console.error(`[weekly] could not record the run summary: ${err.message}`);
  }
  console.log(`[weekly] done: ${run.failures.length} failure(s)`);
  return { day: run.day, file, sessionId: run.results.sessionId ?? null, failures: run.failures, refused: null };
}

// ── The session's two pens ───────────────────────────────────────────────────

export function isAreaPagePath(p) {
  return typeof p === "string" && new RegExp(`^${MODEL_OF_TOM_AREAS_DIR}/[A-Za-z0-9._-]+\\.md$`).test(p) && !p.includes("..");
}

export function isDay(s) {
  return isIsoDay(s);
}

/**
 * `reviewed <path> <day>`: the one edit the session makes to a page — its
 * `reviewed:` line, set only after Tom confirmed the page — committed and
 * pushed under the writer lock, then recorded through POST /tts/area-reviewed
 * so the digest can say it and the gather can count it before the nightly
 * post carries the edited frontmatter to Convex.
 */
async function reviewedPen(env, dir, pagePath, on, io = REAL_IO) {
  if (!isAreaPagePath(pagePath)) throw new Error(`not an area page path: ${pagePath} (expected ${MODEL_OF_TOM_AREAS_DIR}/<page>.md)`);
  if (!isDay(on)) throw new Error(`not a YYYY-MM-DD date: ${on}`);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is not a git checkout`);
  const abs = path.join(dir, pagePath);
  if (!fs.existsSync(abs)) throw new Error(`no such page in the checkout: ${pagePath}`);
  const result = await commitUnderLock(io, dir, {
    write: () => fs.writeFileSync(abs, setFrontmatterField(fs.readFileSync(abs, "utf8"), "reviewed", on)),
    paths: [pagePath],
    message: `areas: ${path.basename(pagePath, ".md")} reviewed ${on} (weekly session)`,
    day: on,
  });
  const recorded = await io.fetch(env, "/tts/area-reviewed", { path: pagePath, reviewedOn: on });
  console.log(
    `[weekly] ${pagePath}: reviewed: ${on} set, ${result.made.length} commit(s), push ${result.pushed ? "ok" : "not done — the commit stays local for the nightly push"}, recorded ${recorded.id}`,
  );
  for (const f of result.failures) console.error(`[weekly] ${f.step}: ${f.error}`);
  if (result.failures.length > 0) process.exitCode = 1;
}

/** `outcome <day> <file>`: the session's record of how the week went. */
async function outcomePen(dir, day, textFile, io = REAL_IO) {
  if (!isDay(day)) throw new Error(`not a YYYY-MM-DD date: ${day}`);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is not a git checkout`);
  const text = fs.readFileSync(textFile, "utf8");
  if (outcomeTimingOf(text) === null) {
    throw new Error(`the outcome's first line must be "timing: ${TIMING_WORDS.join('" | "timing: ')}"`);
  }
  const rel = agendaFileName(day);
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) throw new Error(`no agenda file at ${rel}`);
  const result = await commitUnderLock(io, dir, {
    write: () => fs.writeFileSync(abs, appendOutcome(fs.readFileSync(abs, "utf8"), text)),
    paths: [rel],
    message: `weekly: ${day} — the outcome (${outcomeTimingOf(text)})`,
    day,
  });
  console.log(`[weekly] ${rel}: outcome appended, ${result.made.length} commit(s), push ${result.pushed ? "ok" : "not done — the commit stays local for the nightly push"}`);
  for (const f of result.failures) console.error(`[weekly] ${f.step}: ${f.error}`);
  if (result.failures.length > 0) process.exitCode = 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "reviewed") {
    await reviewedPen(loadEnv(), WIKITOM_DIR, argv[1], argv[2]);
    return;
  }
  if (argv[0] === "outcome") {
    await outcomePen(WIKITOM_DIR, argv[1], argv[2]);
    return;
  }
  const result = await runWeekly({ force: argv.includes("--force"), overwrite: argv.includes("--overwrite") });
  if (result !== null && (result.failures.length > 0 || result.refused !== null)) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[weekly] FAILED: ${err.message}`);
    process.exit(1);
  });
}
