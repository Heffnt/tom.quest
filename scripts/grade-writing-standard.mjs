#!/usr/bin/env node
// grade-writing-standard.mjs — the MEANING half of the writing-standard check.
//
//   node scripts/grade-writing-standard.mjs                # grade everything
//   node scripts/grade-writing-standard.mjs --limit 20      # a cheap sample
//   node scripts/grade-writing-standard.mjs --kind brief    # one unit kind
//
// WHAT THIS GRADES, AND WHY IT IS A SECOND SCRIPT. The writing standard has
// two halves. One is about the SHAPE of a ground-up explanation (opens at
// <!DOCTYPE html>, carries an <h1>, loads nothing from outside): shape is
// decidable by matching patterns against the raw characters, so
// scripts/check-writing-standard.mjs decides it, and that script's count is
// the RATCHET — the number that must never rise, currently zero.
//
// The other half is about MEANING: whether a unit describes the artifact it
// names, whether a pronoun stands where a name belongs, whether a term is
// defined at first use. No pattern over the characters decides any of those,
// so this script asks a language model, one prose unit at a time.
//
// A LANGUAGE-MODEL GRADE IS NOT A RATCHET, ON PURPOSE. The same unchanged
// text can be graded differently on two runs, so this count can rise with no
// prose having changed, and a ratchet must never do that. This script
// therefore exits 0 whatever it finds and writes a DATED LIST — the failing
// units, with the rule each one failed and the phrase that failed it — to
// vqc/writing-standard-findings.json. The list is the input the rewrite and
// the sweep todos work from. It never feeds vqc/ledger.yaml's ratchet number.
//
// COST. Every run spends real money on model calls: roughly 130 calls over the
// full 559-unit corpus. Use --limit while changing the prompt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { extractJsonObject } from "../worker/jobs/tts-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const SITE = process.env.CONVEX_SITE_URL;
const KEY = process.env.TTS_WORKER_KEY;

// The account symlink every headless Claude invocation in this repo goes
// through (worker/jobs/tts-lib.mjs, CLAUDE_CONFIG_DIR). Applied only when it
// exists, so the script also runs in a session checkout on a machine that has
// no such symlink and is already signed in.
const CLAUDE_CONFIG_DIR = "/root/.claude-accounts/active";

// Tom has not yet named the jargon an agent may use without defining it (an
// open todo of his). Until that file exists the define-before-use rule is not
// graded, because grading it against a guessed list would report failures the
// standard does not state. One term per line; "#" starts a comment.
const JARGON_LIST = path.join(REPO, "vqc", "known-jargon.txt");

const OUT = path.join(REPO, "vqc", "writing-standard-findings.json");

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

// Each rule is one the writing standard states in so many words; the wording
// below is what the model is asked to apply. `needsJargonList` marks the rule
// that cannot be graded until Tom's list exists.
export const RULES = [
  {
    id: "artifact-not-described",
    why: "names an artifact an agent made without ever describing it",
    instruction:
      'The unit names an artifact — a file, path, branch, directory, script, ' +
      "job, cron, database table, function, endpoint, pull request, or " +
      "anything else an agent created — and never says what that artifact is " +
      "or does. The reader holds no memory of prior sessions and has never " +
      "seen any of it, so a bare name he cannot resolve is the failure. A " +
      "name is fine once the unit says, anywhere in the same unit, what the " +
      "thing is.",
  },
  {
    id: "vague-reference",
    why: "a pronoun or vague back-reference stands where a name belongs",
    instruction:
      'A pronoun ("it", "this", "that one", "the former", "the latter", ' +
      '"these") stands in for a thing whose identity the reader cannot ' +
      "recover with certainty from the same sentence or the one before it. " +
      "Also failing: the unit calls one single thing by two different names " +
      "in different places, so the reader cannot tell whether one thing or " +
      "two is meant. Ordinary unambiguous pronouns are not a failure.",
  },
  {
    id: "term-undefined",
    why: "uses a term from the always-define list without defining it",
    needsJargonList: true,
    instruction:
      "The unit uses a term that the writing standard says must always be " +
      "defined at first use, and never defines it. Terms on the " +
      "known-jargon list below are ruled understood and never count as a " +
      "failure, and neither does anything the standard's own " +
      '"assume fluent, never define" paragraph covers.',
  },
];

