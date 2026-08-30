#!/usr/bin/env node
// brief-code-todos.mjs — brief every open CMT code-todo for Tom's ruling.
//
// Run by cron at 17 past every 2nd hour (see /etc/cron.d/tts). Manual runs:
//   node /opt/tts/brief-code-todos.mjs           # brief what changed
//   node /opt/tts/brief-code-todos.mjs --force   # re-brief EVERYTHING
//
// WHAT A BRIEF IS: vqc/todos.yaml in the ComplexMultiTrigger repo is Tom's
// standing-intent registry — each entry is a decided piece of work with a
// completion condition and (tier R) a full plan. This job reads every OPEN
// entry, has headless Claude write a ground-up explanation of it against the
// CURRENT tree, and posts brief + recommendation to Convex, where the
// tom.quest UI shows them for Tom to rule on. Rulings come back through
// apply-rulings.mjs / execute-plans.mjs — this job never acts on one.
//
// INCREMENTALITY: an entry is re-briefed only when its YAML changed since the
// last posted brief, tracked by a sha256 source hash in the local cursor file
// /var/lib/tts/brief-hashes.json. Losing that file is harmless: everything
// gets re-briefed once and the Convex POST upserts. A cursor value of
// "replan-requested..." (set by apply-rulings on a stale-replan ruling) also
// forces a re-brief AND switches the prompt to ask for a fresh plan.
//
// Each success is durable IMMEDIATELY (post -> cache file -> cursor), so a
// crash mid-run loses at most the entry in flight. Per-entry failures are
// logged and skipped — one unbriefable entry must not starve the other seven.

import fs from "node:fs";
import path from "node:path";
import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./tts-lib.mjs";
import {
  CMT_REPO,
  TODOS_PATH,
  REPLAN_SENTINEL,
  cmtRepoDir,
  yamlToJson,
  sourceHash,
  readBriefHashes,
  writeBriefHashes,
  briefCachePath,
  findEntryBlock,
} from "./tts-code-lib.mjs";

// At most this many briefs per cron run (all pending with --force). The cap
// bounds the run: 8 entries x the 10-minute per-entry Claude timeout is 80
// minutes worst case, safely inside the 2-hour cron cadence, so runs cannot
// pile up on each other even without a lock.
const MAX_PER_RUN = 8;
const PER_ENTRY_TIMEOUT_MS = 10 * 60 * 1000;
// Briefing gets a real exploration budget (vs the non-agentic default of 8):
// the model must open cited ledger/constitution/code files to judge whether a
// plan still matches the tree, and each file read is a turn.
const BRIEF_MAX_TURNS = 40;

const RECOMMENDATIONS = new Set(["propose-archive", "stale-replan", "needs-session", "execute"]);
const EXEC_CLASSES = new Set(["needs-turing", "box"]);

// Build the per-entry prompt. `entryYaml` is the entry's RAW block from
// todos.yaml (real YAML beats re-serialized JSON: Tom's comments and block
// scalars survive), `replanNote` is Tom's stale-replan note when a replan was
// requested, else null.
function briefPrompt(entryYaml, replanNote) {
  return [
    `You are briefing Tom on ONE entry of vqc/todos.yaml in the ComplexMultiTrigger`,
    `repo. Your working directory is a checkout of that repo at current master —`,
    `use your file-reading tools to open the files, ledger entries, and constitution`,
    `articles the entry cites, and any code the plan touches. Verify, don't assume.`,
    ``,
    `The entry:`,
    ``,
    entryYaml,
    ``,
    ...(replanNote !== null
      ? [
          `A replan was requested: Tom ruled this entry's existing plan stale` +
            (replanNote ? ` with the note: ${replanNote}` : `.`),
          `Propose a FRESH plan inside the brief, grounded in the current tree.`,
          ``,
        ]
      : []),
    `Write a GROUND-UP brief for Tom (~250-400 words). Ground-up means: define`,
    `every term the first time it appears, no invented names, concrete before`,
    `abstract — Tom's understanding is the bottleneck and the brief exists so he`,
    `can rule fast. Cover, in order:`,
    `- what this todo is and why it exists;`,
    `- what its attached plan (if any) would do;`,
    `- whether the plan still matches the CURRENT tree: check that the files and`,
    `  ledger entries it cites actually exist, and NAME anything stale.`,
    ``,
    `End with a recommendation chosen by EXACTLY these criteria, in order —`,
    `the first that applies wins:`,
    `1. The completion condition is already satisfied by landed work, or the`,
    `   intent is moot/superseded -> "propose-archive", and set "evidence" to the`,
    `   commits/files that prove it.`,
    `2. The intent is live but the plan is stale against the tree -> "stale-replan".`,
    `3. The plan is live but embeds an open judgment call Tom has not made —`,
    `   ALL tier-C entries land here by definition -> "needs-session".`,
    `4. All clean -> "execute".`,
    ``,
    `Also classify execClass: "needs-turing" if executing the plan requires the`,
    `SLURM cluster / GPUs, else "box" (runnable on an ordinary Linux box).`,
    ``,
    `Answer with ONLY a JSON object, no prose, no code fences:`,
    `{"brief": "...", "recommendation": "propose-archive|stale-replan|needs-session|approve",`,
    ` "execClass": "needs-turing|box", "evidence": "..." (optional)}`,
  ].join("\n");
}

