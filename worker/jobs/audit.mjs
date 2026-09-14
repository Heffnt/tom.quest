// THE AUDIT STEP — the merge gate's second check (Tom, 2026-09-09).
//
// Merging is mechanical when three things hold for the exact commit being
// merged: the tests are green, an AUDIT APPROVED IT, and the evals found no
// regression. The first is CI's own result and the third is the evals runner's;
// this file is the second. It runs a different model family over the diff —
// Codex by default, because a second opinion from the family that did not
// write the code is the point — and posts the answer to POST /tts/audit, where
// convex/ttsMerge.ts reads the one `VERDICT:` line out of it.
//
// At Codex's weekly cap the SAME prompt goes to Claude Opus instead, Tom's
// standing fallback for a capped box run, and the row says it did: see THE
// CODEX CAP below.
//
// THE VERDICT IS ONE LINE, ALONE ON ITS LINE, and everything else in the answer
// is prose for whoever reads the row later. `VERDICT: APPROVED` opens the gate;
// any other word does not, and is recorded as what it said — an audit that
// refused and an audit that never ran are different facts, and the gate's deny
// message says which it found.
//
// AN AUDIT THAT APPROVES WHAT IT DID NOT READ IS NOT A SECOND OPINION (phase 9,
// 2026-09-12). The first version of this file handed the auditor ONE prompt
// holding the first 200,000 characters of the diff and a sentence saying it had
// been cut. On 2026-09-11 the Opus auditor approved a ~30,000-line integration
// diff having read a slice of it, and the row recorded NOTHING ABOUT HOW MUCH
// IT SAW — the gate opened on a reading whose size nobody could reconstruct
// afterwards. Three things changed, and they are the shape of the rest of this
// file:
//
//   THE DIFF IS CHUNKED ON FILE BOUNDARIES (chunkDiff), one prompt per chunk,
//   and the verdicts are merged any-REFUSED-wins (mergeChunkVerdicts).
//
//   WHAT WAS READ IS RECORDED (`chunks` on the post): how many chunks, how many
//   answered, how many characters of how many. The gate does not read it. It is
//   a record, so the next reader can tell an audit of the whole change from an
//   audit of its first fifth.
//
//   THE AUDIT'S OWN CLAIMS ARE CHECKED AGAINST ITS OWN RUN (traceFindingsOf),
//   and the findings ride the row beside the removal check's — never the gate.
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). Installed to
// /opt/tts by worker/setup.sh; the command an agent types is
// worker/bin/tts-audit.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, convexFetch, loadEnv, runClaude } from "./tts-lib.mjs";

/** The wrapper every Codex door on the box goes through (AGENTS.md: one home
 *  for the flags and the stdout contract). */
export const AUDIT_RUNNER = process.env.TTS_CODEX_BIN || "/usr/local/bin/tts-codex";

/** Read-only, always: an audit that can edit the tree it is judging is not an
 *  audit. The effort is the wrapper's default (the fleet's strongest). */
export const AUDIT_SANDBOX = "read-only";

// ── HOW MUCH DIFF ONE AUDITOR IS GIVEN ───────────────────────────────────────
//
// There used to be one number here, AUDIT_DIFF_MAX_CHARS = 200_000, and one
// slice of the diff taken off the front of it. It is GONE rather than kept
// beside these two: the whole-diff cut had exactly one job, bounding a prompt,
// and chunking does that job for every chunk — a second ceiling above the
// chunker could only ever disagree with it, and the disagreement would be
// silent. (The operate rule asks what a new constant patches that cannot be
// deleted instead; here the answer was "nothing", so it was deleted.)

/** How much diff ONE prompt carries. A chunk is a whole number of files, so
 *  this is a ceiling the packer stops under rather than a place it cuts. */
export const AUDIT_CHUNK_MAX_CHARS = 120_000;

/** How many prompts one commit is worth. Beyond this the LAST chunk carries
 *  the remainder cut and the coverage record says so — NEVER a refusal. A gate
 *  that refused on size would stop a merge on a number nobody ruled, and the
 *  number is this line, chosen here, not by Tom.
 *
 *  MEASURED, and the measurement does not say what the design note said. Twelve
 *  chunks hold at most 1,440,000 characters. The real diff of PR #171
 *  (`git diff 1ea8d52..f5c1fb9`) is 1,519,624 BYTES — 1,505,354 characters,
 *  the difference being the em dashes and ellipses in the comments — across 126
 *  files, and the cap is counted in characters, so it is 65,354 over it: about
 *  4.5%. Whole-file packing then costs more, because a chunk stops at the last
 *  file that fits rather than at the cap: the twelve chunks hold 1,262,165 of
 *  those characters, 109 of the 126 files, and the twelfth is cut.
 *
 *  So a change that size IS READ IN PART. The coverage line says how much, the
 *  `diff-not-fully-read` finding lands on the row, and nothing refuses. That is
 *  the cut path working, not a gap in it. */
export const AUDIT_MAX_CHUNKS = 12;

/** The word that opens the gate, and the word that shuts it. Both are read by
 *  the verdict merge below as well as written by the prompt, so each is one
 *  string rather than a literal per use. */
export const AUDIT_APPROVED = "APPROVED";
export const AUDIT_REFUSED = "REFUSED";

/** The line the gate reads. Exported so the prompt and the parser cannot drift
 *  apart: the prompt below asks for exactly this shape. */
export const AUDIT_VERDICT_LINE = `VERDICT: ${AUDIT_APPROVED}`;

/** The heading the removal check's findings go under, for the same reason the
 *  verdict line is a constant: convex/ttsMerge.ts removalNotesOf() reads this
 *  exact word, anchored at the start of a line, and a prompt that asked for
 *  another spelling would file every finding nowhere. */
export const AUDIT_REMOVAL_HEADING = "REMOVAL CHECK:";

/** The audit's own answer, unparsed, when the runner could not be reached. A
 *  failed audit is NOT an approval and not silence either: it is posted as
 *  UNAVAILABLE, so the row says the audit ran and could not finish. */
export const AUDIT_UNAVAILABLE = "UNAVAILABLE";

/** What the row calls the auditor when Codex answered. */
export const AUDIT_MODEL = "codex";

// ── THE CODEX CAP, AND THE SAME-FAMILY FALLBACK ─────────────────────────────
//
// Tom's standing model rule (WikiTom model-of-tom/agent-rules.md, Codex): "a
// box session defaults to gpt-5.6-sol, Opus at the Codex weekly cap". The
// audit is a box job like any other, so it takes the same fallback — but the
// audit's WHOLE POINT is a second opinion from the family that did not write
// the code, and an Opus audit of Claude's own branch is same-family. So the
// fallback is taken AND DECLARED: the row carries `fallback: "codex-cap"` and
// the merge gate's `why` and the #tts-decisions merge line both say the audit
// was Opus at Codex's cap, which is a thing Tom can object to.
//
// Without this a capped week could never merge at all: the audit row is
// write-once for a real verdict, and an UNAVAILABLE at a head used to shut
// that head's gate forever (convex/ttsMerge.ts now lets a real verdict replace
// an UNAVAILABLE, which is the other half of that change).
//
// THE FALLBACK IS PER CHUNK, AND ONE CHUNK IS ENOUGH TO DECLARE IT. Codex can
// go over its cap between chunk three and chunk four, which leaves a row whose
// answer is part Codex and part Opus. The row then says `codex-cap`, because
// the gate's line has to say A CLAUDE MODEL READ PART OF THIS; "most of it was
// a different family" is not a thing the reader can object to.

