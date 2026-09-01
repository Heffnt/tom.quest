#!/usr/bin/env node
// check-undescribed-artifacts.mjs — how many stored briefs and ground-up
// explanations name an artifact they never describe, and which ones.
//
//   node scripts/check-undescribed-artifacts.mjs          # report + ratchet gate
//   node scripts/check-undescribed-artifacts.mjs --list   # name every offender
//   node scripts/check-undescribed-artifacts.mjs --json    # machine-readable list
//
// WHY THIS EXISTS. WRITING_STANDARD (convex/ttsShared.ts) states one rule
// about artifacts: "Assume the reader has no memory of any prior session and
// no knowledge of anything an agent made — files, branches, directories, jobs,
// and artifacts an agent created are unknown to him by name and must be
// described before they are used." A grading pass of the stored prose found
// that the single defect of naming an artifact and never saying what it is sits
// behind roughly 86% of all writing-standard failures. scripts/check-writing-
// standard.mjs cannot see this defect: it checks the FORM of a ground-up
// explanation (a complete HTML document, nothing loaded from outside) and says
// in its own header that "describes an artifact before naming it" is not
// scriptable. This script is the closest mechanical rung to that rule, and it
// is what turns the sweep of that defect into a number that can only go down.
//
// WHAT IT ACTUALLY MEASURES, stated plainly so nobody reads more into a green
// run than is there. For each stored unit — one brief, or one ground-up
// explanation with its markup stripped — it finds every ARTIFACT TOKEN: a file
// path, a bare file name with a source-code extension, a path under a known
// top-level directory of one of the repositories, a git branch name, or a
// Convex function reference. For the FIRST occurrence of each distinct token
// it reads a window of 180 characters before and 100 after and asks whether any
// DESCRIPTOR WORD appears in it — "file", "script", "branch", "directory",
// "job", "table", "test", "holds", "records", and the rest of the list below.
// A token with no descriptor in its window is reported as undescribed.
//
// That rule is a PROXY, not the rule itself, and it is wrong in both
// directions. "The file `convex/tts.ts`" passes without saying what the file
// does, and a description written three sentences earlier reads as a failure.
// It is still worth having: every real instance of the defect trips it, so
// working the list to zero forces a human or agent read of every place the
// defect can live. A passing run never means the prose is well written.
//
// WHAT IT READS. One request to GET /tts/batch-context, the endpoint that
// already serves every stored prose corpus in one payload, so nothing is
// silently out of scope: the `brief` and the `groundUpExplanation` on each life
// todo, the `groundUpExplanation` on each batch (a batch is the row holding how
// a set of todos gets completed), and each row of `briefs`, the code briefs the
// worker prepares for an open pull request. scripts/check-writing-standard.mjs
// reads only GET /tts/state, which carries the todos alone — so batch pages and
// code briefs are outside that script's count and inside this one's.
//
// NOT A CI GATE, for the same reason as check-writing-standard.mjs: it reads
// PROD Convex over the network and needs TTS_WORKER_KEY, which CI does not
// hold. Run it on demand, and before and after touching stored prose in bulk.

const SITE = process.env.CONVEX_SITE_URL;
const KEY = process.env.TTS_WORKER_KEY;

// THE RATCHET. The script exits non-zero when the live count EXCEEDS BASELINE,
// so prose that names an artifact without describing it fails loudly when it is
// added. When the count drops, lower this constant in the same commit as the
// work — that is the whole mechanism, and it is the same one
// scripts/check-writing-standard.mjs uses.
//
// It was 190 of 891 units (371 undescribed mentions) on 2026-09-01, measured on
// this script's final rules just before the sweep of that defect ran. The sweep
// worked 182 units through the pens — one agent per eight units, each verifying
// what the artifact is by opening it in a checkout of the repository that holds
// it, then inserting the identifying clause and changing nothing else — and 153
// of them took an edit. That left the 80 below, in four groups:
//
//   38  a reading agent judged the name already described where it is first
//       used, so the keyword rule below is what is wrong, not the prose
//   33  edited, and still tripping on a LATER bare re-mention of a name the
//       insert described at its first occurrence
//    4  ground-up explanations on BATCH rows: no agent pen writes one.
//       POST /tts/batches replaces a batch's membership and plan wholesale, so
//       correcting its prose that way would rewrite structure the planner owns
//    4  todo rows carrying `members` (the v1 batch shape). internalPrepareTodo
//       skips brief and groundUpExplanation on those rows by design and logs a
//       prepare-skipped-batch event instead
//    1  a ground-up explanation another session rewrote mid-sweep, left alone
//
// Raising it is not a fix: a rising count means an artifact was named to a
// reader who cannot identify it.
const BASELINE = 80;

