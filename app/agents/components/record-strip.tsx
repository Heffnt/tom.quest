"use client";

// THE RECORD'S NEWEST ROWS (night/s3, 2026-09-26). The `events` table is the
// one home of what ran (convex/schema.ts events); this strip shows its
// newest rows above the agents, whatever their kind, so a job's clean run,
// a failure or a deploy is on the page beside the agents that ran them.
// One list: a box change is drawn once, in its agent's chat (agent-rows.tsx
// BoxChangeLine, from convex/boxChanges.ts), and the copied row has no
// provenance.agentId, so it appears here as a line and there as a marker,
// never twice in one place.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatClock } from "../lib";

/** How many rows the strip shows. */
const RECORD_STRIP_ROWS = 12;

type EventRow = {
  _id: string;
  kind: string;
  at: number;
  provenance: { agentId?: string; job?: string; session?: string; user?: string };
  subject?: string;
  text?: string;
};

/** Who the row is from: the job, the agent, the session or the user. */
function eventActor(row: Pick<EventRow, "provenance">): string | undefined {
  const { job, agentId, session, user } = row.provenance;
  return job ?? agentId ?? session ?? user;
}

/** The line: the row's own text, else its subject, else nothing. */
function eventLine(row: Pick<EventRow, "text" | "subject">): string {
  return row.text ?? row.subject ?? "";
}

export default function RecordStrip() {
  const events = useQuery(api.jarvis.events.recent, { limit: RECORD_STRIP_ROWS }) as EventRow[] | undefined;
  if (events === undefined || events.length === 0) return null;
  return (
    <section data-record-strip className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-text-faint">record</div>
      <ul className="border border-border rounded-lg bg-surface/40 divide-y divide-border">
        {events.map((row) => (
          <li key={row._id} data-event-kind={row.kind} className="flex items-baseline gap-2 px-3 py-1 text-xs">
            <span className="font-mono text-[10px] text-text-faint shrink-0">{formatClock(row.at)}</span>
            <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-text-muted">
              {row.kind}
            </span>
            {eventActor(row) !== undefined && (
              <span className="shrink-0 font-mono text-text-muted">{eventActor(row)}</span>
            )}
            <span className="font-mono text-text-faint truncate min-w-0">{eventLine(row)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