/** The Codex CLI's own cap vocabulary — the wording a capped run exits with
 *  (`codex-run.mjs` puts the tail of the CLI's stderr on its own stderr, and
 *  execFileSync carries that in the thrown error).
 *
 *  DELIBERATELY NARROWER than session.mjs's USAGE_LIMIT_RE, which also stands
 *  a Claude account down on "session limit"/"limit reached": a false positive
 *  here downgrades the audit to same-family, so only the literal cap wordings
 *  count. Any other failure is still UNAVAILABLE. */
export const CODEX_CAP_RE = /usage[ _-]?limit|rate_limit_reached|hit your usage limit/i;

/** The model the fallback audit RUNS on: the MODELS table's Opus entry, named
 *  explicitly like every other spawn in the fleet (tts-lib.mjs MODELS). */
export const AUDIT_FALLBACK_RUN_MODEL = MODELS.planner;

/** What the row calls the auditor when Opus stood in. */
export const AUDIT_FALLBACK_MODEL = "claude-opus-5";

/** The one word the row carries to say WHY a fallback auditor answered. */
export const AUDIT_FALLBACK_REASON = "codex-cap";

/** The fallback's own wall clock. Longer than runClaude's 10-minute default:
 *  the prompt carries up to AUDIT_CHUNK_MAX_CHARS of diff. */
export const AUDIT_FALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

/** The tools the fallback auditor may use: READING ONES ONLY. The prompt
 *  carries the whole diff, so it needs none of them — but a model that decides
 *  to open a file the diff touches must be able to, and must not be able to do
 *  anything else. This is the Claude-side spelling of AUDIT_SANDBOX. */
export const AUDIT_FALLBACK_TOOLS = ["Read", "Grep", "Glob"];

/** How many turns the fallback gets. runClaude's non-agentic default is 8 and
 *  THE FIRST REAL FALLBACK RUN DIED ON IT (2026-09-11, this commit's own
 *  parent): the model read a few of the files the diff touched, hit
 *  `max_turns_reached` at turn 9, and the CLI exited non-zero — recorded as
 *  UNAVAILABLE with the cap error, which reads as "the fallback is broken"
 *  rather than "the fallback ran out of turns". A read-only auditor cannot do
 *  damage with more turns; it can only fail to finish with fewer. */
export const AUDIT_FALLBACK_MAX_TURNS = 40;

/** Lines of an error that are CONTENT, not a diagnosis: codex-run prints the
 *  tail of the CLI's log, and the log echoes the prompt — which is the diff.
 *  A diff that happens to add the words "hit your usage limit" (this file
 *  does) must not read as a cap. Diff body lines all carry one of these
 *  prefixes, so dropping them leaves the CLI's own words. */
const DIFF_LINE_RE = /^([-+ @]|diff --git |index |\\ No newline)/;

/** Whether a failed Codex run failed BECAUSE OF THE CAP. execFileSync puts the
 *  child's stderr on the thrown error's `stderr` and folds it into `message`;
 *  read both, plus stdout, rather than trusting one. */
export function isCodexCap(error) {
  const text = [error?.message, error?.stderr, error?.stdout]
    .map((part) => (typeof part === "string" ? part : ""))
    .join("\n")
    .split(/\r?\n/)
    .filter((line) => !DIFF_LINE_RE.test(line))
    .join("\n");
  return CODEX_CAP_RE.test(text);
}

/**
 * What the auditor is asked. It judges ONE QUESTION — is this change safe to
 * land on the default branch — and is told what it must not do with it: an
 * audit is not a code review that asks for polish, and a merge gate that
 * refuses on taste never opens.
 *
 * `chunk` is the ONE addition chunking made to this prompt, and it is one line.
 * Absent, the prompt is BYTE-FOR-BYTE what it was before chunking existed — the
 * one question, the removal check, the verdict shape and the "write the verdict
 * line NOWHERE ELSE" rule are identical either way, so a chunked audit and a
 * whole audit answer in the same words and the merge below can read them the
 * same. It carries `{ index, count, files, chars, total }`: which chunk this
 * is, how many there are, and how big the WHOLE change is — an auditor that
 * does not know it is holding a fifth of a change judges as if it held all of
 * it, which is the 2026-09-11 failure in one sentence.
 */