// ── What counts as naming an artifact ───────────────────────────────────────
// Extensions of the source files these repositories actually hold. A token is
// only an artifact token if it carries one of these, sits under a known
// top-level directory, or is a branch or Convex function reference.
const EXT =
  "ts|tsx|mjs|cjs|js|jsx|py|md|ya?ml|json|sh|html|css|toml|ipynb|npz|pt|csv|sql";

// The top-level directories of the three repositories a session may check out
// (tom.quest, ComplexMultiTrigger, WikiTom). A path starting at one of these is
// an artifact even when it names a directory rather than a file.
const TOPDIR =
  "convex|app|scripts|worker|vqc|tests|tools|cmt|dev|sweeps|turing-api|e2e|secrets|model-of-tom|wiki|todo|daily|research|sources|code|dts|src|lib|public|\\.claude|\\.github";

// Names that match the patterns below and are not artifacts anyone made here.
// Two kinds, both found by reading what the check reported on the stored prose:
// third-party software whose name ends in ".js", and the method call
// `res.json()` on an HTTP response, which reads as a JSON file name. The rule
// the standard states is about things AN AGENT MADE, so a public library Tom
// already knows by name is out of scope by construction.
const NOT_ARTIFACTS =
  /^(?:next|node|xterm|d3|three|chart|vue|express|react)\.js$|^(?:res|response|request|req|body)\.json$/i;

const PATTERNS = [
  // A path with a file extension: cmt/sweep/runner.py, app/tts/lib.ts.
  new RegExp(`\\b(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+\\.(?:${EXT})\\b`, "g"),
  // A path under a known top-level directory, file or directory: cmt/methods/.
  new RegExp(`\\b(?:${TOPDIR})\\/[A-Za-z0-9_./-]+`, "g"),
  // A bare file name: runner.py, AGENTS.md, package.json.
  new RegExp(`\\b[A-Za-z0-9_-]{2,}\\.(?:${EXT})\\b`, "g"),
  // A session branch pushed by an agent: session/q97e95vqj8zvczgfetgs6nmcnx.
  /\bsession\/[a-z0-9]{8,}\b/g,
  // A remote branch: origin/master, origin/session/q9788....
  /\borigin\/[A-Za-z0-9._/-]+/g,
  // A Convex function reference: internal.gpuPool.reconcile.
  /\b(?:internal|api)\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+/g,
];

// ── What counts as describing one ───────────────────────────────────────────
// A descriptor either names the KIND of thing the token is ("file", "branch",
// "cron") or states what it does ("holds", "records", "defines"). Either one
// gives the reader something to attach the name to.
const DESCRIPTOR =
  /\b(file|files|script|scripts|branch|branches|directory|directories|folder|dir|job|jobs|cron|table|function|module|page|test|tests|repo|repository|checkout|command|endpoint|route|constant|field|document|note|entry|log|report|config|guard|hook|component|worker|daemon|suite|helper|roster|skill|statute|article|ledger|registry|list|map|panel|schema|migration|wiki|todo|plan|doc|docs|package|workflow|notebook|dataset|checkpoint|export|artifact|engine|view|surface|harness|runner|generator|parser|loader|adapter|header|docstring|comment|comments|section|spec|manifest|lockfile|licence|license|readme|changelog|written|writes|wrote|lives|holds|contains|defines|records|implements|generates)\b/i;

