#!/usr/bin/env node
// check-writing-standard.mjs — how many stored briefs and ground-up
// explanations fail WRITING_STANDARD, and which ones.
//
//   node scripts/check-writing-standard.mjs           # report + ratchet gate
//   node scripts/check-writing-standard.mjs --list     # name every failure
//
// WHY THIS EXISTS. Tom ruled 2026-08-30 that the brief rewrite fixes the major
// failures now and the REMAINDER is carried as dated ledger debt, never a
// silent cutoff and never a frozen exemption (vqc/adoption.md, ratchet
// adoption). A ledger entry alone cannot enforce that: "the remainder gets
// fixed eventually" is only true if the number is visible and can only go
// down. This script is that number.
//
// BOTH HALVES ARE INSPECTED, because the graduation condition the ledger rung
// carries names both — "no stored brief or groundUpExplanation fails
// WRITING_STANDARD" (vqc/adoption.md). Until 2026-09-01 this script filtered
// on groundUpExplanation alone and reported only explanations, so the ratchet
// could have graduated the rung on evidence that never looked at a brief. It
// now walks both fields and prints a line per field, and the number the
// ratchet gates on is the sum. The brief line reports 0 rules applied, and
// that zero is the finding rather than an omission: see BRIEF_RULES.
//
// THE RATCHET. The script exits non-zero when the live count EXCEEDS BASELINE
// — so new prose written to no standard fails loudly — and prints a nudge when
// the count has dropped, because lowering BASELINE in the same commit as the
// work is how the ratchet tightens. BASELINE reached 0 on the day this was
// written (see the constant), so the ratchet is now a floor: it holds the line
// rather than working a backlog down.
//
// NOT A CI GATE, on purpose: it reads PROD Convex over the network and needs
// TTS_WORKER_KEY, which CI does not hold. It is a reporting rung, run on
// demand and before touching prose in bulk. Everything it checks is a
// MECHANICAL rule of the standard — the semantic ones ("defines every term at
// first use", "describes an artifact before naming it") are not scriptable,
// and this script never claims a passing document is well written. The rule
// LOGIC is covered by scripts/check-writing-standard.test.mjs, which runs
// under `pnpm test` without touching the network.

import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = process.env.CONVEX_SITE_URL;
const KEY = process.env.TTS_WORKER_KEY;

// ZERO, and it stays zero. It was 40 of 77 when this script was written on
// 2026-08-30 — every one a `source: "migration"` row predating the ratified
// HTML-document form, so every one was markdown rendering as the wall of text
// the rule exists to prevent. All 40 were rewritten the same day and the
// ledger entry carrying them (writing-standard-remainder) graduated with the
// work, which is what lowering this constant to 0 records.
//
// Raising it is not a fix. A failing count means prose was written to no
// standard; the answer is to rewrite that prose, not to move the line.
const BASELINE = 0;

// ── What text a rule reads ───────────────────────────────────────────────────
// A rule that bans a construct has to look at the place the construct would
// actually DO something, or it fires on the document that merely names it. The
// ground-up explanation of todo ph791scq7np10abq9ge22h7p7s8df3vc — the todo
// that ordered this script — is the case: it lists the rules it obeys, writing
// "no <code>@import</code>", and the css-import rule matched its own name and
// failed the document. Three views of the same document fix that.

/** Every <code>/<pre>/<samp>/<kbd> element with its TEXT emptied out and its
 *  start tag kept. Text inside these elements is quoted, not executed, so an
 *  attribute-shaped or CSS-shaped string in there is a mention. Keeping the
 *  start tag means the element's own attributes are still read — a real
 *  `<code onclick="...">` is still a violation. */
