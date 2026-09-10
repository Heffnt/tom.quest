// write-slack.mjs — THE MORNING MESSAGE IS WRITTEN, NOT FILLED IN.
//
// Tom, 2026-09-09: "Each morning message is written by a Fable agent, not
// filled into a template." Convex gathers the day's facts deterministically
// into a FACTS BLOCK — each fact with an id, its link and its numbers — and
// opens a draft request; this job is the writer.
//
// The run, in order:
//   1. GET /tts/slack-drafts — the open requests. Nothing open is the normal
//      case and the job exits saying so.
//   2. For each: read the WRITE LAYER from the WikiTom checkout at HEAD
//      (model-of-tom/writing.md and ground.md, through the one assembler in
//      scripts/prelude.mjs), and build one prompt: the write layer, the form
//      rules, and the facts block.
//   3. One Fable run (runClaude, --model fable), read-only, over that prompt.
//   4. POST /tts/slack-draft. CONVEX VERIFIES, not this job: every link and
//      every number in the draft must exist in the facts block on a fact the
//      line itself cites, and the draft must obey the form. A refusal comes
//      back with the complaints and this job takes ITS ONE RETRY with them in
//      the prompt. A second refusal is final and Convex's own timeout posts
//      the plain template — the morning is never silent.
//
// Cron: every minute in the 5 a.m. hour is enough; the request is open for
// five minutes and settling it is idempotent. By hand:
//   node /opt/tts/write-slack.mjs
//   node /opt/tts/write-slack.mjs --dry-run     # write it, print it, send nothing
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). NO SHEBANG LINE,
// for nightly.mjs's reason: this file reaches scripts/prelude.mjs by a dynamic
// import, and the test bundler rewrites such a call by prepending an import to
// the file — which lands in front of a shebang and fails to parse. The cron
// line names the interpreter, so nothing needs one.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, convexFetch, runClaude, extractJsonObject, reportJobFailed } from "./tts-lib.mjs";

const JOB = "write-slack";

// The prelude assembler lives in the repo at scripts/prelude.mjs and on the
// box at /opt/tts/scripts/prelude.mjs, while the jobs themselves are copied
// flat into /opt/tts (worker/setup.sh). One specifier cannot name both, so
// both are tried, in that order, and the failure names them.
const PRELUDE_CANDIDATES = ["../../scripts/prelude.mjs", "./scripts/prelude.mjs"];

async function loadPrelude() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const errors = [];
  for (const candidate of PRELUDE_CANDIDATES) {
    try {
      return await import(pathToFileURL(path.resolve(here, candidate)).href);
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`prelude.mjs is not reachable (${errors.join("; ")})`);
}
const WIKITOM_DIR = process.env.WIKITOM_DIR ?? "/root/wikitom";

/** Fable, because this is writing to Tom in his own register, over his own
 *  writing standard — the one thing in TTS that is judgment about words. */
const MODEL = "fable";
const TIMEOUT_MS = 3 * 60 * 1000;

/**
 * THE FORM, as the writer is given it. Every rule here is checked
 * mechanically by convex/ttsCompose.ts checkMessage and verifyDraft after the
 * run, so this text is not the enforcement — it is what makes the first
 * attempt the one that passes.
 * Exported for its test.
 */
export function formRules(kind, canReply) {
  const shared = [
    `THE FORM. One shape for every message TTS sends Tom on Slack.`,
    ``,
    `- The FIRST LINE says what this is and what he should do, or that there is`,
    `  nothing to do. At most 220 characters.`,
    `- EVERY LINE AFTER IT is one complete statement in display text carrying`,
    `  one link, at most 140 characters, ending in a full stop. A "lead" line`,
    `  introduces the item lines beneath it and carries no link; an "item" line`,
    `  is a whole sentence and its own link.`,
    `- NEVER a bare "+N more". Where there is more, write a whole sentence with`,
    `  a link: "667 other items are ready, and not one of them is dated."`,
    `- NEVER an ellipsis. A sentence that stops with "…" is a sentence he has to`,
    `  open the page to finish, which is the point of the message lost.`,
    `- OUTCOMES, NEVER LOGGED EVENTS. Say what a thing now is, not what was`,
    `  written about it. The words "plan stored", "created", "retired",`,
    `  "session opened", "worker event" and "focus-item" appear in no message.`,
    `- No title line. No *bold* header. No emoji. Slack already stamps the`,
    `  channel and the time.`,
    `- USE ONLY THE FACTS BELOW. Every link and every number you write must`,
    `  appear in a fact you cite on that line. You may not compute a new number`,
    `  from two facts, and you may not carry a link over from another line.`,
  ];
  const reply = canReply
    ? [
        `- ONE reply invitation is allowed at the end of a section, as a "note"`,
        `  line: a lowercase sentence saying what to type. It carries no link and`,
        `  no number, and it cites no fact.`,
      ]
    : [`- NO REPLY INVITATION. The reply route is not live, so a message that`,
       `  asks him to reply asks for something it cannot receive.`];
  const shape =
    kind === "today"
      ? [
          `THIS IS THE DIGEST, posted at 5 a.m. in #tts-today. He reads it`,
          `once and decides what he is doing today. The sections run in this order,`,
          `each omitted when it has no facts except the first:`,
          `  1. today — what carries a date he has passed, oldest first, each line`,
          `     naming the first move`,
          `  2. the objection list — what the delegate decided while he was asleep`,
          `  3. the calendar — the shape of his day`,
          `  4. overnight — one line per batch saying what the batch now is`,
          `  5. broken — what failed, and what that means for him`,
          `It must fit ONE Slack message: 3,900 characters rendered.`,
        ]
      : [
          `THIS IS A NEEDS-YOU THREAD, in #tts-needs-you. It is one thing only Tom`,
          `can settle. The first line says WHY only he can settle it and names the`,
          `first move; the lines under it are the item and, when there is one, the`,
          `message it came from. Never print a vendor's subject line or a From`,
          `header — you have not been given them, and that is deliberate.`,
        ];
  return [...shape, ``, ...shared, ...reply].join("\n");
}

