#!/usr/bin/env node
// prepare-life-todos.mjs — advance unprepared LIFE todos toward ready-for-tom.
//
// Run by cron every 2nd hour at :37 (see /etc/cron.d/dts). Manual run:
//   node /opt/dts/prepare-life-todos.mjs [--force]
//
// WHY: a thought Tom dumps into #dump (or a consolidation candidate) lands as
// a raw one-line statement with readiness "unprepared". The DTS principle is
// that volume reaches Tom PRE-CHEWED — the swarm prepares, Tom rules. This is
// the swarm's smallest member: per unprepared life todo, headless Claude
// writes a short ground-up brief, the smallest entry action, and a
// qualitative work description, then advances readiness. It never rewrites
// the statement, never sets dates, never changes status — preparation must
// not alter intent (those are Tom's).
//
// readiness after preparation:
//   ready-for-tom  — a self-contained personal task: the only missing thing
//                    is Tom doing/deciding it.
//   preparing      — genuinely needs more agent work (research, drafting)
//                    before Tom's attention is well spent. Still gets the
//                    fields; deeper preparation is a later swarm feature.
//
// NO-STATE RULE: nothing local; Convex is read and written each run.

import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./dts-lib.mjs";

const BATCH_MAX = 10;
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

function prompt(todo) {
  return [
    `You are preparing one item in DTS, Tom's personal todo system. It was`,
    `captured as a raw thought; your job is to make it arrive pre-chewed.`,
    ``,
    `The item (JSON):`,
    JSON.stringify(
      {
        statement: todo.statement,
        source: todo.source,
        provenance: todo.provenance ?? null,
        createdAt: todo.createdAt,
      },
      null,
      2,
    ),
    ``,
    `Write, in plain language (define any term Tom might not know; invent no`,
    `names; descriptive, never evaluative — no praise, no urgency theater):`,
    `1. "brief" — 2-5 sentences, ground-up: what this item is, why it likely`,
    `   exists, and anything a person acting on it should know. If the`,
    `   statement is too terse to interpret confidently, say so plainly in the`,
    `   brief and phrase what needs clarifying.`,
    `2. "entryAction" — the SMALLEST first action, imperative, under 10 words`,
    `   (e.g. "Open the reservation page", "Draft two sentences to Ana").`,
    `3. "workDescription" — the kind/size of engagement, qualitatively, a few`,
    `   words (e.g. "a two-minute errand", "a short ruling", "a session's`,
    `   worth of writing"). NEVER a numeric time estimate.`,
    `4. "readiness" — "ready-for-tom" if the only missing ingredient is Tom`,
    `   acting or deciding; "preparing" if an agent could still usefully do`,
    `   groundwork first (research, drafting, gathering links).`,
    ``,
    `Answer ONLY a JSON object:`,
    `{"brief": "...", "entryAction": "...", "workDescription": "...", "readiness": "..."}`,
  ].join("\n");
}

async function main() {
  const force = process.argv.includes("--force");
  const env = loadEnv();
  const state = await convexFetch(env, "/dts/state");

  // Unprepared, active, life-side only. --force also re-prepares "preparing"
  // items (useful after improving this prompt).
  const targets = (state.todos ?? []).filter(
    (t) =>
      t.status === "active" &&
      (t.readiness === "unprepared" || (force && t.readiness === "preparing")),
  );
  if (targets.length === 0) return; // quiet when idle

  const batch = targets.slice(0, BATCH_MAX);
  console.log(
    `[prepare-life-todos] ${targets.length} unprepared, processing ${batch.length}`,
  );

  let failures = 0;
  for (const todo of batch) {
    try {
      const answer = runClaude(prompt(todo), { timeoutMs: CLAUDE_TIMEOUT_MS });
      const parsed = extractJsonObject(answer);
      if (
        typeof parsed.brief !== "string" ||
        typeof parsed.entryAction !== "string" ||
        typeof parsed.workDescription !== "string" ||
        (parsed.readiness !== "ready-for-tom" && parsed.readiness !== "preparing")
      ) {
        throw new Error(`bad shape: ${JSON.stringify(parsed).slice(0, 120)}`);
      }
      await convexFetch(env, "/dts/prepare-todo", {
        id: todo._id,
        brief: parsed.brief,
        entryAction: parsed.entryAction,
        workDescription: parsed.workDescription,
        readiness: parsed.readiness,
      });
      console.log(
        `[prepare-life-todos] prepared ${todo._id} -> ${parsed.readiness} ` +
          `"${todo.statement.slice(0, 50).replace(/\s+/g, " ")}"`,
      );
    } catch (err) {
      // Per-item failure: log and continue — the item stays unprepared and
      // the next run retries it. One bad item must not starve the batch.
      failures++;
      console.error(
        `[prepare-life-todos] ${todo._id} FAILED: ${String(err.message ?? err).slice(-200)}`,
      );
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[prepare-life-todos] FAILED: ${err.message}`);
  process.exit(1);
});