export function auditPrompt({ repo, sha, base, subject, diff, truncated, chunk = null }) {
  return [
    `You are auditing one change before it merges to the default branch of ${repo}.`,
    "",
    `The commit: ${sha}`,
    base ? `Its base: ${base}` : "Its base is the default branch as it stands.",
    subject ? `What it claims to do: ${subject}` : "",
    "",
    "THE ONE QUESTION: would landing this on the default branch break something,",
    "or do something nobody asked for? Approve unless you can name a concrete",
    "problem in the diff — a bug, a boundary crossed, a secret, a deletion of",
    "something still used, a change wider than what it claims to do, a test",
    "weakened or removed to make a failure go away.",
    "",
    "NOT your question: whether the code could be nicer, shorter, differently",
    "structured, better named, or more like the way you would have written it.",
    "A gate that refuses on taste never opens, and this gate is the whole",
    "difference between a branch that lands and a branch that waits for a human.",
    "",
    // THE REMOVAL CHECK IS A FINDING, AND NEVER A REFUSAL ON ITS OWN. A gate
    // that refused on an unanswered removal check would refuse on every branch
    // that adds a test helper or an early return, and a gate that refuses on
    // taste never opens — this prompt's own words, two paragraphs up. Tom's
    // rule is that the change SAYS WHY, not that nothing is ever added, so the
    // unanswered ones are carried out under their own heading instead: they
    // land on the audit row, in front of whoever reads it and in front of the
    // weekly simplification pass, which is where a pattern of additions nobody
    // argued against is what actually shows.
    //
    // NO LINT CHECKS THIS, and scripts/check-removal-note.mjs was considered
    // and not written. A mechanical check can only test for the PRESENCE OF A
    // PHRASE in a commit message or a diff comment, and what that produces is
    // the phrase: every addition grows a sentence saying it could not be
    // deleted, written to satisfy the check, and the check then reports a
    // healthy rate of compliance while nothing is ever deleted. That is
    // Goedecke's wicked feature exactly — a new check every future change has
    // to account for, which makes the thing it measures worse. The two checks
    // that are real are a model reading the actual diff, which can tell an
    // answer from a ritual, and the operate rule the agent reads before it
    // writes ("Adding a case, flag or check: say why what it patches cannot be
    // deleted instead", model-of-tom/agent-rules.md).
    "THE REMOVAL CHECK. For every case, flag, branch or check this diff ADDS: does",
    "the change say why the thing it patches cannot be deleted instead? Name each",
    "addition that does not say.",
    "",
    "This is a FINDING, not a refusal. An unanswered one does not by itself change",
    "the verdict: say it under the heading below and judge the change on the one",
    "question above.",
    "",
    // ONE LINE, and only when there is more of this change than this auditor is
    // holding. The empty string is filtered out below, so an unchunked prompt
    // is unchanged down to the byte.
    chunk === null
      ? ""
      : `This is chunk ${chunk.index} of ${chunk.count} of one change (${chunk.files} files, ${chunk.chars} of ${chunk.total} characters). Judge what is in this chunk; another auditor is reading the rest.`,
    "",
    truncated
      ? "THE DIFF BELOW IS CUT: it was larger than this audit takes. Judge what you can see and say in your answer that you saw only part of the change."
      : "",
    "",
    "Answer in this shape, and put the verdict LINE ON ITS OWN, exactly:",
    "",
    `${AUDIT_VERDICT_LINE}`,
    "",
    "or",
    "",
    "VERDICT: REFUSED",
    "",
    "…followed by a short paragraph. When you refuse, the paragraph names the",
    "concrete problem and where it is. Write the verdict line NOWHERE ELSE in",
    "your answer, not even quoted.",
    "",
    "Then the removal check, its heading ALONE ON ITS LINE, exactly:",
    "",
    `${AUDIT_REMOVAL_HEADING} none`,
    "",
    "or",
    "",
    AUDIT_REMOVAL_HEADING,
    "- <file>:<what was added> — the change does not say why <the thing> cannot be deleted",
    "",
    "one bullet per unanswered addition, the list ending at a blank line.",
    "",
    "The diff, verbatim between the markers:",
    "<<<DIFF",
    diff,
    "DIFF>>>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ── CHUNKING ─────────────────────────────────────────────────────────────────

/**
 * The path a `diff --git` header names. The `b/` side, which is where a rename
 * LANDED — the audit judges the tree after the change, and that is the path the
 * reader will find.
 *
 * Non-greedy on the `a/` side so the split is at the FIRST " b/", which is right
 * for every path that does not itself contain " b/". Git quotes such paths, and
 * a header this cannot parse falls back to the header's own text: an odd sort
 * key is a worse chunk boundary, never a wrong one.
 */
export function pathOfDiffHeader(header) {
  const hit = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  return hit === null ? header.replace(/^diff --git /, "").trim() : hit[2];
}

/**
 * The diff as a list of per-file blocks, TILING THE TEXT EXACTLY: the sum of
 * the blocks' lengths is the diff's length, and every coverage number below
 * depends on that staying true.
 *
 * Anything before the first header — `git diff` emits none, but a caller could
 * hand this a decorated diff — becomes a block with the empty path, which sorts
 * first and is carried rather than dropped.
 */
export function diffBlocks(diff) {
  const text = String(diff ?? "");
  if (text === "") return [];
  const headers = [];
  const re = /^diff --git .*$/gm;
  let hit;
  while ((hit = re.exec(text)) !== null) headers.push({ at: hit.index, header: hit[0] });
  if (headers.length === 0) return [{ path: "", text, order: 0 }];
  const blocks = [];
  if (headers[0].at > 0) blocks.push({ path: "", text: text.slice(0, headers[0].at), order: 0 });
  headers.forEach((head, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].at : text.length;
    blocks.push({
      path: pathOfDiffHeader(head.header),
      text: text.slice(head.at, end),
      order: blocks.length,
    });
  });
  return blocks;
}

/** Every path the change touches, in the order `git diff` emitted them. */
export function filesOf(diff) {
  return diffBlocks(diff)
    .map((block) => block.path)
    .filter((one) => one !== "");
}

/**
 * One `git diff` split into the prompts the auditors will hold.
 *
 * `chunkDiff(diff, { maxChars = AUDIT_CHUNK_MAX_CHARS, maxChunks = AUDIT_MAX_CHUNKS })`
 * → `[{ index, files, text, chars, truncated }]`, `index` counting from 1
 * because it is what the prompt and the coverage lines print.
 *
 * SPLIT ON FILE BOUNDARIES. A chunk that ended mid-hunk would ask the auditor
 * to judge HALF A CHANGE — the added line without the guard above it, the
 * deleted call without its caller — and that is how a FALSE REFUSAL is
 * manufactured: the auditor names a concrete problem that is not one, the gate
 * shuts, and nothing on the row says the problem was the cut.
 *
 * ORDERED BY PATH, NOT BY THE ORDER `git diff` EMITS. Two audits of the same
 * commit then read THE SAME CHUNKS: one's coverage line is comparable with the
 * other's, and a re-audit is a repeat of the same proof rather than a
 * differently-sliced new one. The comparison is plain code-unit ordering — no
 * locale collation, which moves with the box's ICU — and ties keep the diff's
 * own order.
 *
 * A FILE LARGER THAN THE CAP IS ITS OWN CHUNK, CUT, and `truncated` is true for
 * THAT CHUNK ONLY: the other eleven were read whole and must not be reported as
 * partial.
 *
 * PAST maxChunks THE LAST CHUNK CARRIES THE REMAINDER, CUT. Never a refusal:
 * see AUDIT_MAX_CHUNKS. The remainder's files are listed only as far as the cut
 * reaches, because listing a file whose block starts past the cut would be the
 * row claiming coverage it does not have.
 */
export function chunkDiff(diff, { maxChars = AUDIT_CHUNK_MAX_CHARS, maxChunks = AUDIT_MAX_CHUNKS } = {}) {
  const blocks = diffBlocks(diff);
  if (blocks.length === 0) return [];
  blocks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.order - b.order));

  const chunks = [];
  let i = 0;
  while (i < blocks.length && chunks.length < maxChunks) {
    const taken = [];
    let chars = 0;
    let cut = false;
    if (blocks[i].text.length > maxChars) {
      // One file over the cap gets a chunk to itself and is cut inside it.
      // There is no boundary within a file that is not mid-hunk, so this is the
      // one place the rule above cannot be kept — and the chunk says so to its
      // own auditor through `truncated`, which is the prompt's CUT sentence.
      taken.push(blocks[i]);
      cut = true;
      i += 1;
    } else {
      while (
        i < blocks.length &&
        blocks[i].text.length <= maxChars &&
        chars + blocks[i].text.length <= maxChars
      ) {
        taken.push(blocks[i]);
        chars += blocks[i].text.length;
        i += 1;
      }
    }
    const joined = taken.map((block) => block.text).join("");
    chunks.push({
      index: chunks.length + 1,
      files: taken.map((block) => block.path).filter((one) => one !== ""),
      text: cut ? joined.slice(0, maxChars) : joined,
      chars: cut ? Math.min(joined.length, maxChars) : joined.length,
      truncated: cut,
    });
  }

  if (i < blocks.length && chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    const rest = blocks.slice(i);
    const joined = last.text + rest.map((block) => block.text).join("");
    const text = joined.slice(0, maxChars);
    const files = [...last.files];
    let at = last.text.length;
    for (const block of rest) {
      if (at >= text.length) break;
      if (block.path !== "") files.push(block.path);
      at += block.text.length;
    }
    chunks[chunks.length - 1] = {
      index: last.index,
      files,
      text,
      chars: text.length,
      truncated: last.truncated || joined.length > maxChars,
    };
  }
  return chunks;
}

