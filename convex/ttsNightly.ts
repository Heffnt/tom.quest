// The nightly record surface retains the legacy event pen.
// Learning and repository-rule proposal readers and writers are removed;
// model-of-tom publication lives in ttsSkills.ts.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
// The kinds this pen routes onward besides LEARNING_CHANGE. Their rows,
// their fields and the reasoning are documented where they are declared.
import { BOX_CHANGE, boxChangeEvent, boxChangeFaults, type BoxChange } from "./boxChanges";
import { copyDtsRow, recordEvent } from "./jarvis/events";
import { listForDigest } from "./jarvis/outbox";
import { LEARNING_CHECK_FAILED, REPO_PROPOSAL } from "./ttsDigest";

// ── The event pen ────────────────────────────────────────────────────────────
// The job's kinds are its own ("nightly-failure", "learning-run",
// "learning-change", "learning-reverted", "learning-revert-failed",
// "nightly-run", both the night's summary and, keyed `WikiTom@<sha>`, each
// commit it is about to push, which the merge gate reads: convex/ttsMerge.ts
// NIGHTLY_RUN); the pattern keeps the pen to lowercase kebab-case names
// rather than letting a worker write, say, "slack-sent" and confuse the
// digest's own bookkeeping — the route refuses the kinds Convex writes itself.
export const EVENT_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const RESERVED_EVENT_KINDS = new Set([
  "slack-sent",
  "slack-event",
]);
/** A line the nightly job wrote about Tom is a decision taken in his name, so
 *  it is a line on the digest's objection list (internalRecordWorkerEvent,
 *  listForDigest), its id printed: "revert <n>" or a reply naming the id in
 *  the digest's thread objects to it. */
export const LEARNING_CHANGE = "learning-change";

/**
 * A box change posted through the legacy pen (POST /tts/event, body { kind:
 * "box-change", data, key }), recorded as the `events` row POST /jarvis/event
 * would write (convex/boxChanges.ts boxChangeEvent), hook and all. The pen's
 * `key` was the agentId; it must still agree with data.agentId. Here only
 * while a box that has not deployed Jarvis night/w4 still posts box changes
 * through the pen; goes with the pen.
 */
export const internalRecordBoxChange = internalMutation({
  args: { data: v.any(), key: v.optional(v.string()) },
  handler: async (ctx, { data, key }) => {
    const faults = boxChangeFaults(data);
    if (faults.length > 0) throw new Error(`not a box change: ${faults.join("; ")}`);
    const change = data as BoxChange;
    if (key !== change.agentId) throw new Error("a box change's key is its agentId, and it has none when the agentId is absent");
    const { id, result } = await recordEvent(ctx, boxChangeEvent(change));
    return { id: id as string, duplicate: (result as { duplicate?: boolean } | undefined)?.duplicate === true };
  },
});

export const internalRecordWorkerEvent = internalMutation({
  // `key`: the indexed lookup key (schema dtsEvents.key) — the weekly job's
  // "weekly-run" row carries its day, so a rerun finds it on by_kind_key.
  args: { kind: v.string(), data: v.optional(v.any()), key: v.optional(v.string()) },
  handler: async (ctx, { kind, data, key }) => {
    if (!EVENT_KIND_PATTERN.test(kind) || RESERVED_EVENT_KINDS.has(kind)) {
      throw new Error(`not a worker event kind: ${kind}`);
    }
    // A box change is a row of the record's events table, not of this one
    // (internalRecordBoxChange below; POST /tts/event hands it there).
    if (kind === BOX_CHANGE) throw new Error("a box change is recorded through POST /jarvis/event");
    const row = { at: Date.now(), kind, data, key };
    const id = await ctx.db.insert("dtsEvents", row);
    // The same row in the one record, in this transaction (jarvis/events.ts
    // copyDtsRow): a second mutation could fail or be retried after the first
    // committed, leaving one table without the row or the other with two.
    await copyDtsRow(ctx, row);
    // A failure row written here (the nightly's, the weekly's) is a line in
    // the digest's broken section, which reads every "-failed"/"-failure" row
    // of its window (convex/ttsDigest.ts); the decisions below are lines on
    // its objection list (convex/jarvis/outbox.ts listForDigest). One output
    // channel: nothing here posts to Slack.
    if (kind === LEARNING_CHANGE) {
      const d = (data ?? {}) as Record<string, unknown>;
      const file = typeof d.file === "string" ? d.file : "a model-of-Tom page";
      const after = typeof d.after === "string" ? d.after : "";
      const before = typeof d.before === "string" ? d.before : "";
      const evidence = typeof d.evidence === "string" ? d.evidence : undefined;
      // The id is printed so a reply naming it is an objection to this line
      // (convex/ttsSlack.ts namedLearningChange), as "revert <n>" is.
      const named = typeof d.id === "string" ? ` [${d.id}]` : "";
      await listForDigest(ctx, {
        section: "decisions",
        askId: typeof d.id === "string" ? `learning:${d.id}` : `learning:${id}`,
        decision:
          before === ""
            ? `${file} now says ${after}${named}`
            : `${file} now says ${after} rather than ${before}${named}`,
        ...(evidence === undefined ? {} : { reason: `it was learned from ${evidence}` }),
      });
    }
    // A REPOSITORY-RULE PROPOSAL is the same act one directory over: the
    // repository-rule proposals remain renderable in history and the digest
    // when legacy rows are recorded.
    if (kind === REPO_PROPOSAL) {
      const d = (data ?? {}) as Record<string, unknown>;
      const repo = typeof d.repo === "string" ? d.repo : "a repository";
      const file = typeof d.file === "string" ? d.file : "its rules";
      const line = typeof d.line === "string" ? d.line : "";
      const read = typeof d.read === "string" ? d.read : undefined;
      await listForDigest(ctx, {
        section: "decisions",
        askId: typeof d.id === "string" ? `repo-proposal:${d.id}` : `repo-proposal:${id}`,
        decision: `${repo} ${file} is to say ${line}${typeof d.id === "string" ? ` [${d.id}]` : ""}`,
        ...(read === undefined ? {} : { reason: `last night's sessions ${read}` }),
      });
    }
    // A SIMPLIFICATION PROPOSAL and a REMOVAL-LOOP PULL REQUEST are read from
    // their own rows by the digest's objection list (convex/ttsDigest.ts),
    // keyed as they are here, so "revert <n>" in the digest's thread resolves
    // the same row; a dry run's row goes to nobody.
    // THE NIGHT THAT UNDID ITSELF. Not a decision — nothing stands to object
    // to — and not a quiet night either, which is exactly the confusion a
    // silent row would create. A broken line in the digest, in its own words
    // (the digest's generic line for the "-failed" row is skipped for it).
    if (kind === LEARNING_CHECK_FAILED) {
      const d = (data ?? {}) as Record<string, unknown>;
      const changes = typeof d.changes === "number" ? d.changes : typeof d.count === "number" ? d.count : 0;
      await listForDigest(ctx, {
        section: "broken",
        job: "learning",
        statement:
          d.baseline === true
            ? "The learning job wrote nothing about you last night: the evidence file was already failing its own check before the run started."
            : `The learning job wrote ${changes} line${changes === 1 ? "" : "s"} about you last night and took every one back: the evidence check failed after the write.`,
      });
    }
    return id;
  },
});
