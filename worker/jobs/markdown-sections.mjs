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
//   worker/jobs/weekly.mjs reads the "Outcome" section of an agenda file.
//
// A second parser would let the two disagree about a page written for
// neither of them — and a heading form one side did not recognize was a way
// past the learning step's guard (see headings below).
//
// Plain ESM with no imports, on purpose. worker/ is what is deployed to the
// Jarvis Box and Node there loads no TypeScript; Convex bundles this file into
// a runtime with no filesystem. Neither side can hold the other's language, so
// the shared half is written in the one both can read.

// ── Headings ─────────────────────────────────────────────────────────────────
// CommonMark's two heading forms, and every reader of a page sees both:
//
//   ATX     up to three spaces of indentation, one to six `#`, a space, the
//           text (closing `#`s optional):  `   ## Ideal state`
//   setext  a paragraph line with a line of `=` (level 1) or `-` (level 2)
//           under it, each after up to three spaces:  `Ideal state\n-----`
//
// Recognizing only `#` in column one was a way past the learning step's
// protected-section guard: an indented `   ## Ideal state` was body text to
// the guard, so a `### Training goals` under it sat under nothing, and the
// step could write into a section of Tom's. The guard, the post's reduction
// of an area page, and the capture-triage section all locate sections
// through headings() below, so no form is a heading to one and not another.
//
// Not headings: anything inside a fenced code block — which is opened and
// closed by a run of ONE kind (fenceOf), not by any fence line at all — and
// the frontmatter block at the top of a page, whose closing `---` would
// otherwise read as a setext underline of the last `key: value` line.
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const CLOSING_HASHES = /[ \t]+#+$/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
// A fence line: its run of backticks or tildes, and whatever follows it.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A line a setext underline may head: a paragraph line, which is not blank,
// not a list item, not a block quote, not indented code, not a fence.
const NOT_PARAGRAPH = /^(?:[ \t]*$| {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)| {4,}|\t)/;

function atxText(m) {
  const text = m[2].replace(CLOSING_HASHES, "").trim();
  return /^#+$/.test(text) ? "" : text;
}

/**
 * A fence line as `{ char, length, info }`, or null.
 *
 * A CODE FENCE IS CLOSED ONLY BY ITS OWN KIND (CommonMark 4.5), and this is
 * the whole reason the shape is kept rather than a boolean: a ``` inside a
 * ~~~ block, or the ```` of a nested example inside a ```, is CONTENT. Read
 * as a toggle, each of those flipped the fence state, and from there every
 * heading in the page was inside-out — a `## Ideal state` under a code block
 * read as ordinary text, which is exactly the way past the learning step's
 * guard that headings() exists to close.
 *
 * A closing fence is a run of the same character, at least as long as the
 * opening one, with nothing after it. An opening BACKTICK fence's info string
 * may not contain a backtick (a `` `x` `` in a paragraph is not a fence); a
 * tilde fence's may contain anything.
 */
function fenceOf(line) {
  const m = FENCE.exec(line);
  if (m === null) return null;
  return { char: m[1][0], length: m[1].length, info: m[2] };
}

function opensFence(f) {
  return f.char === "~" || !f.info.includes("`");
}

function closesFence(f, open) {
  return f.char === open.char && f.length >= open.length && f.info.trim() === "";
}

/** The lines the frontmatter block occupies — [0, end] inclusive — or -1. */
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return -1;
  return lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
}

/**
 * Every heading of the page in order: `{ index, level, text, lines }` —
 * `lines` is 1 for an ATX heading and 2 for a setext one, whose underline
 * belongs to it. THE ONE READ every section locator below goes through.
 */
export function headings(lines) {
  const out = [];
  const skipTo = frontmatterEnd(lines);
  let open = null; // the fence currently held open, if any
  for (let i = 0; i < lines.length; i++) {
    if (i <= skipTo) continue;
    const line = lines[i];
    const fence = fenceOf(line);
    if (open !== null) {
      if (fence !== null && closesFence(fence, open)) open = null;
      continue;
    }
    if (fence !== null && opensFence(fence)) {
      open = fence;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ index: i, level: atx[1].length, text: atxText(atx), lines: 1 });
      continue;
    }
    const under = lines[i + 1];
    if (under === undefined || NOT_PARAGRAPH.test(line) || ATX.test(line)) continue;
    // A `---` under a paragraph line is a heading; `- a` above it is a list
    // item, so that `---` is a thematic break and heads nothing.
    if (SETEXT_1.test(under) || SETEXT_2.test(under)) {
      out.push({ index: i, level: SETEXT_1.test(under) ? 1 : 2, text: line.trim(), lines: 2 });
      i += 1;
    }
  }
  return out;
}

