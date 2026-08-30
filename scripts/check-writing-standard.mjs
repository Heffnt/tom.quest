// Guardrail: the writing standard has exactly ONE home.
//
// WHAT THE STANDARD IS: WRITING_STANDARD in convex/ttsShared.ts — the rules
// every sentence TTS shows Tom obeys (the two registers, who he is, no
// load-bearing analogies, no invented names, descriptive never evaluative).
// Prompts paste it verbatim: TypeScript imports it, and the worker box (Node
// ESM, never loads .ts) fetches it from GET /tts/writing-standard or off the
// /tts/batch-context payload.
//
// WHAT THIS CHECK CATCHES: a prompt that carries its OWN restatement of the
// rules instead. That is the failure this whole arrangement exists to prevent,
// and it is invisible in review — a paraphrase reads like ordinary prompt text,
// so nobody notices that the standard now has two versions and only one of them
// gets updated. Every one of the prompts scanned here used to carry one.
//
// HOW: the phrases below are lines OF the standard. Outside its one home, a
// line containing one is a second copy. Comment lines are exempt: a comment
// naming the phrase it replaced (as several of these files now do) is
// documentation, not a prompt the model reads.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The one home, and the only file allowed to contain the standard's own words.
const HOME = "convex/ttsShared.ts";

// Directories scanned, and the file extensions that hold prompts in each.
const SCANNED = [
  { dir: "worker/jobs", exts: [".mjs"] },
  { dir: "convex", exts: [".ts"] },
  { dir: "app/lib", exts: [".ts"] },
];

// A fragment of the standard's own wording, or of the paraphrases that stood in
// for it before there was one home. Matched case-insensitively.
const RESTATEMENTS = [
  "define every term",
  "define any term",
  "define terms on first use",
  "invent no names",
  "no invented names",
  "concrete before abstract",
  "never evaluative",
  "no praise",
  "ground-up contract",
];

// Comment lines are documentation, not prompt text. Whole-line `//` comments
// and block-comment bodies (` * …`) are both dropped; a trailing `//` on a code
// line is not, which is the conservative direction — it keeps a prompt string
// with a comment glued to its end from slipping through.
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const failures = [];

for (const { dir, exts } of SCANNED) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    failures.push(`${dir}: not found — the scan list is stale`);
    continue;
  }
  for (const name of names) {
    const rel = path.posix.join(dir, name);
    if (rel === HOME) continue;
    if (!exts.some((e) => name.endsWith(e))) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test.mjs")) continue;

    const lines = readFileSync(rel, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const lower = line.toLowerCase();
      for (const phrase of RESTATEMENTS) {
        if (lower.includes(phrase)) {
          failures.push(
            `${rel}:${i + 1} restates the writing standard ("${phrase}") — ` +
              `paste WRITING_STANDARD from ${HOME} instead`,
          );
        }
      }
    });
  }
}

// The home itself must still hold the standard: an empty or deleted constant
// would pass every check above while leaving every prompt with no standard.
const home = readFileSync(HOME, "utf8");
if (!/export const WRITING_STANDARD = `WRITING STANDARD/.test(home)) {
  failures.push(`${HOME}: WRITING_STANDARD is missing or no longer the standard`);
}

if (failures.length > 0) {
  console.error("check-writing-standard: FAILED");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-writing-standard: one home, no restatements");