// The local brief-cache markdown layout. apply-rulings.mjs depends on it:
// the "Evidence:" header line feeds archive resolutions, and the whole file
// body is embedded in needs-session agendas.
function briefCacheMarkdown(externalId, parsed) {
  return [
    `# TTS brief — ${CMT_REPO}:${externalId}`,
    ``,
    `Recommendation: ${parsed.recommendation}`,
    `Exec-class: ${parsed.execClass}`,
    ...(parsed.evidence ? [`Evidence: ${parsed.evidence}`] : []),
    ``,
    parsed.brief,
    ``,
  ].join("\n");
}

async function main() {
  const force = process.argv.includes("--force");
  const env = loadEnv();

  // Refresh the cache clone — the brief must describe the CURRENT tree, and
  // Claude's read tools get this directory as cwd.
  const repoDir = cmtRepoDir(env);
  const todosFile = path.join(repoDir, TODOS_PATH);
  const todosText = fs.readFileSync(todosFile, "utf8");
  const entries = yamlToJson(todosFile);
  if (!Array.isArray(entries)) {
    throw new Error(`${TODOS_PATH} did not parse to a list`);
  }

  // Open = no `closed` field. (The file also keeps closed entries below a
  // banner comment, but the field is the machine-readable truth — the banner
  // is for humans and the guard test enforces the pairing.)
  const open = entries.filter((e) => e && typeof e === "object" && !("closed" in e));

  const hashes = readBriefHashes();
  const pending = [];
  for (const entry of open) {
    const key = `${CMT_REPO}:${entry.id}`;
    const hash = sourceHash(entry);
    const prior = hashes[key];
    if (!force && prior === hash) continue; // unchanged since last brief
    const replan = typeof prior === "string" && prior.startsWith(REPLAN_SENTINEL);
    pending.push({
      entry,
      key,
      hash,
      // Tom's note rides in the sentinel after ": " (may be empty).
      replanNote: replan ? prior.slice(REPLAN_SENTINEL.length).replace(/^:\s*/, "") : null,
    });
  }

  if (pending.length === 0) {
    // Quiet exit keeps the every-2-hours cron log silent when nothing moved.
    return;
  }

  const batch = force ? pending : pending.slice(0, MAX_PER_RUN);
  console.log(
    `[brief-code-todos] ${pending.length} entr${pending.length === 1 ? "y" : "ies"} to brief, ` +
      `processing ${batch.length}${force ? " (--force)" : ""}`,
  );

  let failures = 0;
  for (const { entry, key, hash, replanNote } of batch) {
    try {
      // The raw YAML block for the prompt; fall back to JSON if the block
      // scan somehow misses (it shouldn't — the entry came from this file).
      const found = findEntryBlock(todosText, entry.id);
      const entryYaml = found ? found.block : JSON.stringify(entry, null, 2);

      const answer = runClaude(briefPrompt(entryYaml, replanNote), {
        cwd: repoDir, // non-agentic: read-only tools over the repo, no edits
        timeoutMs: PER_ENTRY_TIMEOUT_MS,
        maxTurns: BRIEF_MAX_TURNS,
      });
      const parsed = extractJsonObject(answer);

      // Validate hard — a brief with a garbage recommendation would render
      // as a broken ruling card in the UI, so fail THIS entry loudly instead.
      if (typeof parsed.brief !== "string" || parsed.brief.trim() === "") {
        throw new Error("answer has no brief text");
      }
      if (!RECOMMENDATIONS.has(parsed.recommendation)) {
        throw new Error(`invalid recommendation: ${JSON.stringify(parsed.recommendation)}`);
      }
      if (!EXEC_CLASSES.has(parsed.execClass)) {
        throw new Error(`invalid execClass: ${JSON.stringify(parsed.execClass)}`);
      }
      const evidence =
        typeof parsed.evidence === "string" && parsed.evidence.trim() !== ""
          ? parsed.evidence
          : undefined;

      // Durable in dependency order: Convex first (the system of record),
      // then the local brief cache, then the cursor — so a crash can only
      // leave us re-doing work, never believing work happened that didn't.
      await convexFetch(env, "/tts/code-briefs", {
        briefs: [
          {
            repo: CMT_REPO,
            externalId: entry.id,
            sourceHash: hash,
            brief: parsed.brief,
            recommendation: parsed.recommendation,
            execClass: parsed.execClass,
            ...(evidence ? { evidence } : {}),
          },
        ],
      });
      const cacheFile = briefCachePath(CMT_REPO, entry.id);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, briefCacheMarkdown(entry.id, { ...parsed, evidence }));
      hashes[key] = hash;
      writeBriefHashes(hashes);

      console.log(
        `[brief-code-todos] briefed ${entry.id}: ${parsed.recommendation} ` +
          `(${parsed.execClass}${replanNote !== null ? ", fresh plan after replan" : ""})`,
      );
    } catch (err) {
      failures++;
      console.error(`[brief-code-todos] ${entry.id} FAILED: ${err.message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures}/${batch.length} briefs failed (see lines above)`);
  }
}

main().catch((err) => {
  // Any hard failure: log and exit 1. No retries — the next cron tick (2h)
  // simply tries again from the cursor, and un-briefed entries just show as
  // "no brief yet" in the UI rather than breaking anything.
  console.error(`[brief-code-todos] FAILED: ${err.message}`);
  process.exit(1);
});
