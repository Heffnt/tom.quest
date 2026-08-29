#!/usr/bin/env node
// form-batches.mjs — group life + code todos into batches via headless Claude.
//
// Run by cron every 6 hours at :07 UTC (see /etc/cron.d/dts). Manual run:
//   node /opt/dts/form-batches.mjs
//
// WHY: one working session should unblock MANY todos — the effort Tom spends
// understanding a corner of the code (or a corner of his life) amortizes over
// every todo that corner touches. A batch is a real dtsTodos row with
// `members`: this job proposes the grouping, the plan, and an importance
// estimate; Tom rules. The batcher groups, Tom rules — nothing here executes
// anything, and the server (internalStoreBatches) enforces every gate: it
// only rewrites source-"batcher" rows Tom has never touched, and drops (not
// rejects) any batch that fails validation, reporting each skip back.
//
// REVISE RULINGS: Tom can rule "revise" on a batch with one written sentence.
// This job collects the pending life-revise rulings whose subject is a
// members-bearing todo, embeds the sentences in the prompt (they override any
// other reading), and consumes each via /dts/ruling-applied only once the
// server reports that batch as stored — a skipped batch leaves its ruling
// pending for the next run. A revise verdict no longer freezes the batch
// (server-side fix): it must stay rewritable for the re-form to land, so the
// "frozen" flag in the prompt reflects only Tom's OTHER touches (edits,
// status changes, importance he set himself).
//
// NOTES ON THE OTHER VERDICTS (2026-08-29): approve / session / archive may
// each carry a written note too. The approve and session ones are NOT commands
// to re-form anything and are never consumed — they are standing steering
// context (what he approved and why, what he wants talked through), injected
// alongside the ruling history so the groupings track what he actually wants.
// ARCHIVE notes are left out: an archive sentence is the unarchive CONDITION
// for one retired item, not steering about what to group.
//
// NO-STATE RULE: Convex is read and written each run. The only local file is
// the input-hash cursor in /var/lib/dts/ — losing it merely costs one extra
// Claude invocation on inputs that had not changed (brief-hashes pattern).

import fs from "node:fs";
import { createHash } from "node:crypto";
import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./dts-lib.mjs";

const HASH_PATH = "/var/lib/dts/batch-input-hash";
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

