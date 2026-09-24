// THE ONE HOME for how a reply of Tom's names a model-of-Tom line.
//
// The nightly job (worker/jobs/nightly.mjs) writes each line it puts on a
// page as a "learning-change" row whose id is the first CHANGE_ID_CHARS hex
// characters of a hash; the digest prints the line as `[<id>] file: ...`.
// Tom names the line back by that id — bracketed as printed, or bare, and at
// least CHANGE_ID_MIN_CHARS of it — from two places that must agree:
//
//   convex/ttsSlack.ts, when his reply lands under the digest or an hourly
//     update, writes the "learning-objection" row with the full id;
//   worker/jobs/nightly.mjs, the next night, matches each objection to the
//     change it reverts.
//
// A token is only a name when a recorded change's id starts with it: a commit
// hash printed in the same digest, or a word spelled in hex letters, names
// nothing. Plain ESM with no imports (markdown-sections.mjs's arrangement):
// the box's Node loads no TypeScript and Convex's bundle has no filesystem.

export const CHANGE_ID_CHARS = 12;
export const CHANGE_ID_MIN_CHARS = 8;

const TOKEN = new RegExp(`\\b[0-9a-f]{${CHANGE_ID_MIN_CHARS},${CHANGE_ID_CHARS}}\\b`, "g");

/** Every token in `text` that could name a change, in order. */
export function changeIdTokens(text) {
  return String(text ?? "").match(TOKEN) ?? [];
}

/**
 * The first of `changes` that one of `tokens` names — the change whose id
 * starts with the token, tokens tried in order. Null when none does.
 */
export function namedChange(tokens, changes) {
  for (const token of tokens) {
    if (typeof token !== "string" || token.length < CHANGE_ID_MIN_CHARS) continue;
    const hit = changes.find((c) => typeof c?.id === "string" && c.id.startsWith(token));
    if (hit) return hit;
  }
  return null;
}

/** `text` with every token naming `id` taken out — bracketed or bare — so
 * what is left can be read for what else the reply says. */
export function withoutChangeId(text, id) {
  return String(text ?? "")
    .replace(new RegExp(`\\[?\\b[0-9a-f]{${CHANGE_ID_MIN_CHARS},${CHANGE_ID_CHARS}}\\b\\]?`, "g"), (m) =>
      id.startsWith(m.replace(/[[\]]/g, "")) ? " " : m,
    )
    .replace(/\s+/g, " ")
    .trim();
}