// ── READING THE CHUNKS' ANSWERS BACK ─────────────────────────────────────────

/**
 * The verdict word out of one answer, in THE SAME ANCHORED SHAPE
 * convex/ttsMerge.ts auditVerdictOf() reads. That function is its home and this
 * is a restatement rather than a second definition — a worker job must not
 * import a Convex module — so if one of the two moves, both move.
 */
export const AUDIT_VERDICT_RE = /^[ \t]*VERDICT:[ \t]*([A-Za-z][A-Za-z_-]*)[ \t]*$/im;

export function verdictOf(text) {
  const hit = AUDIT_VERDICT_RE.exec(String(text ?? ""));
  return hit === null ? null : hit[1].toUpperCase();
}

/**
 * The chunks' verdicts, merged. ANY REFUSED WINS, in this order: any REFUSED →
 * REFUSED; else any UNAVAILABLE or unparseable → UNAVAILABLE; else APPROVED.
 *
 * A refusal is a CONCRETE NAMED PROBLEM — the prompt admits no other kind — and
 * one of those is enough to hold a branch. The alternative, an approval that
 * outvoted a refusal, is a gate that opens on A MAJORITY OF PARTIAL READERS:
 * eleven auditors who saw no problem in their eleventh of the change would
 * outvote the one who found the bug, which is the exact failure chunking exists
 * to prevent.
 *
 * A word that is neither APPROVED nor UNAVAILABLE counts as a refusal. It is a
 * stated non-approval, and the gate treats every non-APPROVED word as shut
 * anyway; the alternative is inventing an approval out of a word nobody
 * defined.
 */
export function mergeChunkVerdicts(words) {
  if (words.length === 0) return AUDIT_UNAVAILABLE;
  const seen = words.map((word) => (typeof word === "string" && word !== "" ? word.toUpperCase() : null));
  if (seen.some((word) => word !== null && word !== AUDIT_APPROVED && word !== AUDIT_UNAVAILABLE)) {
    return AUDIT_REFUSED;
  }
  if (seen.some((word) => word === null || word === AUDIT_UNAVAILABLE)) return AUDIT_UNAVAILABLE;
  return AUDIT_APPROVED;
}

/**
 * One answer's removal-check bullets. convex/ttsMerge.ts removalNotesOf() is
 * the home of this reading too, restated here for the same reason and kept
 * character-identical to it, so the bullets this composes under the merged
 * heading are exactly the bullets that function reads back out.
 */
export function removalBulletsOf(text) {
  const answer = String(text ?? "");
  const heading = new RegExp(`^[ \\t]*${AUDIT_REMOVAL_HEADING}[ \\t]*(.*)$`, "im").exec(answer);
  if (heading === null) return [];
  if (heading[1].trim().toLowerCase() === "none") return [];
  const after = answer.slice(heading.index + heading[0].length).split(/\r?\n/).slice(1);
  const notes = [];
  for (const line of after) {
    const bullet = /^[ \t]*-[ \t]+(.*\S)[ \t]*$/.exec(line);
    if (bullet === null) break;
    notes.push(bullet[1].trim());
  }
  return notes;
}

/** The caps convex/ttsMerge.ts applies when it reads the row back
 *  (AUDIT_REMOVAL_NOTES_MAX 20, AUDIT_REMOVAL_NOTE_MAX_CHARS 300). Composing
 *  more than it keeps would only spend the 8 KiB the coverage lines need. */
export const AUDIT_NOTES_MAX = 20;
export const AUDIT_NOTE_MAX_CHARS = 300;

/**
 * ONE CHUNK'S ANSWER, MADE SAFE TO QUOTE. Every anchored `VERDICT:` line becomes
 * `chunk verdict: <WORD>` and every anchored `REMOVAL CHECK:` heading becomes
 * `chunk removal check:`.
 *
 * THIS IS THE LOAD-BEARING PART OF THE COMPOSER. convex/ttsMerge.ts has two
 * anchored readers over the posted text — auditVerdictOf and removalNotesOf —
 * and each must find EXACTLY ONE match: the merged verdict and the merged
 * heading written at the top. Twelve chunk answers each carrying their own
 * would give the first reader whichever came first in the text and the second
 * reader one chunk's bullets instead of all of them. Both anchors require the
 * line to START with the word, whitespace aside, so the `chunk ` prefix is what
 * disarms them.
 */
export function rewriteChunkAnswer(text) {
  return String(text ?? "")
    .replace(/^[ \t]*VERDICT:[ \t]*(.*)$/gim, (whole, rest) => `chunk verdict: ${rest.trim()}`)
    .replace(new RegExp(`^[ \\t]*${AUDIT_REMOVAL_HEADING}[ \\t]*(.*)$`, "gim"), (whole, rest) =>
      rest.trim() === "" ? "chunk removal check:" : `chunk removal check: ${rest.trim()}`,
    );
}

/** The span a chunk's per-chunk line names. One file names itself rather than
 *  printing `a…a`; a chunk of none (a diff with no `diff --git` header at all)
 *  says so rather than printing an empty range. */
export function chunkSpan(files) {
  if (files.length === 0) return "(no file header)";
  if (files.length === 1) return files[0];
  return `${files[0]}…${files[files.length - 1]}`;
}

/**
 * The chunks' answers as ONE POSTED TEXT, WRITTEN CUT-TOLERANT.
 *
 * convex/ttsMerge.ts keeps AUDIT_TEXT_MAX_BYTES = 8 KiB of this after
 * redaction, and twelve chunk answers are not 8 KiB. So the order is the order
 * of what must survive, top down, and the cut eats the bottom:
 *
 *   1. the merged verdict line, ONCE, in auditVerdictOf's anchored form;
 *   2. the merged REMOVAL CHECK: heading, ONCE, with every chunk's bullets
 *      under it, so removalNotesOf reads all of them and not one chunk's;
 *   3. one short line per chunk — `chunk i/n first…last: WORD` — so the whole
 *      coverage picture is n lines and survives any cut that leaves a header;
 *   4. the chunks' reason paragraphs, in path order, which is the prose and the
 *      first thing worth losing.
 *
 * The bullets sit above the coverage lines and are capped at 20 × 300, the most
 * the row would keep anyway: worst case that is 6 KiB, which leaves the twelve
 * coverage lines inside 8 KiB for any ordinary set of paths.
 *
 * Answers `{ text, verdict, read }`; `read` is how many chunks came back with a
 * parseable verdict, which is half of the `diff-not-fully-read` finding below.
 */