function prompt(ctx) {
  return [
    `You are the batcher for DTS, Tom's personal todo system. A "batch" is a`,
    `grouping of several todos — life todos (personal tasks) and code todos`,
    `(entries in his repos' todo files) — that one working session with Tom can`,
    `advance together, because they share the context he would have to load`,
    `anyway. You group; Tom rules. Your output only PROPOSES groupings, plans,`,
    `and importance estimates — it executes nothing.`,
    ``,
    `No explicit model of Tom exists yet. Infer his priorities from the todo`,
    `corpus below and from his ruling history. Every importance estimate`,
    `carries a one-line rationale. Language is descriptive, never evaluative —`,
    `no praise, no urgency theater. Define any term Tom might not know; invent`,
    `no names.`,
    ``,
    `ACTIVE LIFE TODOS not in any batch (JSON; each: id, statement, brief,`,
    `category, importance, dueAt — dueAt is epoch ms or null):`,
    JSON.stringify(ctx.life, null, 2),
    ``,
    `OPEN CODE TODOS with prepared briefs (JSON; each: repo, externalId,`,
    `statement, importance):`,
    JSON.stringify(ctx.code, null, 2),
    ``,
    `EXISTING BATCHES (JSON; each: id, statement, status, frozen, members,`,
    `plan):`,
    JSON.stringify(ctx.batches, null, 2),
    ``,
    `A batch with "frozen": true has been touched by Tom and is OFF LIMITS:`,
    `never output its id, never archive it, and never place any of its members`,
    `in another batch.`,
    ``,
    ...(ctx.archivedStatements.length > 0
      ? [
          `ARCHIVED BATCH STATEMENTS — groupings that were retired. Do NOT`,
          `recreate an equivalent grouping under a new name:`,
          ...ctx.archivedStatements.map((s) => `- ${s}`),
          ``,
        ]
      : []),
    ...(ctx.revises.length > 0
      ? [
          `Tom ruled "revise" on these batches — each sentence redirects the`,
          `re-forming and overrides any other reading of the inputs:`,
          ...ctx.revises.map((r) => `- batch "${r.statement}": ${r.sentence}`),
          ``,
        ]
      : []),
    ...(ctx.notes.length > 0
      ? [
          `NOTES TOM WROTE WITH HIS APPROVE AND SESSION RULINGS. These are`,
          `steering context about what he wants, not instructions to re-form a`,
          `specific batch and not items to act on:`,
          ...ctx.notes.map((n) => `- [${n.verdict}] ${n.subject}: ${n.sentence}`),
          ``,
        ]
      : []),
    `TOM'S RECENT RULINGS, newest first (behavioral evidence: what he`,
    `approves, revises, sends to a session, archives — use it to infer what`,
    `he cares about, not as items to act on):`,
    JSON.stringify(ctx.recentRulings, null, 2),
    ``,
    `TASK — output the FULL desired batch set (not a diff). Rules:`,
    `- 3-10 members per batch. Each member appears in at most one batch. A`,
    `  batch is never itself a member.`,
    `- Member shape: {"todoId": "..."} for a life todo, {"repo": "...",`,
    `  "externalId": "..."} for a code todo — ids VERBATIM from the inputs.`,
    `- "id" ONLY when rewriting an existing unfrozen batch from the list`,
    `  above; omit it for new batches.`,
    `- "statement" — short, names what the grouping is about, plain words.`,
    `- "brief" — 2-5 sentences, ground-up: what this grouping is, why these`,
    `  items belong together, what one session on it would accomplish.`,
    `- "plan" — ordered, smallest concrete steps. actor "agent" for what an`,
    `  agent does, "tom" for what needs Tom — phrase Tom's steps as the`,
    `  decision or action put to him. New steps get status "open". When`,
    `  rewriting an existing batch, carry its done steps forward verbatim`,
    `  (text, actor, status, doneAt, evidence).`,
    `- "importanceLevel" — "low" | "medium" | "high", with a one-line`,
    `  "importanceRationale".`,
    `- "archiveIds" — ids of unfrozen batches whose members are all closed or`,
    `  terminal, or whose members this output regroups elsewhere.`,
    `- Not every todo belongs in a batch — leave poor fits out.`,
    ``,
    `Answer ONLY a JSON object, no prose, no code fences:`,
    `{"batches": [{"id": "...", "statement": "...", "brief": "...",`,
    ` "members": [{"todoId": "..."}, {"repo": "...", "externalId": "..."}],`,
    ` "plan": [{"text": "...", "actor": "tom", "status": "open"}],`,
    ` "importanceLevel": "...", "importanceRationale": "..."}],`,
    ` "archiveIds": ["..."]}`,
  ].join("\n");
}

