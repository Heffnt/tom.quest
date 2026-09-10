// learning-ground.mjs — the deterministic ground signal.
//
// model-of-tom/ground.md says what Tom knows and what he does not. The model
// cannot be trusted to decide, from a turn, that he now knows something: an
// agent that has just explained a term reads its own explanation as evidence.
// His rule is explicit, in his words:
//
//   "agents should not assume that i have learned something just because they
//    have explained it to me once. they should wait for my explicit
//    confirmation before assuming I understand something enough for it to be
//    recorded in my ground."
//
// So the SIGNAL is detected here, in code, over Tom's own sentences and
// nothing else, and the model only says which term and which line. A change to
// ground.md that names no signal is refused (nightly.mjs learningRefusal),
// which makes "never move a term to Knows on inference" a property of the code
// rather than a sentence in a prompt the model may read past.
//
// THERE IS NO PATTERN FOR TOM MERELY USING A TERM. Fluent use is not
// confirmation — a turn full of AUROC, residual stream and git rebase in
// ordinary use produces nothing at all, and the tests assert it.
//
// Plain ESM, no imports: worker/ runs on the Jarvis Box where Node loads no
// TypeScript.

export const GROUND_FILE = "model-of-tom/ground.md";
export const GROUND_SIGNAL_KINDS = ["asked", "confirmed", "partial"];
export const GROUND_SIGNALS_MAX = 40;
export const GROUND_TERM_CHARS = 80;

/**
 * The sections of ground.md a change may name, by the kind of signal it cites
 * AND what it does there. A term he ASKED about is added under "Does not
 * know"; the same signal may NARROW a line already under any of the three
 * (a replace), because a question about part of a term says the rest still
 * stands. A term he CONFIRMED is added under "Knows" and leaves "Does not
 * know"; a PARTIAL confirmation lands under "Follows, without the details"
 * instead.
 *
 * "How to explain" takes a change from any kind, and from none when the
 * change is inferred — it is a rule about writing, not a claim about a term.
 */
export const GROUND_SECTIONS = {
  asked: {
    add: ["Does not know"],
    replace: ["Does not know", "Knows", "Follows, without the details"],
    remove: ["Does not know"],
  },
  confirmed: {
    add: ["Knows"],
    replace: ["Knows", "Does not know"],
    remove: ["Does not know"],
  },
  partial: {
    add: ["Follows, without the details"],
    replace: ["Follows, without the details", "Does not know"],
    remove: ["Does not know"],
  },
};
/** The two sections a line may not reach on inference: each carries a `said`
 * entry or it is refused (§2.5). */
export const GROUND_CONFIRMED_SECTIONS = ["Knows", "Follows, without the details"];
export const GROUND_FREE_SECTION = "How to explain";

// A term that names nothing: the sentence matched, but the group it caught is
// a pronoun or a stock phrase, so the signal would say only that he asked
// about something.
const STOP_TERMS = new Set([
  "it",
  "this",
  "that",
  "them",
  "you",
  "me",
  "the difference",
  "the point",
  "what you mean",
  "why",
]);