export function composeChunkedAudit(parts) {
  const count = parts.length;
  const words = parts.map((part) => verdictOf(part.text));
  const verdict = mergeChunkVerdicts(words);

  const bullets = [];
  for (const part of parts) {
    for (const bullet of removalBulletsOf(part.text)) {
      if (bullets.length >= AUDIT_NOTES_MAX) break;
      bullets.push(bullet.slice(0, AUDIT_NOTE_MAX_CHARS));
    }
  }

  const lines = [`VERDICT: ${verdict}`, ""];
  if (bullets.length === 0) lines.push(`${AUDIT_REMOVAL_HEADING} none`, "");
  else lines.push(AUDIT_REMOVAL_HEADING, ...bullets.map((one) => `- ${one}`), "");
  parts.forEach((part, at) => {
    lines.push(`chunk ${at + 1}/${count} ${chunkSpan(part.chunk.files)}: ${words[at] ?? AUDIT_UNAVAILABLE}`);
  });
  lines.push("");
  parts.forEach((part, at) => {
    lines.push(`--- chunk ${at + 1} of ${count} ---`, rewriteChunkAnswer(part.text).trim(), "");
  });
  return {
    text: `${lines.join("\n").trimEnd()}\n`,
    verdict,
    read: words.filter((word) => word !== null).length,
  };
}

// ── THE FOUR TRACE FINDINGS ──────────────────────────────────────────────────
//
// NOT A VERIFIER OF ITS OWN, and not a fourth head row. These ride the audit row
// beside the removal check's notes, as `traceFindings`, and the gate reads
// neither. Each checks a CLAIM IN THE AUDIT'S TEXT against the RUN RECORD — the
// audit's own run, read back through GET /tts/run-trace — and all four are
// string and count checks computed here, after the model answers and before the
// post. No model judges them.
//
// OUT OF SCOPE, deliberately: CHECKING THE CLAIMS OF THE RUNS THAT WROTE THE
// BRANCH. Nothing sets `mergeKey` on those runs, so there is no way to find them
// from a commit at all. When the session daemon sets it, finding 1 extends from
// "a tests-run row exists for this commit" to "a Bash tool call in the writing
// run actually ran the suite", with no new machinery here.

/** The claims finding 1 looks for, stated here rather than inside the check so
 *  the phrase set is a thing that can be read and added to. SMALL AND FIXED: a
 *  regex over "test" and "pass" would fire on "the tests it adds pass nothing to
 *  the helper", and a finding that fires on every row is a finding nobody
 *  reads. */
export const TESTS_CLAIMED_PHRASES = [
  "tests pass",
  "tests are green",
  "the suite passes",
  "the tests passed",
  "the branch is tested",
];

/** The sentence shapes that make a path A CLAIM TO HAVE OPENED IT, rather than
 *  a path the auditor read off the diff it was handed. Without this, finding 2
 *  fires on every file the reason paragraph names — which is most of the diff —
 *  and a finding that always fires says nothing. */
export const READ_CLAIM_RE =
  /\b(?:i (?:read|opened|checked|inspected|grepped|reviewed|looked at)|read the file|opened the file|reading |grepping |after reading)/i;

/** A repo path, in the shape the removal check's own bullets use: at least one
 *  slash and an extension. */
export const REPO_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}/g;

/** The tool calls that count as HAVING OPENED A FILE. */
export const READ_TOOLS = ["Read", "Grep", "Glob"];

/** What finding 4 counts as a guard: a thing whose whole job is to catch a
 *  change in the code beside it. */
export const GUARD_PATH_RES = [
  /(^|\/)[^/]+\.test\.[^/]+$/,
  /^scripts\/check-[^/]*\.mjs$/,
  /^worker\/jobs\/evals\.mjs$/,
  /^convex\/ttsMerge\.ts$/,
];

export const isGuardPath = (file) => GUARD_PATH_RES.some((shape) => shape.test(file));

/** How many findings the row keeps and how much of each — THE CAPS
 *  `removalNotes` already uses, for the same reason: the row is a record, and
 *  the text the findings came out of is on the row beside them. */
export const TRACE_FINDINGS_MAX = AUDIT_NOTES_MAX;
export const TRACE_FINDING_MAX_CHARS = AUDIT_NOTE_MAX_CHARS;

/** Two paths naming the same file, allowing for one of them being absolute (a
 *  tool call's path is whatever the model typed) and for Windows slashes. */
