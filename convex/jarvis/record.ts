// record.ts — the one insert into the `events` table.
//
// Every row of the record's events table comes through insertEvent: the
// route's mutation (events.ts record), the Convex-internal reporters
// (jobs.ts) and the copy from the previous generation's table. It validates
// with the same shared/jarvis-events.mjs the box imports, so a row Convex
// writes itself meets the shape the box's rows meet. It runs no kind hook:
// events.ts recordEvent is insertEvent plus the hooks, and an area whose own
// code writes a row it must not re-dispatch on (a recovery written from
// inside the job-ok hook) calls this directly.

import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { validateEvent } from "../../shared/jarvis-events.mjs";

/** The validator every mutation that takes an event uses; one spelling. */
export const eventArgs = {
  kind: v.string(),
  at: v.optional(v.number()),
  provenance: v.optional(
    v.object({
      agentId: v.optional(v.string()),
      job: v.optional(v.string()),
      session: v.optional(v.string()),
      user: v.optional(v.string()),
    }),
  ),
  subject: v.optional(v.string()),
  data: v.optional(v.any()),
  text: v.optional(v.string()),
};

export type EventInput = {
  kind: string;
  at?: number;
  provenance?: { agentId?: string; job?: string; session?: string; user?: string };
  subject?: string;
  data?: unknown;
  text?: string;
};

/** One row as the table stores it: what validateEvent answers. */
export type EventRow = {
  kind: string;
  at: number;
  provenance: { agentId?: string; job?: string; session?: string; user?: string };
  subject?: string;
  data: unknown;
  text?: string;
};

type CheckedEvent = { ok: true; event: EventRow } | { ok: false; error: string };

/** shared/jarvis-events.mjs validateEvent, typed for the TypeScript side. */
export function checkEvent(input: unknown, now = Date.now()): CheckedEvent {
  return validateEvent(input, { now }) as CheckedEvent;
}

/** Validate and insert one row; throws the validator's sentence on a bad one. */
export async function insertEvent(ctx: MutationCtx, input: EventInput): Promise<Id<"events">> {
  const checked = checkEvent(input);
  if (!checked.ok) throw new Error(checked.error);
  return await ctx.db.insert("events", checked.event);
}
