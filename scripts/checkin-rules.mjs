// checkin-rules.mjs — the form rules a runner's check-in must pass.
//
// A CHECK-IN IS NOT A BRIEF. BRIEF_RULES in check-writing-standard.mjs refuse
// any heading and any numbered list, and a check-in that requests a ruling has
// both: the rulings go as a numbered list under one "Rulings requested"
// heading, which is the form his rulings are asked in. So these are a second
// array, and BRIEF_RULES keep their meaning.
//
// DEPENDENCY-FREE ON PURPOSE. Three readers: check-writing-standard.mjs
// re-exports these so its failuresFor reads them like every other rule set;
// worker/bin/tts-runner-step runs them before the judge; and the Convex record
// (convex/ttsRunners.ts) runs them again at the door, so a forged pass on a
// malformed check-in is caught where it lands. Convex cannot import a module
// that imports node builtins, which check-writing-standard.mjs does.
//
// Each rule has the { id, on, why, fails } shape of the rules beside BRIEF_RULES;
// every one reads the whole trimmed text ("document").

export const CHECKIN_MAX_CHARS = 1500;

/** The one heading a check-in may carry, and the only place a numbered list
 *  may stand. */
export const RULINGS_HEADING = "Rulings requested";

const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
// A Markdown table row. His writing standard puts enumerable facts in tables,
// and a row is not a sentence, so the sentence rule reads past it.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const NUMBERED = /^ {0,3}\d+[.)]\s/;
// A line ends as a sentence when its last word is followed by a terminator,
// allowing closing quotes, brackets and emphasis after it.
const SENTENCE_END = /[.!?]["'”’)\]*_`]*$/;
// A coined label is a short capitalised phrase standing in for a sentence:
// "Status: green", "**Next step:** look again". A heading is not one.
const LABEL = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?[A-Z][A-Za-z0-9 /-]{0,30}(?:\*\*|__)?:(?:\*\*|__)?(?:\s|$)/;

function lines(text) {
  return text.split(/\r?\n/).map((line) => line.trimEnd());
}

function headings(text) {
  return lines(text).map((line) => HEADING.exec(line)).filter(Boolean).map((match) => match[1]);
}

export const CHECKIN_RULES = Object.freeze([
  {
    id: "checkin-sentences",
    on: "document",
    why: "every line ends as a sentence, except a heading or a table row",
    fails: (s) => lines(s).some((line) => line.trim() !== "" && !HEADING.test(line) && !TABLE_ROW.test(line) && !SENTENCE_END.test(line.trim())),
  },
  {
    id: "checkin-ellipsis",
    on: "document",
    why: "no … or ... — a sentence he has to open the page to finish",
    fails: (s) => /…|\.\.\./.test(s),
  },
  {
    id: "checkin-fence",
    on: "document",
    why: "no code fence",
    fails: (s) => /```|~~~/.test(s),
  },
  {
    id: "checkin-heading",
    on: "document",
    why: `at most one heading, and it is "${RULINGS_HEADING}"`,
    fails: (s) => {
      const found = headings(s);
      return found.length > 1 || found.some((text) => text !== RULINGS_HEADING);
    },
  },
  {
    id: "checkin-numbered",
    on: "document",
    why: `a numbered list stands only under the "${RULINGS_HEADING}" heading`,
    fails: (s) => {
      let under = false;
      for (const line of lines(s)) {
        const heading = HEADING.exec(line);
        if (heading) { under = heading[1] === RULINGS_HEADING; continue; }
        if (NUMBERED.test(line) && !under) return true;
      }
      return false;
    },
  },
  {
    id: "checkin-label",
    on: "document",
    why: "no coined label standing in for a sentence",
    fails: (s) => lines(s).some((line) => !HEADING.test(line) && LABEL.test(line)),
  },
  {
    id: "checkin-length",
    on: "document",
    why: `must be at most ${CHECKIN_MAX_CHARS} characters`,
    fails: (s) => s.length > CHECKIN_MAX_CHARS,
  },
]);

/** The rule ids a check-in breaks, and each rule's reason, in rule order. */
export function checkInFailures(text) {
  const document = String(text ?? "").trim();
  if (document === "") return [{ id: "checkin-empty", why: "a check-in says what the step saw and did" }];
  return CHECKIN_RULES.filter((rule) => rule.fails(document)).map((rule) => ({ id: rule.id, why: rule.why }));
}