/** The answer shape, and the citation contract that makes verification
 *  mechanical. Exported for its test. */
export function answerShape() {
  return [
    `Answer ONLY a JSON object, no prose, no code fences:`,
    `{"firstLine": "<the first line>",`,
    ` "firstLineSources": ["<fact id>", …],`,
    ` "lines": [{"role": "lead"|"item"|"note", "text": "<the line>",`,
    `            "url": "<the link, on an item line only>",`,
    `            "sources": ["<fact id>", …]}]}`,
    ``,
    `"sources" names the facts THAT LINE was written from. A line with a link or`,
    `a number and no source that holds it is refused.`,
  ].join("\n");
}

/** The whole prompt for one request. Exported for its test. */
export function draftPrompt(writeLayer, request, complaints) {
  const parts = [
    writeLayer,
    ``,
    `--- HOW TO WRITE TO TOM ends here. THE MESSAGE FORM follows. ---`,
    ``,
    formRules(request.kind, request.canReply),
    ``,
    // Fixed and rarely-changing text first, the volatile value last: the answer
    // shape never varies, so it sits ABOVE the facts block, which is different
    // every morning. Anything fixed placed behind the facts would break the
    // prefix the cache is keyed on.
    answerShape(),
    ``,
    `--- THE FACTS ---`,
    `Every fact has an id, the sentence it states, the links it may lend a line,`,
    `and the numbers it may lend a line.`,
    JSON.stringify(request.facts.facts, null, 2),
  ];
  if (complaints.length > 0) {
    parts.push(
      ``,
      `YOUR LAST DRAFT WAS REFUSED. Fix exactly these and change nothing else:`,
      ...complaints.map((c) => `- ${c}`),
    );
  }
  return parts.join("\n");
}

async function writeLayerOf(dir) {
  // The write layer is writing.md and ground.md read from ONE immutable git
  // commit, through the same assembler every prompt in TTS uses. A run that
  // cannot read it does not fall back to a remembered standard: it declines,
  // and Convex's timeout posts the template.
  const { assemblePrelude } = await loadPrelude();
  const prelude = assemblePrelude({ wikitom: dir, commit: "HEAD", layers: ["write"] });
  return `MODEL-OF-TOM FILES (WikiTom commit ${prelude.commit}) — HOW TO WRITE TO TOM\n\n${prelude.layers.write}`;
}

async function writeOne(env, request, writeLayer, { dryRun }) {
  let complaints = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = draftPrompt(writeLayer, request, complaints);
    const answer = runClaude(prompt, { model: MODEL, timeoutMs: TIMEOUT_MS, maxTurns: 2 });
    const draft = extractJsonObject(answer);
    if (dryRun) {
      console.log(JSON.stringify(draft, null, 2));
      return { accepted: false, dryRun: true };
    }
    const result = await convexFetch(env, "/tts/slack-draft", {
      requestId: request.requestId,
      draft,
    });
    if (result.accepted) {
      console.log(`[write-slack] ${request.requestId}: accepted on attempt ${attempt}`);
      return { accepted: true, attempt };
    }
    complaints = result.complaints ?? ["the draft was refused with no complaint"];
    console.error(
      `[write-slack] ${request.requestId}: refused on attempt ${attempt} — ${complaints.join("; ")}`,
    );
    if (result.final) break;
  }
  // NOT A FAILURE ROW. A refused draft is the system working: Convex posts the
  // plain template when its timeout comes round, and the digest-sent row says
  // "template" so the eval can count how often the writer misses.
  return { accepted: false, complaints };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY"] });
  const { requests } = await convexFetch(env, "/tts/slack-drafts");
  if (!Array.isArray(requests) || requests.length === 0) {
    console.log("[write-slack] nothing open");
    return;
  }
  let writeLayer;
  try {
    writeLayer = await writeLayerOf(WIKITOM_DIR);
  } catch (err) {
    // The one hard failure: with no write layer this job would be writing to
    // Tom from a remembered standard, which is the thing the layer exists to
    // stop. Report it and let the template go out.
    await reportJobFailed(env, {
      job: JOB,
      error: `the write layer is unreadable at ${WIKITOM_DIR}: ${err.message}`,
    });
    throw err;
  }
  for (const request of requests) {
    try {
      await writeOne(env, request, writeLayer, { dryRun });
    } catch (err) {
      console.error(`[write-slack] ${request.requestId}: ${err.message}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("write-slack.mjs")) {
  main().catch((err) => {
    console.error(`[write-slack] ${err.message}`);
    process.exitCode = 1;
  });
}
