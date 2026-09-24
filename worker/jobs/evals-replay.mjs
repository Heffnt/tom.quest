// evals-replay.mjs — the input an `explanation` golden item was written from,
// read back out of WikiTom's session archive.
//
// THE FAULT THIS FIXES. The 27 mined explanations carry an `input` of one topic
// and two context lines (scripts/import-explanation-golden.mjs), and the job
// that replays them is one model call with no tools (worker/jobs/evals.mjs
// JOBS.explanation.opts). The original agent had a whole working session. So
// the regeneration answered "I don't have the context" and the judge failed it
// at base and at head alike — 21 of 27 on the run recorded at 129370b
// (2026-09-22) — which is not a measurement of anything. An item that fails
// identically whatever the tree under test says is not scoring the tree.
//
// WHAT THE INPUT ACTUALLY IS. Everything in the session up to and including
// Tom's request: his turns, the agent's prose, the tools it called and what
// they returned. Not a summary of it and not the last few turns of it — the
// explanations rest on documents read four hundred turns earlier
// (explanation-n2's two handoffs are its whole subject), so a window would
// produce a prompt no run ever saw and score the model on the gap.
//
// WHAT IS NOT THE INPUT: anything the agent said or did AFTER the request. That
// is the output under test, the explanation itself among it, and
// `sessionInput` stops at the request for exactly that reason.
//
// THE THRESHOLD IS NOT A TRIM. An item either carries the WHOLE of its
// recoverable input or it is `unreplayable` — there is no middle where a prompt
// is silently cut and scored as though it were faithful. Measured across the 27
// items the input runs from 206 characters to 1,459,521, so the threshold
// decides real cases and the file says which side each fell on.
//
// THE ARCHIVE IS PRIVATE AND STAYS PRIVATE. WikiTom holds the transcripts and
// excludes them from its own default clone; tom.quest is public. So no
// conversation is copied into a golden item — the item keeps the pointer it
// already had in `provenance.session`, and the text is read at run time out of
// the WikiTom tree the run pins. That is the arrangement evals/triggers'
// AREA_TRIGGER_FILES already use for the private area fixtures, and it is the
// only one that puts a faithful prompt in front of the model without putting
// Tom's research sessions in a public repository.
//
// Plain Node ESM, ZERO npm dependencies — tts-lib.mjs's rule; this file lands
// in /opt/tts/ with the rest through worker/setup.sh.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Where the archive puts one Claude session (WikiTom sessions/README.md). */
export const SESSIONS_DIR = "sessions";

/**
 * The most input one replay prompt may carry, in characters.
 *
 * DERIVED FROM THE REGENERATION MODEL'S CONTEXT, not chosen to admit a
 * particular set of items. That model takes 200,000 tokens. Tool results are
 * code and JSON, which tokenize nearer three characters to the token than four,
 * so 200,000 tokens is about 600,000 characters of this material. The prelude
 * the job is also given measures 30,760 characters (write and know, at
 * 8fef4d1), the instruction is a few hundred, and the longest answer in the set
 * is 8,051 — so 100,000 characters of reserve is several times what those three
 * need, and what is left is the number below.
 *
 * RAISING IT IS A REAL CHOICE AND NOT A FREE ONE: every item it admits is one
 * more large call per run per side. Six items sit above it (from 717,643 to
 * 1,459,521 characters) and no reserve makes those fit.
 */
const REPLAY_MAX_CHARS = 500_000;

/** The `provenance.session` string an imported explanation carries: a project
 *  path, a transcript filename holding the session id, and the 1-based line of
 *  TOM'S REACTION within it. The id and the line are the whole of what is read;
 *  the laptop path in front of them names a machine that is not this one. */
export function sessionRefOf(item) {
  const text = item?.provenance?.session;
  if (typeof text !== "string" || text.trim() === "") return null;
  const session = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text)?.[1] ?? null;
  const line = Number(/line (\d+)/.exec(text)?.[1] ?? NaN);
  if (session === null || !Number.isInteger(line) || line < 2) return null;
  return { session: session.toLowerCase(), line };
}