async function main() {
  const env = loadEnv();

  // --- Gather context ------------------------------------------------------
  const { todos, mirror, briefs, recentRulings } = await convexFetch(
    env,
    "/dts/batch-context",
  );
  const { pending } = await convexFetch(env, "/dts/rulings");

  const all = Array.isArray(todos) ? todos : [];
  const batchById = new Map(
    all.filter((t) => t.members !== undefined).map((t) => [t._id, t]),
  );

  // Pending revise rulings ON BATCHES only — a revise on a plain life todo
  // belongs to prepare-life-todos.mjs, which reads the same feed.
  const revises = [];
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "life" || r.verdict !== "revise" || !r.todoId) continue;
    const batch = batchById.get(r.todoId);
    if (batch) {
      revises.push({ ruling: r, statement: batch.statement, sentence: r.sentence ?? "" });
    }
  }

  // Notes Tom wrote with his APPROVE and SESSION verdicts (2026-08-29: every
  // verdict may carry a sentence). Unlike a revise sentence — which commands a
  // re-form and is consumed — these are standing steering context: what he
  // approved and why, what he wants talked through. Newest first, bounded.
  //
  // ARCHIVE sentences are excluded on purpose: an archive note is the
  // UNARCHIVE CONDITION ("when the lease is up"), a fact about one retired
  // item, not a statement of what Tom wants grouped. Feeding conditions in here
  // as steering invites the model to re-form around things Tom just set aside.
  const NOTE_MAX = 20;
  const recent = Array.isArray(recentRulings) ? recentRulings : [];
  const notes = recent
    .filter(
      (r) =>
        (r.verdict === "approve" || r.verdict === "session") &&
        (r.sentence ?? "").trim() !== "",
    )
    .slice(0, NOTE_MAX)
    .map((r) => ({
      verdict: r.verdict,
      subject:
        r.subjectType === "life"
          ? `life "${all.find((t) => t._id === r.todoId)?.statement ?? r.todoId}"`
          : `code ${r.repo} ${r.externalId}`,
      sentence: r.sentence.trim(),
    }));

  const batchRows = [...batchById.values()]
    .filter((t) => t.status === "active" || t.status === "waiting")
    .map((t) => ({
      id: t._id,
      statement: t.statement,
      status: t.status,
      frozen: t.tomTouchedAt !== undefined,
      members: t.members,
      plan: t.plan ?? null,
    }));
  const archivedStatements = [...batchById.values()]
    .filter((t) => t.status === "archived" || t.status === "done")
    .map((t) => t.statement);

  // Every member already claimed by a non-terminal batch, frozen ones
  // included. The prompt promises the todo lists hold only todos "not in any
  // batch", so the projections below must honour it: offering a claimed
  // subject invites the model to regroup it, and the server then drops the
  // whole offending batch (a member may live in at most one batch, and a
  // frozen batch's members are off limits) — a wasted Claude call either way.
  const memberKey = (m) =>
    m.todoId !== undefined ? `life ${m.todoId}` : `code ${m.repo} ${m.externalId}`;
  const claimed = new Set(
    batchRows.flatMap((b) => (Array.isArray(b.members) ? b.members.map(memberKey) : [])),
  );

  // Compact projections — exactly the fields the model groups by, nothing
  // that tempts it to edit content.
  const life = all
    .filter(
      (t) =>
        t.status === "active" &&
        t.members === undefined &&
        !claimed.has(`life ${t._id}`),
    )
    .map((t) => ({
      id: t._id,
      statement: t.statement,
      brief: t.brief ?? null,
      category: t.category ?? null,
      importance: t.importance
        ? { level: t.importance.level, setBy: t.importance.setBy, rationale: t.importance.rationale ?? null }
        : null,
      dueAt: t.dueAt ?? null,
    }));

  const briefByKey = new Map(
    (Array.isArray(briefs) ? briefs : []).map((b) => [`${b.repo} ${b.externalId}`, b]),
  );
  const code = (Array.isArray(mirror) ? mirror : []).flatMap((m) => {
    const brief = briefByKey.get(`${m.repo} ${m.externalId}`);
    // Only open AND briefed code todos are batchable — an unbriefed entry has
    // nothing a session could amortize yet. Claimed ones are already in a
    // batch, so they are not on offer here either.
    if (m.status !== "open" || !brief) return [];
    if (claimed.has(`code ${m.repo} ${m.externalId}`)) return [];
    return [
      {
        repo: m.repo,
        externalId: m.externalId,
        statement: m.statement,
        importance: brief.importance
          ? { level: brief.importance.level, setBy: brief.importance.setBy, rationale: brief.importance.rationale ?? null }
          : null,
      },
    ];
  });

  if (life.length === 0 && code.length === 0 && batchRows.length === 0) {
    return; // nothing to group, nothing to retire — quiet when idle
  }

  // --- Input hash: skip the Claude call when nothing changed ----------------
  // The hash covers everything the model sees; a pending batch-revise forces
  // a run regardless (the sentence must be consumed even if re-ruled
  // identically). The cursor file is harmless to lose — one wasted run.
  const reviseSentences = revises.map((r) => r.sentence);
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        life,
        code,
        batches: batchRows,
        archivedStatements,
        reviseSentences,
        notes,
      }),
    )
    .digest("hex");
  let storedHash = null;
  try {
    storedHash = fs.readFileSync(HASH_PATH, "utf8").trim();
  } catch {
    // no cursor yet — first run, or the box was rebuilt
  }
  if (inputHash === storedHash && revises.length === 0) return; // quiet when idle

  // --- One Claude call for the whole desired set ---------------------------
  console.log(
    `[form-batches] ${life.length} life + ${code.length} code todos, ` +
      `${batchRows.length} existing batch(es), ${revises.length} revise ruling(s) — asking Claude…`,
  );
  const answer = runClaude(
    prompt({
      life,
      code,
      batches: batchRows,
      archivedStatements,
      revises,
      notes,
      recentRulings: recent.map((r) => ({
        subjectType: r.subjectType,
        todoId: r.todoId ?? null,
        repo: r.repo ?? null,
        externalId: r.externalId ?? null,
        verdict: r.verdict,
        sentence: r.sentence ?? null,
        ruledAt: r.ruledAt,
      })),
    }),
    { timeoutMs: CLAUDE_TIMEOUT_MS },
  );
  const parsed = extractJsonObject(answer);
  if (!Array.isArray(parsed.batches)) {
    throw new Error(`bad shape (no batches array): ${JSON.stringify(parsed).slice(0, 120)}`);
  }

  // --- Ship it; the server's skip report is the real validator -------------
  let result;
  try {
    result = await convexFetch(env, "/dts/batches", {
      batches: parsed.batches,
      ...(Array.isArray(parsed.archiveIds) ? { archiveIds: parsed.archiveIds } : {}),
    });
  } catch (err) {
    // Nothing landed, so nothing is consumed: every revise ruling stays
    // pending and the next run re-forms on the same sentences. No cursor is
    // written either (see the ordering note below).
    console.error(
      `[form-batches] store FAILED — ${revises.length} revise ruling(s) left pending: ${err.message}`,
    );
    throw err;
  }
  console.log(
    `[form-batches] stored: ${result.created} created, ${result.updated} updated, ` +
      `${result.archived} archived, ${(result.skipped ?? []).length} skipped`,
  );
  for (const s of result.skipped ?? []) {
    console.log(`[form-batches] skipped ${s.ref}: ${s.why}`);
  }

  // Consume a batch-revise ruling ONLY when its re-form actually landed. The
  // server DROPS a batch that fails validation instead of rejecting the whole
  // POST, so a skip means Tom's sentence was never served: consuming the
  // ruling there would retire it silently and the grouping would stay wrong.
  // Left pending, it forces the next run (the hash check is bypassed while a
  // revise is pending) to try again. A skip's `ref` is the batch id when the
  // model reused one, its statement otherwise — match on both.
  const skippedRefs = new Set((result.skipped ?? []).map((s) => s.ref));
  for (const r of revises) {
    if (skippedRefs.has(r.ruling.todoId) || skippedRefs.has(r.statement)) {
      console.log(
        `[form-batches] revise ruling for "${r.statement}" left pending: ` +
          `the re-formed batch was skipped by the server`,
      );
      continue;
    }
    await convexFetch(env, "/dts/ruling-applied", {
      id: r.ruling._id,
      result: "revised: batches re-formed",
    });
  }

  // Hash written LAST (Convex-first durability ordering): a crash anywhere
  // above leaves no cursor, so the next cron run simply redoes the work.
  fs.writeFileSync(HASH_PATH, inputHash + "\n");
}

main().catch((err) => {
  console.error(`[form-batches] FAILED: ${err.message}`);
  process.exit(1);
});