// The other way a name gets attached to a thing: the token is the subject of a
// copular sentence, or carries an appositive right after it — "app/tts/lib.ts
// is the shared helper", "vqc/ledger.yaml, the open-debt register". The
// descriptor word list cannot enumerate every noun a description may use, so
// this pattern accepts the SHAPE of a description instead of its vocabulary.
const DESCRIBED_IN_PLACE = /^\s*(?:\(|—|-|,)?\s*(?:is|are|was|were)\s+(?:a|an|the|CMT's|Tom's|its|this|that|one|two|three|not|no)\b|^\s*,\s+(?:a|an|the)\s+[a-z]/;

const BEFORE = 180;
const AFTER = 100;

/** A ground-up explanation is an HTML document; only its visible text is prose,
 * so the markup and the <style> block are stripped before the rules run. */
export function visibleText(kind, text) {
  if (kind !== "groundUpExplanation") return text;
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
}

/** Every artifact token in the text, first occurrence only, longest match at a
 * position winning so that "app/tts/lib.ts" is one token and not also "lib.ts". */
export function artifactTokens(text) {
  const hits = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[0].replace(/[.,;:)"'\]]+$/, "");
      if (NOT_ARTIFACTS.test(raw)) continue;
      hits.push({ token: raw, start: m.index, end: m.index + raw.length });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // Two passes over the same list. `covered` holds every character range a
  // longer match already claimed, so "lib.ts" inside "app/tts/lib.ts" is never
  // a second artifact — at the first occurrence or any later one. `kept` is
  // then the first occurrence of each distinct name.
  const covered = [];
  const kept = [];
  const seen = new Set();
  for (const h of hits) {
    if (covered.some((c) => h.start >= c.start && h.end <= c.end)) continue;
    covered.push(h);
    if (seen.has(h.token)) continue;
    seen.add(h.token);
    kept.push(h);
  }
  return kept;
}

/** The tokens this unit names and never describes. */
export function undescribed(kind, text) {
  const v = visibleText(kind, text);
  return artifactTokens(v)
    .filter((h) => {
      // The name itself is blanked out of its own window first. Without that,
      // a file called runner.py or base.py or anything under tests/ describes
      // itself: the descriptor word is inside the name being checked.
      const win = v
        .slice(Math.max(0, h.start - BEFORE), h.end + AFTER)
        .split(h.token)
        .join(" ");
      if (DESCRIPTOR.test(win)) return false;
      return !DESCRIBED_IN_PLACE.test(v.slice(h.end, h.end + 60));
    })
    .map((h) => h.token);
}

async function main() {
  if (!SITE || !KEY) {
    console.error(
      "check-undescribed-artifacts: CONVEX_SITE_URL and TTS_WORKER_KEY must be " +
        "set (this rung reads prod Convex; it is not a CI gate).",
    );
    process.exit(2);
  }
  const res = await fetch(`${SITE.replace(/\/+$/, "")}/tts/batch-context`, {
    headers: { "X-TTS-Key": KEY },
  });
  if (!res.ok) {
    console.error(
      `check-undescribed-artifacts: /tts/batch-context -> HTTP ${res.status}`,
    );
    process.exit(2);
  }
  const { todos, batches, briefs: codeBriefs } = await res.json();

  const units = [];
  for (const t of todos) {
    if (t.brief)
      units.push({
        id: t._id,
        corpus: "todo",
        kind: "brief",
        text: t.brief,
        statement: t.statement,
      });
    if (t.groundUpExplanation)
      units.push({
        id: t._id,
        corpus: "todo",
        kind: "groundUpExplanation",
        text: t.groundUpExplanation,
        statement: t.statement,
      });
  }
  for (const b of batches ?? []) {
    if (b.groundUpExplanation)
      units.push({
        id: b._id,
        corpus: "batch",
        kind: "groundUpExplanation",
        text: b.groundUpExplanation,
        statement: b.statement,
      });
  }
  for (const c of codeBriefs ?? []) {
    if (c.brief)
      units.push({
        id: c._id,
        corpus: "code-brief",
        kind: "brief",
        text: c.brief,
        statement: `${c.repo} ${c.externalId}`,
      });
  }

  const failing = [];
  for (const u of units) {
    const tokens = undescribed(u.kind, u.text);
    if (tokens.length)
      failing.push({
        id: u.id,
        corpus: u.corpus,
        kind: u.kind,
        statement: u.statement,
        tokens,
      });
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(failing, null, 1));
  } else {
    const mentions = failing.reduce((n, f) => n + f.tokens.length, 0);
    console.log(
      `undescribed artifacts: ${failing.length} of ${units.length} units name an ` +
        `artifact they never describe (${mentions} distinct mentions)`,
    );
    const segments = [
      ["todo brief", (f) => f.corpus === "todo" && f.kind === "brief"],
      ["todo ground-up explanation", (f) => f.corpus === "todo" && f.kind !== "brief"],
      ["batch ground-up explanation", (f) => f.corpus === "batch"],
      ["code brief", (f) => f.corpus === "code-brief"],
    ];
    for (const [label, pick] of segments) {
      const n = failing.filter(pick).length;
      const of = units.filter((u) =>
        pick({ corpus: u.corpus, kind: u.kind }),
      ).length;
      console.log(`  ${String(n).padStart(4)} of ${String(of).padEnd(4)} ${label}`);
    }
    if (process.argv.includes("--list")) {
      for (const f of failing) {
        console.log(
          `  ${f.id}  ${f.corpus}/${f.kind}  [${f.tokens.slice(0, 8).join(", ")}]  ${f.statement.slice(0, 60)}`,
        );
      }
    }
  }

  if (failing.length > BASELINE) {
    console.error(
      `\nFAILED: ${failing.length} failing, baseline is ${BASELINE}. An artifact was ` +
        `named to a reader who cannot identify it. Describe it, or drop the name.`,
    );
    process.exit(1);
  }
  // The ratchet notes go to stderr under --json so that stdout stays a single
  // JSON value another program can parse.
  const note = process.argv.includes("--json") ? console.error : console.log;
  if (failing.length < BASELINE) {
    note(
      `\nThe number went down (${BASELINE} -> ${failing.length}). Lower BASELINE in ` +
        `this script in the same commit as the work — that is how the ratchet tightens.`,
    );
  }
  if (failing.length === 0) note("Nothing fails.");
}

if (process.argv[1] && process.argv[1].endsWith("check-undescribed-artifacts.mjs")) {
  main().catch((err) => {
    console.error(`check-undescribed-artifacts: ${err.message}`);
    process.exit(2);
  });
}
