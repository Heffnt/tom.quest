// runner-checkin.mjs — the two checks a runner's check-in passes before Tom
// reads it.
//
// A runner step (convex/ttsRunners.ts) posts a check-in every step, into a
// Slack thread Tom reads. Before it is posted it passes the form rules
// (shared/checkin-rules.mjs, pure and cheap) and then one cold judge run that
// reads it against his writing standard. This file is the judge half and the
// one place both halves are run in order; worker/bin/tts-runner-step is its
// command line, and worker/jobs/evals.mjs scores the judge against the golden
// check-ins in evals/golden/checkins/.
//
// The judge is modelled on the evals judge call (worker/jobs/evals.mjs runItem):
// the same model, one turn, no tools, and ONE RETRY ONLY FOR AN ANSWER THAT
// COULD NOT BE READ. A readable "fail" is asked once and stands; retrying until
// the wanted verdict arrives is how a check becomes a wish.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractJsonObject, modelLabel, runClaude } from "./tts-lib.mjs";
import { JUDGE_MODEL, JUDGE_RETRIES } from "./evals.mjs";

const CHECKIN_JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

/** The form rules, from wherever this install keeps them: /opt/tts/shared/
 *  beside the flat jobs on the box, shared/ in a checkout. */
async function loadCheckInRules() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "shared", "checkin-rules.mjs"),
    path.join(here, "..", "..", "shared", "checkin-rules.mjs"),
  ]) {
    if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  }
  throw new Error("shared/checkin-rules.mjs is not installed beside the jobs; run worker/setup.sh");
}

/** His writing standard as the judge reads it: the write skill's two pages. */
function readWritingStandard(wikitomDir = process.env.WIKITOM_DIR || "/root/wikitom") {
  const pages = ["writing.md", "ground.md"].map((name) => {
    try {
      return fs.readFileSync(path.join(wikitomDir, "model-of-tom", name), "utf8");
    } catch {
      return null;
    }
  }).filter((page) => page !== null);
  if (pages.length === 0) throw new Error(`the writing standard is not readable under ${wikitomDir}/model-of-tom`);
  return pages.join("\n\n");
}

/** The judge's prompt. The fixed text first and the check-in last, the
 *  cache-aware order the evals judge uses. */
export function checkInJudgePrompt(checkIn, standard) {
  return [
    "You are checking one message before Tom reads it. Tom is one person; an agent that watches an experiment for him writes him a short check-in every few minutes, in a Slack thread, and he reads it on his phone.",
    "",
    "Read the check-in against his writing standard, below. The form has already been checked by a script (every line a sentence or a table row, no ellipsis, no code, one allowed heading, no labels, a length cap); judge what a script cannot:",
    "- a term he would not know is defined where it is first used, or not used;",
    "- no name is coined for a thing, and no jargon of the agent's own making appears;",
    "- it says what was seen and what was done, plainly, and does not grade its own work;",
    "- a number is given with what it counts;",
    "- a question for him, if there is one, can be answered in a sentence and says what happens if he does not answer.",
    "",
    "Answer with ONE JSON object and nothing else:",
    '{"verdict": "pass" | "fail", "complaints": ["one sentence per fault, naming the words at fault without quotation marks"]}',
    "A pass has an empty complaints list. Do not put quotation marks inside a complaint.",
    "",
    "HIS WRITING STANDARD",
    standard.trim(),
    "",
    "THE CHECK-IN",
    String(checkIn).trim(),
  ].join("\n");
}

/** The judge's answer as { verdict, complaints }, or { unreadable: true }. */
export function parseCheckInVerdict(answer) {
  let parsed;
  try {
    parsed = extractJsonObject(String(answer ?? ""));
  } catch {
    return { unreadable: true, head: String(answer ?? "").slice(0, 200) };
  }
  const verdict = parsed?.verdict;
  const complaints = parsed?.complaints;
  if ((verdict !== "pass" && verdict !== "fail") || !Array.isArray(complaints) || complaints.some((c) => typeof c !== "string")) {
    return { unreadable: true, head: String(answer ?? "").slice(0, 200) };
  }
  if (verdict === "fail" && complaints.length === 0) return { unreadable: true, head: "a fail with no complaint" };
  return { verdict, complaints: complaints.map((c) => c.trim()).filter((c) => c !== "") };
}

/**
 * Both checks, in order. The form rules first, and a form failure ends it: the
 * judge is the expensive half and a text that broke a written rule is not a
 * matter of reading.
 *
 * Returns { verdict, complaints, attempts, judgeModel, stage }, where stage is
 * "form" or "judge". A judge that could not be reached or read twice is a
 * fail with that said, never a silent pass.
 */
export async function checkCheckIn(checkIn, { run = runClaude, standard = null, rules = null } = {}) {
  const { checkInFailures } = rules ?? (await loadCheckInRules());
  const form = checkInFailures(checkIn);
  if (form.length > 0) {
    return { verdict: "fail", complaints: form.map((f) => `${f.id}: ${f.why}.`), attempts: 0, judgeModel: modelLabel(JUDGE_MODEL), stage: "form" };
  }
  const prompt = checkInJudgePrompt(checkIn, standard ?? readWritingStandard());
  let attempts = 0;
  let last = null;
  while (attempts <= JUDGE_RETRIES) {
    attempts += 1;
    let answer;
    try {
      answer = run(prompt, {
        model: JUDGE_MODEL,
        timeoutMs: CHECKIN_JUDGE_TIMEOUT_MS,
        maxTurns: 1,
        allowedTools: [],
        registration: { origin: "cron:runner-checkin", kind: "job", environment: "runner", layersKnown: false, layersGiven: [], layersDenied: [] },
      });
    } catch (error) {
      return { verdict: "fail", complaints: [`The judge could not be run: ${String(error?.message ?? error).slice(0, 200)}.`], attempts, judgeModel: modelLabel(JUDGE_MODEL), stage: "judge" };
    }
    last = parseCheckInVerdict(answer);
    if (!last.unreadable) return { ...last, attempts, judgeModel: modelLabel(JUDGE_MODEL), stage: "judge" };
  }
  return { verdict: "fail", complaints: [`The judge's answer could not be read twice (${last.head}).`], attempts, judgeModel: modelLabel(JUDGE_MODEL), stage: "judge" };
}
