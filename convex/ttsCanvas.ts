// Canvas LMS assignments, the Convex half (spec §17 post-MVP priority 1).
// ONE dtsTodos row per upcoming assignment — source "canvas", dated with the
// assignment's real due time (dateKind "external"), provenance carrying the
// assignment id + link.
//
// THE FETCH HALF IS NOT HERE ANY MORE (the lifeos update, phase 6). It used to
// be a Convex cron action holding a second copy of CANVAS_TOKEN in the
// deployment env. Now worker/jobs/poll-canvas.mjs — which already polled
// Canvas every 30 minutes for announcements — reads the assignments too and
// posts them to POST /tts/canvas-assignments, which lands in the sync below.
// ONE job and ONE credential copy own Canvas: the token lives only in
// /etc/tts/worker.env. What is left in this file is the part that must be a
// mutation because it writes todos.
//
// Statuses stay truthful BY AGENTS, never by Tom's bookkeeping (spec §6): when
// Canvas shows a submission, the sync marks the todo done and records the
// date outcome; when the instructor moves a due date, the todo's date moves
// with it (an external date is a fact, not a renegotiation).
//
// NAME NOTE: convex/canvas.ts is the design-canvas page (unrelated). This is
// ttsCanvas on purpose.
//
// SOURCE NOTE (2026-09-01): this file owns the source "canvas" and it means
// exactly one thing — a Canvas ASSIGNMENT, provenance `canvas:assignment:<id>
// <url>`. Canvas ANNOUNCEMENTS are a different fact from the same job and
// carry their own source, "canvas-announcement". They shared the name until
// the read below — which keys every "canvas" row by the assignment provenance
// shape — was found to be reading announcements on every sync and dropping
// them without a word.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { applyDateOutcome, applyStatusChange, logEvent } from "./tts";

export const ASSIGNMENT_INPUT = v.object({
  externalId: v.string(), // Canvas assignment id, as a string
  courseCode: v.string(),
  name: v.string(),
  htmlUrl: v.string(),
  dueAt: v.number(), // epoch ms — the real Canvas due instant
  submitted: v.boolean(),
});
export type AssignmentInput = {
  externalId: string;
  courseCode: string;
  name: string;
  htmlUrl: string;
  dueAt: number;
  submitted: boolean;
};

/** The source this file writes and reads. Assignments only — see SOURCE NOTE. */
export const ASSIGNMENT_SOURCE = "canvas";

export function canvasProvenance(externalId: string, htmlUrl: string): string {
  return `canvas:assignment:${externalId} ${htmlUrl}`;
}

/** The assignment id a canvas-sourced todo's provenance names, or null. */
export function provenanceExternalId(provenance: string | undefined): string | null {
  const match = /^canvas:assignment:(\S+)/.exec(provenance ?? "");
  return match ? match[1] : null;
}

// ── The sync half ────────────────────────────────────────────────────────────

export const internalSyncCanvasTodos = internalMutation({
  args: { assignments: v.array(ASSIGNMENT_INPUT) },
  handler: async (ctx, { assignments }) => {
    const now = Date.now();
    const sourceRows = await ctx.db
      .query("dtsTodos")
      .withIndex("by_source", (q) => q.eq("source", ASSIGNMENT_SOURCE))
      .collect();
    // Narrowed to the ASSIGNMENT provenance shape, and the rows that fail that
    // shape are counted rather than dropped in silence. Under one source that
    // means one thing this count is 0 forever; if it is not, something else is
    // writing "canvas" and the sync would otherwise treat those rows as
    // assignments it has never seen (and, in any future write path over this
    // collection, write to them).
    const assignmentRows: typeof sourceRows = [];
    let foreign = 0;
    for (const row of sourceRows) {
      if (provenanceExternalId(row.provenance) === null) foreign++;
      else assignmentRows.push(row);
    }
    if (foreign > 0) {
      console.error(
        `TTS canvas sync: ${foreign} row(s) under source "${ASSIGNMENT_SOURCE}" carry no canvas:assignment: provenance — not assignments, skipped.`,
      );
    }
    const byExternalId = new Map(
      assignmentRows.map((t) => [provenanceExternalId(t.provenance) as string, t]),
    );

    let created = 0;
    let completed = 0;
    let dateMoved = 0;
    for (const a of assignments) {
      const todo = byExternalId.get(a.externalId);
      if (!todo) {
        // Submitted-before-we-ever-saw-it needs no todo; nothing was lost
        // because nothing was ever tracked.
        if (a.submitted) continue;
        const id = await ctx.db.insert("dtsTodos", {
          statement: `${a.courseCode}: ${a.name}`,
          readiness: "unprepared",
          status: "active",
          timingClass: "dated",
          dueAt: a.dueAt,
          dateKind: "external",
          kind: "task",
          actor: "tom",
          entryAction: a.htmlUrl ? `Open ${a.htmlUrl}` : undefined,
          source: ASSIGNMENT_SOURCE,
          provenance: canvasProvenance(a.externalId, a.htmlUrl),
          createdAt: now,
          updatedAt: now,
        });
        await logEvent(ctx, "captured", id, { source: ASSIGNMENT_SOURCE });
        created++;
        continue;
      }

      const open = todo.status === "active" || todo.status === "waiting";
      // The instructor moved the date: an external fact, applied as-is.
      // Compare at minute precision — Canvas timestamps come back with
      // second-level jitter on some endpoints.
      if (
        open &&
        !a.submitted &&
        todo.dueAt !== undefined &&
        Math.abs(todo.dueAt - a.dueAt) > 60_000
      ) {
        await ctx.db.patch(todo._id, {
          dueAt: a.dueAt,
          timingClass: "dated",
          updatedAt: now,
        });
        await logEvent(ctx, "updated", todo._id, {
          fields: ["dueAt"],
          via: "canvas-sync",
        });
        dateMoved++;
      }
      if (open && a.submitted) {
        const fresh = await ctx.db.get(todo._id);
        if (!fresh) continue;
        // Both doors log their own events ("date-outcome" / "status-changed").
        if (fresh.dueAt !== undefined) {
          await applyDateOutcome(ctx, fresh, {
            outcome: "done",
            note: "submitted on Canvas",
          });
        } else {
          await applyStatusChange(ctx, fresh, {
            status: "done",
            note: "submitted on Canvas",
          });
        }
        completed++;
      }
    }
    return { seen: assignments.length, created, completed, dateMoved, foreign };
  },
});
