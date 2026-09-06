// THE ONE HOME for taking a section out of a WikiTom markdown page by its
// heading.
//
// Two sides read the same pages this way and must agree on where a section
// starts and where it stops:
//
//   worker/jobs/nightly.mjs reduces each model-of-tom/areas page to its
//     "Current state" and "Must not break" sections before posting it.
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

/**
 * The sections of a markdown page headed by any of `headings` (case-
 * insensitive), each running from its heading line to the next heading of
 * the same or a higher level, returned in the order of `headings` and joined
 * by a blank line. "" when the page has none of them.
 */
export function extractSections(markdown, headings) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const wanted = headings.map((h) => h.trim().toLowerCase());
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    const key = m[2].trim().toLowerCase();
    if (!wanted.includes(key) || found.has(key)) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = /^(#{1,6})\s+\S/.exec(lines[j]);
      if (n && n[1].length <= level) {
        end = j;
        break;
      }
    }
    found.set(key, lines.slice(i, end).join("\n").trim());
  }
  return wanted
    .filter((k) => found.has(k))
    .map((k) => found.get(k))
    .join("\n\n");
}