function samePath(one, other) {
  const a = String(one).replace(/\\/g, "/").replace(/^\.\//, "");
  const b = String(other).replace(/\\/g, "/").replace(/^\.\//, "");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The four findings. Pure: every input is already in hand.
 *
 *   `text`        the audit's merged answer, as posted.
 *   `chunks`      the coverage record, as posted.
 *   `files`       every path the diff touches.
 *   `toolCalls`   `[{ name, path }]` from the audit's OWN run(s).
 *   `testsPassed` the merge gate's `tests` check: true, false, or null when the
 *                 gate could not be read. NULL MAKES NO FINDING — "the tests
 *                 are not green" and "nobody could ask" are different facts and
 *                 only one of them is about this audit.
 *   `traced`      whether the audit's OWN run record was read at all. FALSE
 *                 SILENCES FINDING 2, AND ONLY FINDING 2: with no tool-call
 *                 list every path the answer claims would look unopened, which
 *                 is a finding about the sweeper and not about the audit.
 *                 Findings 1, 3 and 4 need no run record — 3 is computed from
 *                 this file's own coverage numbers and is the whole reason the
 *                 round exists — so a slow sweeper must not silence them, and
 *                 `trace.available` on the row says which half of the check
 *                 ran. The brief asked for an EMPTY findings list on an absent
 *                 record; that would put the one deterministic finding to sleep
 *                 exactly when the record is hardest to read, which is the
 *                 fault of §4.1 said a second time.
 */
export function traceFindingsOf({ text, chunks, files = [], toolCalls = [], testsPassed = null, sha = "", traced = true }) {
  const answer = String(text ?? "");
  const short = String(sha).slice(0, 7);
  const findings = [];

  // 1. THE AUDIT SAYS THE TESTS PASS AND THE RECORD DOES NOT.
  const claimed = TESTS_CLAIMED_PHRASES.find((phrase) => answer.toLowerCase().includes(phrase));
  if (claimed !== undefined && testsPassed === false) {
    findings.push(
      `tests-claimed-not-run: the audit says "${claimed}" and no green tests-run row is recorded for ${short === "" ? "this commit" : short}`,
    );
  }

  // 2. THE AUDIT SAYS IT OPENED A FILE AND ITS OWN RUN NEVER DID. The one
  //    finding that needs the run record, and the one the absence silences.
  const opened = toolCalls
    .filter((call) => READ_TOOLS.includes(call?.name) && typeof call?.path === "string" && call.path !== "")
    .map((call) => call.path);
  const claimedPaths = new Set();
  for (const line of answer.split(/\r?\n/)) {
    if (!READ_CLAIM_RE.test(line)) continue;
    for (const one of line.match(REPO_PATH_RE) ?? []) claimedPaths.add(one);
  }
  for (const claimedPath of traced ? claimedPaths : []) {
    if (!opened.some((one) => samePath(one, claimedPath))) {
      findings.push(
        `claimed-read-not-in-the-record: ${claimedPath} is in no Read, Grep or Glob call of this audit's run`,
      );
    }
  }

  // 3. THE AUDIT DID NOT READ THE WHOLE DIFF. The deterministic one: it needs
  //    no run record at all, only the coverage numbers this file computed.
  if (chunks && (chunks.read < chunks.count || chunks.charsRead < chunks.charsTotal)) {
    findings.push(
      `diff-not-fully-read: ${chunks.read} of ${chunks.count} chunks answered, ${chunks.charsRead} of ${chunks.charsTotal} characters read`,
    );
  }

  // 4. A GUARD MOVED WITH THE THING IT GUARDS. The reward-hacking shape: a
  //    producer satisfying a check's letter by editing the check.
  //
  //    A FINDING, NEVER A REFUSAL, and it will fire on most honest branches — a
  //    change that adds behaviour and its test is exactly this pattern. That is
  //    the point: no single row means anything here, and what is worth reading
  //    is THE RATE OVER WEEKS, in front of the weekly simplification pass. A
  //    gate that shut on it would shut on every branch that tests what it
  //    writes, which is a gate that refuses on taste by another name.
  const byTop = new Map();
  for (const file of files) {
    const top = String(file).split("/")[0];
    const bucket = byTop.get(top) ?? { guards: [], code: [] };
    (isGuardPath(file) ? bucket.guards : bucket.code).push(file);
    byTop.set(top, bucket);
  }
  for (const [top, bucket] of byTop) {
    if (bucket.guards.length > 0 && bucket.code.length > 0) {
      findings.push(
        `guard-changed-with-what-it-guards: ${bucket.guards[0]} changed in the same commit as ${bucket.code[0]} (${top}/)`,
      );
    }
  }

  return findings.slice(0, TRACE_FINDINGS_MAX).map((one) => one.slice(0, TRACE_FINDING_MAX_CHARS));
}

// ── THE AUDIT'S OWN RUN ──────────────────────────────────────────────────────

/** How long the trace waits for the sweeper to have seen the audit's own run.
 *  THE SAME SHAPE worker/jobs/evals.mjs runRecordFor() uses — twelve polls five
 *  seconds apart, counting ATTEMPTS rather than reading a clock, because a fake
 *  clock does not advance.
 *
 *  RESTATED, NOT IMPORTED. worker/jobs does have cross-job imports (evals.mjs
 *  imports tts-code-lib.mjs, simplify.mjs imports session-archive.mjs), but
 *  every one of them imports a LIBRARY module; evals.mjs is a job with a main()
 *  guard of its own, and importing it here would run its top level inside every
 *  audit.
 *
 *  An audit is rare — one per merge candidate — so a 60-second wait costs
 *  nothing that matters. */
export const RUN_RECORD_WAIT_MS = 60_000;
export const RUN_RECORD_POLL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The audit's own run(s), read back through GET /tts/run-trace. ONE TOKEN PER
 * CHUNK: each chunk is its own Codex or Opus run, and a claim in the merged text
 * was made by one of them, so their tool calls are read as one list.
 *
 * Answers `null` when nothing came back, which upstream is A COUNTED ABSENCE
 * and never silence.
 *
 * `truncated` rides up from the door, and it MATTERS: GET /tts/run-trace caps
 * at 400 transcript ROWS, not 400 tool calls, so a long run's calls are cut
 * well before four hundred of them. Finding 2 fires when a claimed path is in
 * NO call of the list — a cut list therefore makes it fire on a path that WAS
 * opened and fell past the cut, which is a false accusation against an honest
 * audit. One truncated record makes the whole list unusable for that finding.
 */
export async function runTracesFor(io, tokens) {
  if (typeof io.runTrace !== "function" || tokens.length === 0) return null;
  const attempts = Math.max(1, Math.ceil(RUN_RECORD_WAIT_MS / RUN_RECORD_POLL_MS));
  const found = new Map();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const token of tokens) {
      if (found.has(token)) continue;
      try {
        const record = await io.runTrace(token);
        if (record && Array.isArray(record.toolCalls)) found.set(token, record);
      } catch {
        // Not swept yet, or the door is not deployed in this tree. Either is an
        // unknown trace, not a failed audit.
      }
    }
    if (found.size === tokens.length) break;
    if (attempt < attempts - 1) await (io.sleep ?? sleep)(RUN_RECORD_POLL_MS);
  }
  if (found.size === 0) return null;
  const records = [...found.values()];
  return {
    runs: records.length,
    of: tokens.length,
    runId: records[0]?.runId ?? null,
    turns: records.reduce((total, one) => total + (Number(one.turns) || 0), 0),
    toolCalls: records.flatMap((one) => one.toolCalls),
    truncated: records.some((one) => one.truncated === true),
  };
}

/** The key every fact about one commit is filed under. `commitKey(repo, sha)`
 *  in convex/ttsMerge.ts is its home and this is that one line restated — a
 *  worker job must not import a Convex module, and the alternative to restating
 *  it is the audit's run being filed under a key nothing else looks up. */
export const commitMergeKey = (repo, sha) => `${repo}@${sha}`;

/** The token `tts-codex` minted for the run it just made. codex-run.mjs writes
 *  its registration sidecar into TTS_RUN_REG_SPOOL and names the file after the
 *  token; pointing that at a FRESH EMPTY DIRECTORY per chunk is what makes "the
 *  one file in it" exact. Nothing here is an error: no file, or more than one,
 *  is an UNKNOWN TOKEN, and an unknown token costs the trace, not the audit. */
export function spoolToken(dir) {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    if (files.length !== 1) return null;
    const token = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"))?.token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/** The change under audit, as `git diff` sees it — WHOLE. Cutting happens in
 *  chunkDiff and nowhere else, so there is exactly one place that decides what
 *  an auditor did not see. */
export function diffOf(dir, sha, base, run = defaultRun) {
  const range = base ? `${base}..${sha}` : `${sha}~1..${sha}`;
  const text = run("git", ["-C", dir, "diff", "--no-color", range]);
  return { diff: text, chars: text.length };
}

function defaultRun(command, args) {
  return String(
    execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
}

/**
 * Audit one commit and record the verdict. Answers
 * `{ verdict, text, model, fallback, chunks, trace, traceFindings, recorded }`;
 * the caller decides what to do with a refusal, because the gate does — this
 * never merges anything itself.
 *
 * `io` carries every side effect so the test drives it with no model, no git
 * and no network.
 */
export async function auditCommit(
  { repo, sha, base = null, subject = "", dir = "." },
  suppliedIo = {},
) {
  const mergeKey = commitMergeKey(repo, sha);
  const envOf = suppliedIo.env ?? (() => loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY"] }));
  let envCache;
  const envOnce = () => (envCache ??= envOf());
  const io = {
    run: defaultRun,
    env: envOf,
    // THE PROMPT GOES ON STDIN, never in argv. tts-codex forwards its argv
    // straight to scripts/codex-run.mjs, whose arg loop refuses anything that
    // is not one of its flags — a positional prompt was rejected as an unknown
    // option, readStdin() then found nothing, and every audit was recorded
    // UNAVAILABLE. codex-run reads the prompt from stdin and nowhere else.
    //
    // `receipt` is an OUT-PARAMETER, runClaude's own spelling: the token of the
    // run this call made comes back as `receipt.runToken`, which is how the
    // audit later finds its own tool calls. For Codex THE TOKEN IS NOT ON
    // STDOUT, so it is read out of a private registration spool.
    audit: (prompt, receipt) => {
      const spool = mkdtempSync(path.join(tmpdir(), "tts-audit-reg-"));
      try {
        const out = String(
          execFileSync(AUDIT_RUNNER, ["--cwd", dir, "--sandbox", AUDIT_SANDBOX, "--no-operate"], {
            input: prompt,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            env: {
              ...process.env,
              TTS_RUN_ORIGIN: "cron:audit",
              // WHAT LINKS THE AUDIT'S RUN TO THE COMMIT IT AUDITED. Nothing
              // set this before, so the run was registered and unfindable.
              TTS_RUN_MERGE_KEY: mergeKey,
              TTS_RUN_REG_SPOOL: spool,
            },
          }),
        );
        if (receipt) receipt.runToken = spoolToken(spool);
        return out;
      } finally {
        rmSync(spool, { recursive: true, force: true });
      }
    },
    // THE SAME PROMPT, one family over, when Codex is capped. Non-agentic and
    // allow-listed to the three reading tools: the model may open a file the
    // diff touches and can edit nothing and run nothing — an auditor that can
    // edit the tree it is judging is not an auditor, in either family.
    //
    // runClaude takes `registration` and `receipt` already (tts-lib.mjs spools
    // the registration itself, copies `registration.mergeKey` through, and
    // writes the token into `receipt.runToken`), so this path needs no spool of
    // its own.
    auditFallback: (prompt, receipt) =>
      runClaude(prompt, {
        cwd: dir,
        model: AUDIT_FALLBACK_RUN_MODEL,
        maxTurns: AUDIT_FALLBACK_MAX_TURNS,
        allowedTools: AUDIT_FALLBACK_TOOLS,
        timeoutMs: AUDIT_FALLBACK_TIMEOUT_MS,
        registration: { origin: "cron:audit", mergeKey },
        receipt: receipt ?? {},
      }),
    mergeGate: (env, askRepo, askSha) =>
      convexFetch(
        env,
        `/tts/merge-gate?repo=${encodeURIComponent(askRepo)}&sha=${encodeURIComponent(askSha)}`,
      ),
    runTrace: (token) => convexFetch(envOnce(), `/tts/run-trace?token=${encodeURIComponent(token)}`),
    post: (env, body) => convexFetch(env, "/tts/audit", body),
    ...suppliedIo,
  };

  let text;
  let model = AUDIT_MODEL;
  let fallback = null;
  let files = [];
  let chunksRecord = { count: 0, read: 0, charsRead: 0, charsTotal: 0, truncatedChunks: 0, files: 0 };
  const tokens = [];
  try {
    const { diff, chars } = diffOf(dir, sha, base, io.run);
    if (diff.trim() === "") {
      text = `VERDICT: REFUSED\n\nThere is no diff between ${base ?? `${sha}~1`} and ${sha}: there is nothing to audit, and an audit of nothing is not an approval.`;
    } else {
      files = filesOf(diff);
      const chunks = chunkDiff(diff);
      const parts = [];
      for (const chunk of chunks) {
        const prompt = auditPrompt({
          repo,
          sha,
          base,
          subject,
          diff: chunk.text,
          truncated: chunk.truncated,
          chunk: {
            index: chunk.index,
            count: chunks.length,
            files: files.length,
            chars: chunk.chars,
            total: chars,
          },
        });
        const receipt = {};
        let answer;
        try {
          answer = String(io.audit(prompt, receipt) ?? "");
        } catch (error) {
          // ONLY the cap falls back. Every other Codex failure is UNAVAILABLE,
          // because a second family that merely broke is not a reason to drop
          // to the family that wrote the code.
          //
          // AND A FAILURE IS CONTAINED TO ITS CHUNK. One unreachable auditor
          // makes the MERGED verdict UNAVAILABLE through mergeChunkVerdicts —
          // the same answer the whole audit used to give — but the other
          // chunks' readings, and the coverage record, survive it.
          if (!isCodexCap(error)) {
            answer = `VERDICT: ${AUDIT_UNAVAILABLE}\n\nThe audit could not run: ${String(error?.message ?? error).slice(0, 500)}`;
          } else {
            try {
              answer = String(io.auditFallback(prompt, receipt) ?? "");
              model = AUDIT_FALLBACK_MODEL;
              fallback = AUDIT_FALLBACK_REASON;
            } catch (fallbackError) {
              // Both families failed on this chunk: that is UNAVAILABLE, and
              // the chunk names both failures rather than only the second.
              answer = `VERDICT: ${AUDIT_UNAVAILABLE}\n\nThe audit could not run: ${String(error?.message ?? error).slice(0, 200)} — and the ${AUDIT_FALLBACK_MODEL} fallback also failed: ${String(fallbackError?.message ?? fallbackError).slice(0, 200)}`;
            }
          }
        }
        if (typeof receipt.runToken === "string" && receipt.runToken !== "") tokens.push(receipt.runToken);
        parts.push({ chunk, text: answer });
      }
      const merged = composeChunkedAudit(parts);
      text = merged.text;
      chunksRecord = {
        count: chunks.length,
        read: merged.read,
        charsRead: chunks.reduce((total, chunk) => total + chunk.chars, 0),
        charsTotal: chars,
        truncatedChunks: chunks.filter((chunk) => chunk.truncated).length,
        files: files.length,
      };
    }
  } catch (error) {
    // An auditor that could not run is recorded as one, never skipped: a
    // missing row and a refusal are different facts to the gate, and this is
    // neither an approval nor a silence.
    model = AUDIT_MODEL;
    fallback = null;
    text = `VERDICT: ${AUDIT_UNAVAILABLE}\n\nThe audit could not run: ${String(error?.message ?? error).slice(0, 500)}`;
  }

  const env = envOnce();

  // THE TRACE, AND ITS ABSENCE, BOTH COUNTED. `regressions: null` is the rule
  // this follows (convex/ttsMerge.ts): "not asked" and "asked, no answer" must
  // not print the same sentence. A trace that never arrived says so on the row
  // WITH A REASON, rather than passing itself off as a clean bill of health.
  //
  // THE ABSENCE SILENCES ONE FINDING, NOT FOUR. Finding 2 is the only one that
  // reads the run record; 1, 3 and 4 are computed from the answer, the merge
  // gate and this file's own coverage numbers. Gating all four on the sweeper
  // would put `diff-not-fully-read` — the finding this whole round exists to
  // produce — to sleep exactly when the record is slowest, which is the §4.1
  // fault wearing a different coat. So the findings are always computed and
  // `traced` says whether finding 2 was one of them.
  let trace;
  let toolCalls = [];
  let traced = false;
  if (typeof io.runTrace !== "function") {
    trace = { available: false, reason: "no run-trace door in this tree" };
  } else if (tokens.length === 0) {
    trace = { available: false, reason: "the audit's runs minted no registration token" };
  } else {
    const record = await runTracesFor(io, tokens);
    if (record === null) {
      trace = {
        available: false,
        reason: `no run record for ${tokens.length} audit run${tokens.length === 1 ? "" : "s"} within ${Math.round(RUN_RECORD_WAIT_MS / 1000)}s`,
      };
    } else {
      // TWO FIELDS AND NO MORE. convex/ttsMerge.ts internalRecordAudit types
      // `trace` as `v.object({ available, reason? })`, and a Convex object
      // validator REFUSES an unknown field — a richer trace here would not be a
      // fuller record, it would be a rejected post and an audit row that never
      // lands. The run's own id, turns and tool-call count are already on the
      // run record this read them from, filed under the commit by
      // TTS_RUN_MERGE_KEY, so nothing is lost by being left off here.
      //
      // `reason` rides the available arm too, because "3 of 12 runs answered"
      // is the difference between a trace that saw the whole audit and one that
      // saw a quarter of it, and finding 2 was computed from the quarter.
      // A CUT LIST IS NOT A LIST. The door caps at 400 transcript rows, so a
      // long audit run loses tool calls off the end; finding 2 reads absence
      // as a false claim, and the one thing this round cannot afford is an
      // accusation against an audit that did open the file. So a truncated
      // record leaves the trace AVAILABLE — the read happened and the reason
      // says what it found — and silences finding 2 exactly as an absent
      // record does.
      traced = record.truncated !== true;
      toolCalls = record.toolCalls;
      trace = {
        available: true,
        reason:
          `${record.runs} of ${record.of} audit run${record.of === 1 ? "" : "s"} read, ${record.turns} turns, ${record.toolCalls.length} tool calls` +
          (record.truncated === true ? " (the row cap cut the list, so the read-claim check is not run)" : ""),
      };
    }
  }

  let testsPassed = null;
  try {
    const gate = await io.mergeGate(env, repo, sha);
    const tests = (gate?.checks ?? []).find((check) => check?.name === "tests");
    if (tests !== undefined) testsPassed = tests.passed === true;
  } catch {
    // The gate could not be read: finding 1 then makes no claim either way.
  }

  const traceFindings = traceFindingsOf({
    text,
    chunks: chunksRecord,
    files,
    toolCalls,
    testsPassed,
    sha,
    traced,
  });

  const recorded = await io.post(env, {
    repo,
    sha,
    text,
    model,
    ...(fallback === null ? {} : { fallback }),
    // A RECORD, NOT A CONDITION. The gate does not read `chunks`; it is how the
    // next reader tells an audit of a whole change from an audit of its fifth.
    //
    // SENT ONLY WHEN THERE WERE CHUNKS. An audit that could not run at all, or
    // one over an empty diff, has no coverage to report, and posting
    // `{count: 0, read: 0, …}` would put "0 of 0 chunks, 0 of 0 characters"
    // into the sentence Tom reads and make an UNAVAILABLE row indistinguishable
    // from a pre-chunking one. Absent is the honest answer to a question the
    // audit never got far enough to answer.
    ...(chunksRecord.count === 0 ? {} : { chunks: chunksRecord }),
    traceFindings,
    trace,
  });
  return {
    verdict: recorded?.verdict ?? null,
    text,
    model,
    fallback,
    chunks: chunksRecord,
    trace,
    traceFindings,
    recorded,
  };
}

// ── THE COMMAND ──────────────────────────────────────────────────────────────
//
// worker/bin/tts-audit is the installed door and ITS contract is followed here
// rather than a second one invented: the same five flags, the same summary
// lines, the same exit 4 on a verdict that is not APPROVED. `--dry-run` is the
// one flag this has that the bin does not — it computes the chunks, prints the
// coverage numbers and POSTS NOTHING, which is the only way to see what an
// auditor would be handed without spending a Codex run to find out.

function parseArgs(argv) {
  const args = { repo: "", sha: "", base: null, subject: "", dir: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (!["--repo", "--sha", "--base", "--subject", "--dir"].includes(flag)) {
      throw new Error(`unknown flag ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    i += 1;
    args[flag.slice(2)] = value;
  }
  if (args.repo.trim() === "") throw new Error("--repo is required");
  if (args.sha.trim() === "") throw new Error("--sha is required");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.dryRun) {
    const { diff, chars } = diffOf(args.dir, args.sha, args.base);
    const chunks = chunkDiff(diff);
    const read = chunks.reduce((total, chunk) => total + chunk.chars, 0);
    process.stdout.write(`AUDIT ${args.repo}@${args.sha.slice(0, 7)} (dry run — nothing posted)\n`);
    process.stdout.write(
      `chunks: ${chunks.length}, files: ${filesOf(diff).length}, characters: ${read} of ${chars}, cut chunks: ${chunks.filter((one) => one.truncated).length}\n`,
    );
    for (const chunk of chunks) {
      process.stdout.write(
        `  chunk ${chunk.index}/${chunks.length} ${chunkSpan(chunk.files)}: ${chunk.files.length} files, ${chunk.chars} characters${chunk.truncated ? " (cut)" : ""}\n`,
      );
    }
    return;
  }
  const result = await auditCommit({
    repo: args.repo,
    sha: args.sha,
    base: args.base,
    subject: args.subject,
    dir: args.dir,
  });
  process.stdout.write(`AUDIT ${args.repo}@${args.sha.slice(0, 7)}\n`);
  process.stdout.write(`verdict: ${result.verdict ?? "unrecorded"}\n`);
  process.stdout.write(`auditor: ${result.model}${result.fallback ? ` (${result.fallback})` : ""}\n`);
  process.stdout.write(
    `read: ${result.chunks.read} of ${result.chunks.count} chunks, ${result.chunks.charsRead} of ${result.chunks.charsTotal} characters\n`,
  );
  process.stdout.write(`${result.text.trim()}\n`);
  if (result.verdict !== AUDIT_APPROVED) process.exitCode = 4;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[audit] FAILED: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  });
}