/**
 * The archive directory of one session, or null.
 *
 * SCANNED, NEVER COMPUTED FROM THE ITEM'S DATE. The archive files a session
 * under the day it STARTED and an item is dated by the day Tom reacted, and the
 * two differ whenever a session runs past midnight — explanation-n1 is dated
 * 2026-08-17 and its transcript is under 2026/08/16. A path built from the
 * item's date would miss those silently, which reads as "the archive does not
 * hold it" and marks a repairable item unreplayable.
 */
export function sessionArchiveDir(wikitomTree, session) {
  const root = path.join(wikitomTree, SESSIONS_DIR);
  if (!fs.existsSync(root)) return null;
  const name = `claude-${session}`;
  for (const year of fs.readdirSync(root).filter((entry) => /^\d{4}$/.test(entry)).sort()) {
    const months = path.join(root, year);
    if (!fs.statSync(months).isDirectory()) continue;
    for (const month of fs.readdirSync(months).sort()) {
      const days = path.join(months, month);
      if (!fs.statSync(days).isDirectory()) continue;
      for (const day of fs.readdirSync(days).sort()) {
        const dir = path.join(days, day, name);
        if (fs.existsSync(dir)) return dir;
      }
    }
  }
  return null;
}

/** One session's transcript as parsed entries, unparseable lines as null so
 *  the 1-based line numbers an item cites stay the index into this array. */
function readTranscript(dir) {
  const file = path.join(dir, "session.jsonl.gz");
  if (!fs.existsSync(file)) return null;
  return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").split("\n").map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
}

/** A transcript entry Tom typed. `origin.kind === "human"` is what the recorder
 *  stamps on his own turns; a tool result is also a `user` entry and carries an
 *  array rather than a string, so the shape is checked too. */
function isTomTurn(entry) {
  return entry?.type === "user" && entry?.isSidechain !== true &&
    entry?.origin?.kind === "human" && typeof entry?.message?.content === "string";
}

/** A tool result's text, whichever of the two shapes the recorder wrote. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
}

/**
 * The 0-based index of the request one explanation answered: the last thing Tom
 * typed before his reaction. -1 when the transcript holds none.
 */
export function requestIndex(entries, reactionLine) {
  if (!Array.isArray(entries)) return -1;
  for (let index = reactionLine - 2; index >= 0; index -= 1) {
    if (isTomTurn(entries[index])) return index;
  }
  return -1;
}

/**
 * The tools the agent called AFTER the request and before the reaction.
 *
 * These are the line between an item the archive can repair and one it cannot.
 * An explanation written after the agent read four files rests on four files
 * the replay has no way to be handed: they are not in the session before the
 * request, and the job has no tools to fetch them with. Their NAMES are what
 * the unreplayable reason quotes, because "it read something" and "it read the
 * repository twenty-five times" are different facts about the same item.
 *
 * SIDECHAINS ARE NOT COUNTED SEPARATELY. A subagent's own transcript is its
 * working, and what the parent saw of it came back as one tool result here.
 */
export function toolsAfterRequest(entries, requestAt, reactionLine) {
  const names = [];
  for (let index = requestAt + 1; index <= reactionLine - 2; index += 1) {
    const entry = entries[index];
    if (entry === null || entry === undefined || entry.isSidechain === true) continue;
    if (entry.type !== "assistant") continue;
    for (const part of entry.message?.content ?? []) {
      if (part?.type === "tool_use" && typeof part.name === "string") names.push(part.name);
    }
  }
  return names;
}

/**
 * The session up to and including the request, rendered as the prompt carries
 * it: Tom named, the agent as "You" — because the run being asked to write is
 * standing where that agent stood — and each tool call beside what it returned.
 *
 * THINKING IS LEFT OUT. It is the old run's reasoning, not an input, and a
 * fresh run handed it would be completing a thought rather than having one.
 *
 * SIDECHAINS ARE LEFT OUT for the same reason: a subagent's transcript is its
 * own working, and the only part of it the parent ever saw is the tool result
 * that came back, which is carried.
 */
