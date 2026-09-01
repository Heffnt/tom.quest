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
// and this script never claims a passing document is well written.
//
// ONE OF THOSE SEMANTIC RULES NOW HAS ITS OWN RUNG. Since 2026-09-01,
// scripts/check-undescribed-artifacts.mjs (`pnpm check:artifacts`) reports the
// units that name an artifact — a file, a branch, a job — and never say what it
// is, which was the single defect behind roughly 86% of the graded failures. It
// is a keyword proxy for that one rule, not a second opinion on this one, and it
// covers three corpora this script does not read: batch ground-up explanations,
// code briefs, and the `brief` field of every life todo.

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
// (Zero of 372 stored briefs fail — briefs are markdown by design and no
// mechanical rule of the standard binds them.)
const BASELINE = 0;

// The mechanically checkable half of "A GROUND-UP EXPLANATION IS A COMPLETE
// HTML DOCUMENT" (convex/ttsShared.ts, WRITING_STANDARD). Each rule is one the
// standard states in so many words; nothing here is invented.
const RULES = [
  {
    id: "no-doctype",
    why: "must open at <!DOCTYPE html>",
    fails: (s) => !s.toLowerCase().startsWith("<!doctype html"),
  },
  {
    id: "no-close-html",
    why: "must close at </html>",
    fails: (s) => !s.toLowerCase().endsWith("</html>"),
  },
  {
    id: "no-h1",
    why: "must carry one <h1> naming the subject",
    fails: (s) => !/<h1[\s>]/i.test(s),
  },
  {
    id: "no-style",
    why: "must carry one inline <style> block in the <head>",
    fails: (s) => !/<style[\s>]/i.test(s),
  },
  {
    id: "script",
    why: "renders in a sandbox with no scripting — no <script>",
    fails: (s) => /<script[\s>]/i.test(s),
  },
  {
    id: "inline-handler",
    why: "no inline event handlers (onclick=, onload=, …)",
    fails: (s) => /\son[a-z]+\s*=\s*["']/i.test(s),
  },
  {
    id: "external-stylesheet",
    why: "nothing loads from outside — no <link rel=stylesheet>",
    fails: (s) => /<link[^>]+stylesheet/i.test(s),
  },
  {
    id: "css-import",
    why: "nothing loads from outside — no @import",
    fails: (s) => /@import/i.test(s),
  },
  {
    id: "external-url",
    why: "no external font, image, or URL of any kind",
    fails: (s) => /(?:src|href)\s*=\s*["']?https?:/i.test(s),
  },
];

function failuresFor(html) {
  const s = html.trim();
  return RULES.filter((r) => r.fails(s)).map((r) => r.id);
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

  const withExplanation = todos.filter((t) => t.groundUpExplanation);
  const failing = [];
  const byRule = new Map();
  for (const t of withExplanation) {
    const ids = failuresFor(t.groundUpExplanation);
    if (ids.length === 0) continue;
    failing.push({ id: t._id, statement: t.statement, rules: ids });
    for (const id of ids) byRule.set(id, (byRule.get(id) ?? 0) + 1);
  }

  console.log(
    `ground-up explanations: ${failing.length} of ${withExplanation.length} fail WRITING_STANDARD`,
  );
  for (const [id, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    const rule = RULES.find((r) => r.id === id);
    console.log(`  ${String(n).padStart(4)}  ${id} — ${rule.why}`);
  }
  if (process.argv.includes("--list")) {
    for (const f of failing) {
      console.log(`  ${f.id}  [${f.rules.join(",")}]  ${f.statement.slice(0, 70)}`);
    }
  }

  if (failing.length > BASELINE) {
    console.error(
      `\nFAILED: ${failing.length} failing, baseline is ${BASELINE}. Prose written ` +
        `to no standard has been added. Fix it, or state why the baseline moves.`,
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
    console.log("Nothing fails.");
  }
}

main().catch((err) => {
  console.error(`check-writing-standard: ${err.message}`);
  process.exit(2);
});