/**
 * Where the section headed `heading` (case-insensitive) sits in `lines`: the
 * index of its heading line, the exclusive index where it ends (the next
 * heading of the same or a higher level, or the end of the page), and the
 * heading's level. Null when the page has no such heading. The FIRST match
 * wins, which is what extractSections has always returned. A setext
 * heading's underline is inside its span.
 */
export function sectionSpan(lines, heading) {
  const wanted = String(heading ?? "").trim().toLowerCase();
  const all = headings(lines);
  for (let k = 0; k < all.length; k++) {
    const h = all[k];
    if (h.text.toLowerCase() !== wanted) continue;
    const next = all.slice(k + 1).find((n) => n.level <= h.level);
    return { start: h.index, end: next === undefined ? lines.length : next.index, level: h.level };
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
  const all = headings(lines);
  const own = all.find((h) => index >= h.index && index < h.index + h.lines);
  let level = own ? own.level : 7;
  for (let k = all.length - 1; k >= 0; k--) {
    const h = all[k];
    if (h.index >= index) continue;
    if (h.level < level) {
      out.push(h.text);
      level = h.level;
    }
  }
  return out;
}

/** A section's text without its heading line (either form), for a reader
 * that wants the body alone. */
export function withoutHeading(section) {
  const lines = String(section ?? "").split(/\r?\n/);
  const first = headings(lines).find((h) => h.index === 0);
  return lines.slice(first === undefined ? 0 : first.lines).join("\n");
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

// ── Frontmatter ──────────────────────────────────────────────────────────────
// The same rule as extractSections, for the block at the top of an area page:
// two sides read it (convex/ttsWeekly.ts reads `reviewed:` and the window off
// the body the nightly job posted; worker/jobs/weekly.mjs sets `reviewed:` in
// the checkout when Tom confirms a page) and they must agree on where the
// block is and what a line in it means.

const FRONTMATTER_FENCE = "---";

/** The block itself — the opening fence line through the closing one — or
 * "" when the page does not open with one. What the nightly job keeps ahead
 * of an area page's posted sections. */
export function frontmatterBlock(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return "";
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (end === -1) return "";
  return lines.slice(0, end + 1).join("\n");
}

/**
 * The `key: value` lines between the two `---` fences that open a page, as an
 * object of strings (values trimmed, an empty value ""), and the rest of the
 * page as `body`. A page that does not open with a fence has no fields and is
 * its own body. Only the first fence pair is read; nothing is parsed inside a
 * value.
 */
export function parseFrontmatter(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return { fields: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (end === -1) return { fields: {}, body: text };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/**
 * Whether `s` is a real calendar day spelled YYYY-MM-DD. The regex alone is
 * not enough: Date.parse("2026-02-30") is March 2nd, not NaN, so the check
 * is the round trip — the parsed instant, written back as a UTC date, must
 * be the same ten characters. Both the frontmatter `reviewed:` line
 * (convex/ttsWeekly.ts frontmatterDate) and the weekly job's day arguments
 * (worker/jobs/weekly.mjs isDay) read here.
 */
export function isIsoDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/**
 * The page with `key: value` set in its frontmatter: the existing line
 * replaced in place, a missing key appended before the closing fence, and a
 * page with no frontmatter given one. Everything else is byte-for-byte what
 * it was, so the diff of a `reviewed:` edit is one line.
 */
export function setFrontmatterField(markdown, key, value) {
  const text = String(markdown ?? "");
  const lines = text.split("\n");
  const entry = `${key}: ${value}`;
  const end =
    lines[0]?.trim() === FRONTMATTER_FENCE
      ? lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE)
      : -1;
  if (end === -1) {
    return [FRONTMATTER_FENCE, entry, FRONTMATTER_FENCE, ...lines].join("\n");
  }
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const at = lines.findIndex((l, i) => i > 0 && i < end && pattern.test(l));
  if (at !== -1) lines[at] = entry;
  else lines.splice(end, 0, entry);
  return lines.join("\n");
}
