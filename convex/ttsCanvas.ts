// Canvas LMS ingestion (spec §17 post-MVP priority 1, "easiest integration"):
// a cron action pulls Tom's course assignments over the Canvas REST API with a
// personal access token, and a sync mutation keeps one dtsTodos row per
// upcoming assignment — source "canvas", dated with the assignment's real due
// time (dateKind "external"), provenance carrying the assignment id + link.
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
// <url>`. Canvas ANNOUNCEMENTS are a different fact from a different producer
// (worker/jobs/poll-canvas.mjs) and carry their own source,
// "canvas-announcement". They shared the name until the read below — which
// keys every "canvas" row by the assignment provenance shape — was found to
// be reading announcements on every sync and dropping them without a word.
//
// Env (Convex deployment): CANVAS_TOKEN (personal access token — Canvas →
// Account → Settings → "+ New access token"), CANVAS_BASE_URL (defaults to
// https://canvas.wpi.edu). Missing token = quiet no-op, so the cron ships
// ahead of the credential.

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { applyDateOutcome, applyStatusChange, logEvent } from "./tts";
import { DAY_MS } from "./ttsShared";

/** How far around now an unsubmitted assignment is worth a todo. */
const PAST_GRACE_DAYS = 14; // recently overdue still needs handling
const FUTURE_WINDOW_DAYS = 60;

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

// ── The fetch half ───────────────────────────────────────────────────────────

type CanvasCourse = { id: number; course_code?: string; name?: string };
type CanvasAssignment = {
  id: number;
  name?: string;
  html_url?: string;
  due_at?: string | null;
  published?: boolean;
  submission?: { submitted_at?: string | null; workflow_state?: string } | null;
};

/** Canvas paginates via Link headers; follow rel="next", bounded. */
async function canvasGetAll<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${baseUrl}${path}`;
  for (let page = 0; page < 10 && url; page++) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`canvas ${path} -> HTTP ${res.status}`);
    out.push(...((await res.json()) as T[]));
    const link = res.headers.get("link") ?? "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  return out;
}

/** Pure mapping: raw Canvas JSON → sync inputs. Exported for tests. */
export function mapCanvasAssignments(
  courses: CanvasCourse[],
  assignmentsByCourse: Map<number, CanvasAssignment[]>,
  now: number,
): AssignmentInput[] {
  const out: AssignmentInput[] = [];
  const windowStart = now - PAST_GRACE_DAYS * DAY_MS;
  const windowEnd = now + FUTURE_WINDOW_DAYS * DAY_MS;
  for (const course of courses) {
    const courseCode = course.course_code ?? course.name ?? `course ${course.id}`;
    for (const a of assignmentsByCourse.get(course.id) ?? []) {
      if (a.published === false) continue;
      if (!a.due_at) continue; // undated assignments are not obligations yet
      const dueAt = Date.parse(a.due_at);
      if (Number.isNaN(dueAt) || dueAt < windowStart || dueAt > windowEnd) continue;
      out.push({
        externalId: String(a.id),
        courseCode,
        name: a.name ?? `assignment ${a.id}`,
        htmlUrl: a.html_url ?? "",
        dueAt,
        submitted: Boolean(a.submission?.submitted_at),
      });
    }
  }
  return out;
}

// The explicit handler return type breaks the api-type circularity a
// returned ctx.runMutation(internal.ttsCanvas.…) result would create.
type RefreshResult =
  | { skipped: string }
  | {
      seen: number;
      created: number;
      completed: number;
      dateMoved: number;
      // Rows under source "canvas" that are not assignments — see the
      // narrowed read in internalSyncCanvasTodos. Expected 0.
      foreign: number;
    };

export const internalRefreshCanvas = internalAction({
  args: {},
  handler: async (ctx): Promise<RefreshResult> => {
    const token = process.env.CANVAS_TOKEN;
    if (!token) return { skipped: "CANVAS_TOKEN not set" };
    const baseUrl = (
      process.env.CANVAS_BASE_URL ?? "https://canvas.wpi.edu"
    ).replace(/\/+$/, "");

    const courses = await canvasGetAll<CanvasCourse>(
      baseUrl,
      token,
      "/api/v1/courses?enrollment_state=active&per_page=100",
    );
    const assignmentsByCourse = new Map<number, CanvasAssignment[]>();
    for (const course of courses) {
      assignmentsByCourse.set(
        course.id,
        await canvasGetAll<CanvasAssignment>(
          baseUrl,
          token,
          `/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`,
        ),
      );
    }
    const assignments = mapCanvasAssignments(
      courses,
      assignmentsByCourse,
      Date.now(),
    );
    return await ctx.runMutation(internal.ttsCanvas.internalSyncCanvasTodos, {
      assignments,
    });
  },
});

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