export function renderSession(entries, requestAt) {
  const lines = [];
  for (let index = 0; index <= requestAt; index += 1) {
    const entry = entries[index];
    if (entry === null || entry === undefined || entry.isSidechain === true) continue;
    if (isTomTurn(entry)) {
      lines.push("Tom:", entry.message.content, "");
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        lines.push("You:", part.text.trim(), "");
      } else if (part?.type === "tool_use") {
        lines.push(`You used ${part.name}:`, JSON.stringify(part.input ?? {}), "");
      } else if (part?.type === "tool_result") {
        const text = resultText(part.content).trim();
        lines.push("It returned:", text === "" ? "(nothing)" : text, "");
      }
    }
  }
  return lines;
}

/** The reasons an item cannot be replayed from the archive, in one place so the
 *  authoring script and the runner say the same words. */
export const REPLAY_NO_REF = "the item cites no session transcript to replay from";
export const REPLAY_NO_SESSION = "the session transcript is not in WikiTom's archive";
export const REPLAY_NO_REQUEST = "the transcript holds no request before the reaction";

function toolReason(tools, calls) {
  return `the explanation rests on ${calls} tool call${calls === 1 ? "" : "s"} the agent made after ` +
    `Tom's request (${tools.join(", ")}), which the replay cannot be handed: they are not in the ` +
    `session before the request and the explanation job has no tools`;
}

function sizeReason(chars, max) {
  return `the session before Tom's request is ${chars.toLocaleString("en-US")} characters, over the ` +
    `${max.toLocaleString("en-US")} one prompt carries, so no replay can hold the whole of what the agent had`;
}

/**
 * One item's replay input out of a WikiTom tree.
 *
 * `{ lines, chars, requestLine }` when the archive holds the whole of it,
 * `{ unreplayable: <reason> }` when it does not. It is never a throw and never
 * a failed item: an archive this box cannot read is a fact about the box, and
 * scoring it as a regression would fail a merge over it.
 *
 * A FRESH ITEM IS TRIAGED HERE TOO. The static `unreplayable` in an item file
 * is what the runner skips on, and it is derived from this function by
 * scripts/triage-explanation-golden.mjs. This one still refuses an item whose
 * file does not carry the mark — one imported since the last triage, or one
 * whose transcript has grown — so a set that has drifted from its triage costs
 * a skip rather than a false measurement.
 */
export function replayContext(wikitomTree, item, { maxChars = REPLAY_MAX_CHARS } = {}) {
  const ref = sessionRefOf(item);
  if (ref === null) return { unreplayable: REPLAY_NO_REF };
  const dir = sessionArchiveDir(wikitomTree, ref.session);
  if (dir === null) return { unreplayable: REPLAY_NO_SESSION };
  const entries = readTranscript(dir);
  if (entries === null) return { unreplayable: REPLAY_NO_SESSION };
  const requestAt = requestIndex(entries, ref.line);
  if (requestAt === -1) return { unreplayable: REPLAY_NO_REQUEST };
  const after = toolsAfterRequest(entries, requestAt, ref.line);
  if (after.length > 0) return { unreplayable: toolReason([...new Set(after)].sort(), after.length) };
  const lines = renderSession(entries, requestAt);
  const chars = lines.reduce((total, line) => total + line.length + 1, 0);
  if (chars > maxChars) return { unreplayable: sizeReason(chars, maxChars) };
  // THE LABEL SENTENCE MUST NOT REACH THE PROMPT. runItem enforces that at run
  // time by FAILING the item (worker/jobs/evals.mjs), which would turn a
  // transcript quirk — Tom repeating himself, the agent quoting him back — into
  // a regression. An item whose own input carries it is refused here instead,
  // and the runtime guard stays as the backstop it is.
  const sentence = typeof item?.sentence === "string" ? item.sentence.trim() : "";
  if (sentence !== "" && lines.some((line) => line.includes(sentence))) {
    return { unreplayable: "the session before the request already carries the sentence the item is labelled by" };
  }
  return { lines, chars, requestLine: requestAt + 1 };
}