// ---------------------------------------------------------------------------
// Pure helpers (exercised by scripts/grade-writing-standard.test.mjs)
// ---------------------------------------------------------------------------

// The prose of a ground-up explanation, with the markup removed: the <style>
// block, every tag, and HTML entities. The shape of the document is the OTHER
// script's business, and sending 10,000 characters of CSS to a model that is
// grading sentences costs money and teaches it nothing.
export function proseOf(text, kind) {
  if (kind === "brief") return text.trim();
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rarr;/gi, "->")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Every prose unit stored in TTS: one per stored brief and one per stored
// ground-up explanation, so a todo carrying both contributes two units.
export function unitsFrom(todos) {
  const units = [];
  for (const todo of todos) {
    if (typeof todo.brief === "string" && todo.brief.trim() !== "") {
      units.push({
        todoId: todo._id,
        kind: "brief",
        statement: todo.statement ?? "",
        prose: proseOf(todo.brief, "brief"),
      });
    }
    const html = todo.groundUpExplanation;
    if (typeof html === "string" && html.trim() !== "") {
      units.push({
        todoId: todo._id,
        kind: "ground-up explanation",
        statement: todo.statement ?? "",
        prose: proseOf(html, "ground-up explanation"),
      });
    }
  }
  return units;
}

// Group units into model calls under a character budget. One call per unit
// would be the cleanest grading but costs four times as much; the budget keeps
// a call small enough that the model holds every unit in it at once.
export function planCalls(units, { maxChars = 12000, maxUnits = 6 } = {}) {
  const calls = [];
  let current = [];
  let chars = 0;
  for (const unit of units) {
    const size = unit.prose.length;
    if (current.length > 0 && (chars + size > maxChars || current.length >= maxUnits)) {
      calls.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length > 0) calls.push(current);
  return calls;
}

export function buildPrompt(batch, { writingStandard, rules }) {
  const ruleText = rules
    .map((r, i) => `${i + 1}. ${r.id} — ${r.instruction}`)
    .join("\n\n");
  const unitText = batch
    .map(
      (u, i) =>
        `--- UNIT ${i + 1} (${u.kind}; the display text it sits behind: ${u.statement}) ---\n${u.prose}`,
    )
    .join("\n\n");
  return `You are grading stored prose against the writing standard below. You are not rewriting anything and you are not judging whether the prose is good; you decide only whether each numbered rule is broken.

=== THE WRITING STANDARD ===
${writingStandard}
=== END OF THE WRITING STANDARD ===

Grade each unit against exactly these rules and no others:

${ruleText}

Flag a rule only when a specific phrase in the unit breaks it and you can quote that phrase. When you are unsure, do not flag it: this list is worked through by hand afterwards, so a false failure costs more than a missed one.

${unitText}

Answer with one JSON object and nothing else, no code fence:
{"units": [{"unit": 1, "rules": [{"id": "artifact-not-described", "quote": "the exact phrase from the unit", "reason": "one sentence"}]}]}

Include an entry for every unit you were given, in order, with an empty "rules" array for a unit that breaks none of them.`;
}

// Turn one model answer into findings, keyed back to the units the call
// carried. A unit number the model invented, or a rule id it invented, is
// dropped rather than trusted — the answer is data from a model, not a result.
export function parseVerdicts(answerText, batch, ruleIds) {
  const parsed = extractJsonObject(answerText);
  const rows = Array.isArray(parsed.units) ? parsed.units : [];
  const findings = [];
  for (const row of rows) {
    const index = Number(row?.unit);
    if (!Number.isInteger(index) || index < 1 || index > batch.length) continue;
    const unit = batch[index - 1];
    const broken = Array.isArray(row.rules) ? row.rules : [];
    const kept = broken
      .filter((r) => r && ruleIds.includes(r.id))
      .map((r) => ({
        id: r.id,
        quote: String(r.quote ?? "").slice(0, 300),
        reason: String(r.reason ?? "").slice(0, 300),
      }));
    if (kept.length === 0) continue;
    findings.push({
      todoId: unit.todoId,
      kind: unit.kind,
      statement: unit.statement,
      rules: kept,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Running the model
// ---------------------------------------------------------------------------

// The same headless Claude Code call worker/jobs/tts-lib.mjs makes, except
// asynchronous. That one is execFileSync by design — the worker jobs run one
// prompt at a time on a cron — and 130 sequential calls over this corpus would
// take an hour, so this file spawns its own and keeps several in flight.
function runClaude(prompt, { model, timeoutMs = 10 * 60 * 1000 }) {
  // --max-turns 4, not 1: the grading prompt needs no tools, but the CLI still
  // has them, and one stray tool call against a 1-turn budget ends the run in
  // an error envelope that grades nothing (the same trap worker/jobs/
  // tts-lib.mjs documents).
  const args = ["-p", "--output-format", "json", "--max-turns", "4"];
  if (model) args.push("--model", model);
  const env = { ...process.env };
  if (fs.existsSync(CLAUDE_CONFIG_DIR)) env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          const envelope = JSON.parse(stdout);
          if (envelope && envelope.type === "result") {
            if (typeof envelope.result !== "string") {
              return reject(
                new Error(
                  `claude returned an error envelope (subtype: ${envelope.subtype ?? "?"})`,
                ),
              );
            }
            return resolve(envelope.result);
          }
        } catch {
          // not the JSON envelope — treat stdout as the raw answer
        }
        resolve(stdout);
      },
    );
    child.stdin.end(prompt);
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  return process.argv[at + 1] ?? fallback;
}

async function main() {
  if (!SITE || !KEY) {
    console.error(
      "grade-writing-standard: CONVEX_SITE_URL and TTS_WORKER_KEY must be set " +
        "(this rung reads prod Convex; it is not a CI gate).",
    );
    process.exit(2);
  }
  const model = flag("model", "sonnet");
  const concurrency = Number(flag("concurrency", "6"));
  const limit = Number(flag("limit", "0"));
  const kindFilter = flag("kind", "");

  // The writing standard comes from the server, never from a copy in this
  // file: /tts/batch-context serves the synced WikiTom skill with
  // convex/ttsShared.ts WRITING_STANDARD as the fallback, and that is the same
  // text every agent is given before it writes. Grading against a second copy
  // would grade prose against a standard nothing was written to.
  const base = SITE.replace(/\/+$/, "");
  const [stateRes, contextRes] = await Promise.all([
    fetch(`${base}/tts/state`, { headers: { "X-TTS-Key": KEY } }),
    fetch(`${base}/tts/batch-context`, { headers: { "X-TTS-Key": KEY } }),
  ]);
  if (!stateRes.ok || !contextRes.ok) {
    console.error(
      `grade-writing-standard: /tts/state -> HTTP ${stateRes.status}, ` +
        `/tts/batch-context -> HTTP ${contextRes.status}`,
    );
    process.exit(2);
  }
  const { todos } = await stateRes.json();
  const { writingStandard } = await contextRes.json();
  if (typeof writingStandard !== "string" || writingStandard.trim() === "") {
    console.error(
      "grade-writing-standard: /tts/batch-context returned no writingStandard — " +
        "refusing to grade prose against a standard read from anywhere else",
    );
    process.exit(2);
  }

  let jargon = "";
  if (fs.existsSync(JARGON_LIST)) {
    jargon = fs
      .readFileSync(JARGON_LIST, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .join(", ");
  }
  const rules = RULES.filter((r) => !r.needsJargonList || jargon !== "");
  const ruleIds = rules.map((r) => r.id);
  if (jargon === "") {
    console.log(
      `term-undefined: NOT GRADED — ${path.relative(REPO, JARGON_LIST)} does not ` +
        "exist yet. It is written by the todo in which Tom names the jargon an " +
        "agent may use without defining it; the rule grades itself on as soon as " +
        "the file is there.",
    );
  }
  const rulesForPrompt = rules.map((r) =>
    r.needsJargonList
      ? { ...r, instruction: `${r.instruction}\nKnown-jargon list: ${jargon}` }
      : r,
  );

  let units = unitsFrom(todos);
  if (kindFilter === "brief") units = units.filter((u) => u.kind === "brief");
  if (kindFilter === "explanation") {
    units = units.filter((u) => u.kind === "ground-up explanation");
  }
  if (limit > 0) units = units.slice(0, limit);
  const calls = planCalls(units);
  console.log(
    `grading ${units.length} prose units (${units.filter((u) => u.kind === "brief").length} ` +
      `briefs, ${units.filter((u) => u.kind !== "brief").length} ground-up explanations) ` +
      `in ${calls.length} model calls, model ${model}, concurrency ${concurrency}`,
  );

  let done = 0;
  const errors = [];
  const perCall = await mapWithConcurrency(calls, concurrency, async (batch) => {
    const prompt = buildPrompt(batch, { writingStandard, rules: rulesForPrompt });
    try {
      const answer = await runClaude(prompt, { model });
      const found = parseVerdicts(answer, batch, ruleIds);
      done += 1;
      process.stderr.write(`  ${done}/${calls.length} calls\r`);
      return found;
    } catch (err) {
      done += 1;
      errors.push(`${batch.map((u) => u.todoId).join(",")}: ${err.message}`);
      return [];
    }
  });
  process.stderr.write("\n");

  const findings = perCall.flat();
  const byRule = new Map();
  for (const f of findings) {
    for (const r of f.rules) byRule.set(r.id, (byRule.get(r.id) ?? 0) + 1);
  }

  console.log(
    `\n${findings.length} of ${units.length} prose units fail a meaning-based rule ` +
      "of the writing standard",
  );
  for (const rule of rules) {
    const n = byRule.get(rule.id) ?? 0;
    console.log(`  ${String(n).padStart(4)}  ${rule.id} — ${rule.why}`);
  }
  const briefsFailing = findings.filter((f) => f.kind === "brief").length;
  console.log(
    `  by unit kind: ${briefsFailing} briefs, ${findings.length - briefsFailing} ` +
      "ground-up explanations",
  );
  if (process.argv.includes("--list")) {
    for (const f of findings) {
      console.log(`\n  ${f.todoId}  [${f.kind}]  ${f.statement.slice(0, 70)}`);
      for (const r of f.rules) {
        console.log(`      ${r.id}: "${r.quote}" — ${r.reason}`);
      }
    }
  }
  if (errors.length > 0) {
    console.log(`\n${errors.length} model calls failed and graded nothing:`);
    for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  }

  // Only a full run may overwrite the list; a --limit or --kind run is a
  // sample, and writing a sample over the list would silently shrink the
  // backlog the rewrite works from.
  const partial = limit > 0 || kindFilter !== "";
  if (partial) {
    console.log(
      `\nSample run — ${path.relative(REPO, OUT)} not written. Run with no ` +
        "--limit and no --kind to write the list.",
    );
    return;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    model,
    unitsGraded: units.length,
    rulesGraded: ruleIds,
    failingUnits: findings.length,
    callsFailed: errors.length,
    note:
      "Advisory list, not a ratchet: a language model can grade the same " +
      "unchanged text differently on two runs, so this count may rise with no " +
      "prose having changed. The ratchet is scripts/check-writing-standard.mjs, " +
      "which grades document shape and must never rise above its BASELINE.",
    findings,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO, OUT)} (${findings.length} findings).`);
}

// Imported by the test file, which must not run a corpus-wide model pass.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`grade-writing-standard: ${err.message}`);
    process.exit(2);
  });
}
