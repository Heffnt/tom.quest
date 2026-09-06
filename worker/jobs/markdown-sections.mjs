// THE ONE HOME for taking a section out of a WikiTom markdown page by its
// heading.
//
// Three sides read the same pages this way and must agree on where a section
// starts and where it stops:
//
//   worker/jobs/nightly.mjs reduces each model-of-tom/areas page to its
//     "Current state" and "Must not break" sections before posting it, and
//     its learning step puts a line INTO a named section (sectionSpan) —
//     and refuses a section it may not write, or one that sits under it
//     (enclosingHeadings).
//   convex/ttsSkills.ts takes the "What becomes a todo" section out of the
//     posted model-of-tom/priorities.md to serve GET /tts/capture-context.
//
// A second parser would let the two disagree about a page written for
// neither of them.
//
// Plain ESM with no imports, on purpose. worker/ is what is deployed to the
// Jarvis Box and Node there loads no TypeScript; Convex bundles this file into
// a runtime with no filesystem. Neither side can hold the other's language, so
// the shared half is written in the one both can read.

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Where the section headed `heading` (case-insensitive) sits in `lines`: the
 * index of its heading line, the exclusive index where it ends (the next
 * heading of the same or a higher level, or the end of the page), and the
 * heading's level. Null when the page has no such heading. The FIRST match
 * wins, which is what extractSections has always returned.
 */
export function sectionSpan(lines, heading) {
  const wanted = String(heading ?? "").trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m || m[2].trim().toLowerCase() !== wanted) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = /^(#{1,6})\s+\S/.exec(lines[j]);
      if (n && n[1].length <= level) {
        end = j;
        break;
      }
    }
    return { start: i, end, level };
  }
  return null;
}

/**
 * The headings that enclose line `index`, nearest first: walking upward,
 * each heading of a higher level than the last one taken. For a heading
 * line, its own heading is not included — only what it sits under. The
 * learning step refuses a section that sits under one of Tom's, however it
 * is named itself.
 */
export function enclosingHeadings(lines, index) {
  const out = [];
  const own = HEADING.exec(lines[index] ?? "");
  let level = own ? own[1].length : 7;
  for (let i = index - 1; i >= 0; i--) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length < level) {
      out.push(m[2].trim());
      level = m[1].length;
    }
  }
  return out;
}

/**
 * The sections of a markdown page headed by any of `headings` (case-
 * insensitive), each running from its heading line to the next heading of
 * the same or a higher level, returned in the order of `headings` and joined
 * by a blank line. "" when the page has none of them.
 */
export function extractSections(markdown, headings) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const found = [];
  const seen = new Set();
  for (const heading of headings) {
    const key = String(heading).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const span = sectionSpan(lines, heading);
    if (span === null) continue;
    found.push(lines.slice(span.start, span.end).join("\n").trim());
  }
  return found.join("\n\n");
}