function proseView(s) {
  return s.replace(
    /(<(code|pre|samp|kbd)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi,
    (_m, open, _tag, close) => open + close,
  );
}

/** Only the text inside <style> blocks — the one place an @import loads
 *  anything. */
function styleView(s) {
  return [...s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
    .map((m) => m[1])
    .join("\n");
}

// The mechanically checkable half of "A GROUND-UP EXPLANATION IS A COMPLETE
// HTML DOCUMENT" (convex/ttsShared.ts, WRITING_STANDARD). Each rule is one the
// standard states in so many words; nothing here is invented. `on` names which
// view above the rule reads, and every choice other than the whole document
// carries its reason.
const RULES = [
  {
    id: "no-doctype",
    on: "document",
    why: "must open at <!DOCTYPE html>",
    fails: (s) => !s.toLowerCase().startsWith("<!doctype html"),
  },
  {
    id: "no-close-html",
    on: "document",
    why: "must close at </html>",
    fails: (s) => !s.toLowerCase().endsWith("</html>"),
  },
  {
    id: "no-h1",
    on: "document",
    why: "must carry one <h1> naming the subject",
    fails: (s) => !/<h1[\s>]/i.test(s),
  },
  {
    id: "no-style",
    on: "document",
    why: "must carry one inline <style> block in the <head>",
    fails: (s) => !/<style[\s>]/i.test(s),
  },
  {
    // DELIBERATELY the whole document, including inside <code>. The HTML
    // parser does not care that a tag sits inside a <code> element: an
    // unescaped <script> in there is a real script element and really runs.
    // Quoting the rule in prose means writing &lt;script&gt;, which this
    // pattern never matched, so the document that names the rule already
    // passes and there is nothing to narrow.
    id: "script",
    on: "document",
    why: "renders in a sandbox with no scripting — no <script>",
    fails: (s) => /<script[\s>]/i.test(s),
  },
  {
    // An `onclick="…"` is an event handler only where an HTML parser reads it
    // as an attribute. The same characters as TEXT inside <code> are a
    // mention, so this reads the prose view.
    id: "inline-handler",
    on: "prose",
    why: "no inline event handlers (onclick=, onload=, …)",
    fails: (s) => /\son[a-z]+\s*=\s*["']/i.test(s),
  },
  {
    // Whole document, for the same reason as `script`: an unescaped <link>
    // inside <code> is a real <link> and really loads.
    id: "external-stylesheet",
    on: "document",
    why: "nothing loads from outside — no <link rel=stylesheet>",
    fails: (s) => /<link[^>]+stylesheet/i.test(s),
  },
  {
    // @import loads a stylesheet only inside a <style> block (or a stylesheet
    // this document cannot have). Anywhere else in the document the eight
    // characters are just eight characters.
    id: "css-import",
    on: "style",
    why: "nothing loads from outside — no @import inside <style>",
    fails: (s) => /@import/i.test(s),
  },
  {
    // An address fetches something only when it is the value of a real src= or
    // href= attribute, so this reads the prose view too.
    id: "external-url",
    on: "prose",
    why: "no external font, image, or URL of any kind",
    fails: (s) => /(?:src|href)\s*=\s*["']?https?:/i.test(s),
  },
];

// The mechanical rules that bind a STORED BRIEF: none, and the emptiness is a
// measurement rather than a gap. A brief is markdown by construction
// (convex/schema.ts, `brief: v.optional(v.string()), // ground-up brief,
// markdown`), and every rule in RULES above is a rule of the HTML-document
// FORM, which WRITING_STANDARD attaches to a ground-up explanation and to
// nothing else. The standard's remaining demands on a brief — defines every
// term at first use, no invented names, no load-bearing analogies, descriptive
// never evaluative — are semantic, and this script does not claim to check
// semantics for either field. Briefs are still walked and still counted so the
// report states what was inspected, and so a rule added here lands in the same
// ratchet number as the explanation rules.
const BRIEF_RULES = [];

/** The rule ids `html` breaks, given a rule set. */
export function failuresFor(html, rules = RULES) {
  const document = html.trim();
  const views = {
    document,
    prose: proseView(document),
    style: styleView(document),
  };
  return rules.filter((r) => r.fails(views[r.on ?? "document"])).map((r) => r.id);
}

export { RULES, BRIEF_RULES, proseView, styleView };

/** One field of the corpus: which todos carry it, which of those fail, and the
 *  per-rule tally. */
function gradeField(todos, field, rules) {
  const carrying = todos.filter((t) => t[field]);
  const failing = [];
  const byRule = new Map();
  for (const t of carrying) {
    const ids = failuresFor(t[field], rules);
    if (ids.length === 0) continue;
    failing.push({ id: t._id, statement: t.statement, field, rules: ids });
    for (const id of ids) byRule.set(id, (byRule.get(id) ?? 0) + 1);
  }
  return { carrying: carrying.length, failing, byRule, rules };
}

function report(label, graded, note) {
  console.log(
    `${label}: ${graded.failing.length} of ${graded.carrying} fail WRITING_STANDARD` +
      (note ? ` (${note})` : ""),
  );
  for (const [id, n] of [...graded.byRule].sort((a, b) => b[1] - a[1])) {
    const rule = graded.rules.find((r) => r.id === id);
    console.log(`  ${String(n).padStart(4)}  ${id} — ${rule.why}`);
  }
}

async function main() {
  if (!SITE || !KEY) {
    console.error(
      "check-writing-standard: CONVEX_SITE_URL and TTS_WORKER_KEY must be set " +
        "(this rung reads prod Convex; it is not a CI gate).",
    );
    process.exit(2);
  }
  const res = await fetch(`${SITE.replace(/\/+$/, "")}/tts/state`, {
    headers: { "X-TTS-Key": KEY },
  });
  if (!res.ok) {
    console.error(`check-writing-standard: /tts/state -> HTTP ${res.status}`);
    process.exit(2);
  }
  const { todos } = await res.json();

  const explanations = gradeField(todos, "groundUpExplanation", RULES);
  const briefs = gradeField(todos, "brief", BRIEF_RULES);
  const failing = [...explanations.failing, ...briefs.failing];

  report("ground-up explanations", explanations);
  report(
    "stored briefs",
    briefs,
    `${BRIEF_RULES.length} mechanical rules bind a markdown brief`,
  );

  if (process.argv.includes("--list")) {
    for (const f of failing) {
      console.log(
        `  ${f.id}  ${f.field}  [${f.rules.join(",")}]  ${f.statement.slice(0, 70)}`,
      );
    }
  }

  if (failing.length > BASELINE) {
    console.error(
      `\nFAILED: ${failing.length} failing across both fields, baseline is ` +
        `${BASELINE}. Prose written to no standard has been added. Fix it, or ` +
        `state why the baseline moves.`,
    );
    process.exit(1);
  }
  if (failing.length < BASELINE) {
    console.log(
      `\nThe number went down (${BASELINE} -> ${failing.length}). Lower BASELINE in ` +
        `this script in the same commit as the work — that is how the ratchet tightens.`,
    );
  }
  if (failing.length === 0) {
    console.log("\nNothing fails.");
  }
}

// Only when run as a command. Imported (by the test beside it) this file is
// just the rules.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`check-writing-standard: ${err.message}`);
    process.exit(2);
  });
}