// ── A. asked → "Does not know" ───────────────────────────────────────────────
// The NEGATION FAMILY IS TESTED FIRST so "i don't understand X" can never
// reach the confirm family, and "that is not a term I recognize, and I am
// intimately familiar with CMT" is an ask rather than a confirmation.
const ASKED = [
  /^\s*(?:so\s+)?wh?at(?:'s|s| is| are| does| do you mean by)\s+(.+?)\s*\??$/,
  /\bi\s+(?:do\s?n[o']?t|dont|don't|never)\s+(?:really\s+)?(?:understand|know|get|follow|recognize|recognise)\s+(.+?)\s*[.?!]?$/,
  /\bi(?:'ve|\s+have)\s+never\s+heard\s+of\s+(.+?)(?:\s+before)?\s*[.?!]?$/,
  /\b(?:no\s+idea|not\s+sure)\s+what\s+(.+?)\s+(?:is|are|means?)\b/,
  /\b(?:explain|define)\s+(.+?)\s+(?:to\s+me|as\s+you\s+introduce)\b/,
  /\bwhat\s+does\s+(.+?)\s+mean\b/,
  // A7 catches no term: the sentence itself is the signal, and the term comes
  // from the model reading it.
  /\b(?:that|this)\s+is\s+not\s+a\s+term\s+i\s+recognize\b/,
  /\bi[' ]?m\s+not\s+(?:very\s+)?familiar\s+with\s+(.+?)\s*[.?!]?$/,
];

// ── B. confirmed → "Knows" ───────────────────────────────────────────────────
// B5 is tried FIRST: it names the thing he confirmed ("the vocab you
// defined") where B1's open capture would take the rest of the sentence with
// it ("the vocab you defined so use that and other standard cmt language").
// Specific before general, which is the only ordering that makes the term
// usable.
const CONFIRMED = [
  /\bi\s+(?:understand|know)\s+(the\s+.+?\s+(?:you\s+defined|vocab))\b/,
  /\bi\s+(?:understand|know)\s+(.+?)\s*[.?!]?$/,
  /\bi[' ]?m\s+(?:deeply\s+|intimately\s+|very\s+)?familiar\s+with\s+(.+?)\s*[.?!]?$/,
  /\bi[' ]?m\s+an?\s+expert\s+(?:in|at|on)\s+(.+?)\s*[.?!]?$/,
  /\bi\s+have\s+(?:a\s+)?(?:deep|strong|proficient|good)\s+(?:and\s+\w+\s+)?(?:intuitive\s+)?(?:understanding|intuition)\s+(?:of|on|for)\s+(.+?)\s*[.?!]?$/,
];

// ── C. partial → "Follows, without the details" ──────────────────────────────
// C DOWNGRADES B: a confirmation hedged in the same sentence, or in the one
// straight after it in the same turn, is emitted ONCE with kind "partial".
const PARTIAL = [
  /\bbut\b.*\b(?:not\s+fluent|not\s+the\s+details|dont?\s+know\s+all|might\s+not\s+know|glazed?\s+over|broad\s+strokes|intuitively|high\s+level|vague)\b/,
  /\bintuitively\b/,
  /\bwithout\s+(?:all\s+)?the\s+(?:technical\s+)?details\b/,
];

/** The sentences of one text, original casing kept: split after `.`, `?`, `!`
 * or a newline. */
export function sentencesOf(text) {
  return String(text ?? "")
    .split(/(?<=[.?!\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// A term never spans a clause boundary. "arity and function structure, but
// tell me more about sampling geometry" names one thing he confirmed and one
// he asked about, and only the first is the term of THIS signal.
const CLAUSE_BREAK = /,|\s+but\s+|\s+so\s+use\s+|\s+however\s+/;
// A capture that opens with an interrogative is a clause, not a term: "i dont
// know what to do about it" names nothing to record under "Does not know".
const INTERROGATIVE = /^(?:what|why|how|whether|when|where|who|if)\b/;

/**
 * The term a pattern caught, made usable: a trailing "?", a leading article,
 * surrounding backticks or quotes, and a trailing copula all go; the clause
 * is cut at its first boundary and whitespace collapses. Null when what is
 * left is empty, longer than GROUND_TERM_CHARS, opens with an interrogative,
 * or is one of the stop terms — a signal whose term names nothing is no
 * signal.
 */
export function cleanTerm(raw) {
  const term = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(CLAUSE_BREAK)[0]
    .replace(/[?!.]+$/, "")
    .replace(/^["'`“”‘’]+/, "")
    .replace(/["'`“”‘’]+$/, "")
    .replace(/^(?:an?|the)\s+/i, "")
    .replace(/\s+(?:is|are|mean|means)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (term === "" || term.length > GROUND_TERM_CHARS) return null;
  if (STOP_TERMS.has(term) || INTERROGATIVE.test(term)) return null;
  return term;
}

/** The signal one sentence carries, or null. `next` is the sentence after it
 * in the same turn, which can downgrade a confirmation to a partial. */
export function sentenceSignal(sentence, next = "") {
  const text = String(sentence ?? "");
  const lower = text.toLowerCase();
  for (const pattern of ASKED) {
    const m = pattern.exec(lower);
    if (m === null) continue;
    // A7 has no capture group: the sentence is the signal, the term is the
    // model's to name.
    const term = m[1] === undefined ? null : cleanTerm(m[1]);
    if (m[1] !== undefined && term === null) continue;
    return { kind: "asked", term, quote: text };
  }
  for (const pattern of CONFIRMED) {
    const m = pattern.exec(lower);
    if (m === null) continue;
    const term = cleanTerm(m[1]);
    if (term === null) continue;
    const hedged = PARTIAL.some((p) => p.test(lower) || p.test(String(next ?? "").toLowerCase()));
    return { kind: hedged ? "partial" : "confirmed", term, quote: text };
  }
  return null;
}

/**
 * Tonight's ground signals, deterministically, from TOM'S WORDS ONLY: the
 * turns he typed, his threaded Slack replies and his rulings' sentences. The
 * agent's text around a turn is never scanned — an agent that explained a term
 * would otherwise confirm it on his behalf.
 *
 * `[{id, kind, term, source, date, quote}]`, newest first, at most `max`.
 * `quote` is the matched sentence of his, verbatim, which is what a `said:`
 * entry on a ground line must contain (nightly.mjs's ground guard).
 */
export function groundSignals(input, { max = GROUND_SIGNALS_MAX, cite, day } = {}) {
  const citation = cite ?? ((t) => `session ${t.sessionId}`);
  const dayOf = day ?? ((at) => new Date(at).toISOString().slice(0, 10));
  const sources = [];
  for (const t of input?.tomTurns ?? []) {
    sources.push({ text: t.text, source: citation(t), at: t.at });
  }
  for (const r of input?.slackReplies ?? []) {
    const ts = r?.data?.ts ?? r?.data?.threadTs;
    if (typeof ts === "string" && ts !== "") {
      sources.push({ text: r?.data?.text, source: `thread ${ts}`, at: r.at });
    }
  }
  for (const r of input?.rulings ?? []) {
    sources.push({ text: r?.sentence, source: `ruling ${r.id}`, at: r.at });
  }
  const found = [];
  for (const s of sources) {
    const sentences = sentencesOf(s.text);
    for (let i = 0; i < sentences.length; i++) {
      const signal = sentenceSignal(sentences[i], sentences[i + 1] ?? "");
      if (signal === null) continue;
      found.push({ ...signal, source: s.source, date: dayOf(s.at), at: s.at ?? 0 });
    }
  }
  // Newest first, then numbered in that order: g-1 is the newest signal of the
  // night, which is the one the model reads first.
  found.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const kept = found.slice(0, Math.max(0, max));
  return {
    signals: kept.map((s, i) => ({
      id: `g-${i + 1}`,
      kind: s.kind,
      term: s.term,
      source: s.source,
      date: s.date,
      quote: s.quote,
    })),
    dropped: found.length - kept.length,
  };
}

/** Whether `section` follows from a signal of `kind` under operation `op`. */
export function groundSectionFollows(kind, section, op = "add") {
  const name = String(section ?? "").trim().toLowerCase();
  if (name === GROUND_FREE_SECTION.toLowerCase()) return true;
  return ((GROUND_SECTIONS[kind] ?? {})[op] ?? []).some((s) => s.toLowerCase() === name);
}

/** Whether `section` is one no line may reach on inference. */
export function isGroundConfirmedSection(section) {
  const name = String(section ?? "").trim().toLowerCase();
  return GROUND_CONFIRMED_SECTIONS.some((s) => s.toLowerCase() === name);
}
