// THE CAPS ON VOLATILE PROMPT CONTENT, and nothing else. A todo's brief and a
// fork's prior transcript are the two pieces of a prompt whose size is the
// record's to decide rather than the assembler's; this file is where each one
// is cut, and where the line saying what was cut is written.
//
// WHAT LEFT, AND WHERE IT WENT. This file used to hold the know-layer
// expansion: which bytes of which area page, intent section and AGENTS.md rode
// a run's prompt, plus the fetchable index naming everything that did not. The
// know layer is a published SKILL CATALOG now, so there is nothing to expand
// and nothing to index — a run is granted skill names and loads a body itself,
// once, if it needs it.
//
//   the routing half   worker/jobs/skill-router.mjs — the same area terms, the
//                      same word-boundary match, the same category and batch
//                      rankings and path tokens, answering "which skills is
//                      this run granted" instead of "which bytes ride"
//   the bodies         scripts/skills.mjs, which builds the catalog, and
//                      scripts/publish-skills.mjs, which writes it out
//   the search index   worker/jobs/search-lib.mjs `usage()`, which already
//                      names every corpus and flag the index used to list
//
// Nothing here selects, slices, ranks or renders a page any more.
//
// THREE SIDES CALL WHAT IS LEFT, and they must agree byte for byte on where a
// brief stops:
//   convex/claudeSessions.ts        the autonomous opener's facts block
//   app/lib/tts-session-prompt.ts   the interactive twin's
//   scripts/prelude.test.mjs        which asserts the two carry the same text
//
// NO MODEL CALL. The cut is a byte count and a heading scan, a pure function of
// its input — same input, byte-identical output, which is what keeps the stable
// prefix cacheable and the transcript's header lines auditable.
//
// Plain ESM, like markdown-sections.mjs beside it and for the same reason:
// worker/ is deployed to the Jarvis Box, where Node loads no TypeScript, and
// Convex bundles this file into a runtime with no filesystem. Its one import is
// markdown-sections.mjs, for the headings a cut brief snaps back to.

import { headings } from "./markdown-sections.mjs";

// ── Byte helpers ─────────────────────────────────────────────────────────────

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

/** UTF-8 bytes, in the Convex runtime and on the box alike. */
export function byteLength(text) {
  const s = String(text ?? "");
  if (encoder !== null) return encoder.encode(s).length;
  return Buffer.byteLength(s, "utf8");
}

// ── The caps ─────────────────────────────────────────────────────────────────

/**
 * Supplemental caps. The BRIEF truncates at the last heading before the cap,
 * because a brief reads forward and a heading is where it can honestly stop;
 * a TRANSCRIPT keeps its LAST bytes, because a session's end is where it was
 * going. Both say where the rest is.
 *
 * Fixed integers, both of them. A cap that moved with its input would make the
 * same todo assemble differently on different days.
 *
 * The fork's prior transcript does not need the second cap today: forkSessionAs
 * writes the whole transcript to `.tts-transcript.md` in the workspace and the
 * opener tells the run to read it, so nothing about it rides the prompt. The
 * cap stays declared for a caller that has no workspace to write a file into.
 */
export const SUPPLEMENTAL_CAPS = Object.freeze({ brief: 8192, transcript: 24576 });

/** Where a truncated brief's rest is — one string, so both prompt builders
 * append the same sentence and cannot disagree about where to send the run. */
export const BRIEF_SOURCE = "tom.quest/tts, or the record";

/** A todo's brief as the prompt should carry it. THE ONE HOME both prompt
 * builders call, so the text that was cut and the line saying so agree. */
export function briefForPrompt(brief) {
  return truncateSupplemental(brief, SUPPLEMENTAL_CAPS.brief, { keep: "head", where: BRIEF_SOURCE });
}

/**
 * A brief or a forked transcript, cut to its cap. THE BRIEF keeps its head and
 * stops at the last heading before the cap, because a brief reads forward; THE
 * TRANSCRIPT keeps its LAST bytes, because a session's end is where it was
 * going. Both say where the rest is.
 */
export function truncateSupplemental(text, cap, { keep = "head", where }) {
  const source = String(text ?? "");
  const bytes = byteLength(source);
  if (bytes <= cap) return { text: source, truncated: false, bytes };
  const note = `… (fetch the rest: ${where})`;
  if (keep === "tail") {
    let tail = source;
    while (byteLength(`${note}\n${tail}`) > cap && tail.length > 0) {
      tail = tail.slice(Math.max(1, Math.ceil(tail.length / 32)));
    }
    return { text: `${note}\n${tail}`, truncated: true, bytes };
  }
  const lines = source.split(/\r?\n/);
  const render = (kept) => `${lines.slice(0, kept).join("\n").trimEnd()}\n${note}`;
  // The most lines that still fit, by bisection — then snapped BACK to the
  // last heading boundary inside that, so the cut lands between sections
  // rather than mid-thought.
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(render(middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  // A heading at line 0 is the page's own title and heads everything, so
  // snapping to it would leave nothing at all — only a LATER heading is a
  // boundary worth taking.
  const boundary = headings(lines).map((h) => h.index).filter((index) => index > 0 && index <= low).pop();
  return { text: render(boundary ?? low), truncated: true, bytes };
}
