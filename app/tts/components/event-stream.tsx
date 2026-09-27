"use client";

// The todo event stream: the newest rows of dtsEvents (captures, rulings,
// delegate answers, session outcomes, status changes and the rest), newest
// first, straight from api.tts.listRecentEvents. Each row names its time, its
// kind and the todo it concerns; pressing it shows the row's raw JSON. It is
// the frame's bottom drawer on /tts: the raw record under the page.

import { useState } from "react";
import type { Doc, Id } from "@/convex/_generated/dataModel";

type EventRow = Doc<"dtsEvents">;

function fmtAt(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${date} ${time}`;
}

function EventLine({ row, statement }: { row: EventRow; statement: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-row-dense w-full items-center gap-3 px-3 text-left text-[13px] hover:bg-surface-alt"
      >
        <span className="w-32 shrink-0 font-mono text-[12px] text-text-faint">{fmtAt(row.at)}</span>
        <span className="w-44 shrink-0 truncate font-mono text-[12px] text-accent">{row.kind}</span>
        <span className="min-w-0 truncate text-text-muted">{statement ?? (row.todoId ? row.todoId : "")}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto bg-surface px-3 py-2 font-mono text-[12px] leading-[1.35] text-text-muted">
          {JSON.stringify(row, null, 2)}
        </pre>
      )}
    </li>
  );
}

export default function EventStream({
  rows,
  statements,
}: {
  rows: EventRow[] | undefined;
  statements: ReadonlyMap<Id<"dtsTodos">, string>;
}) {
  if (rows === undefined) return <p className="p-3 text-[13px] text-text-faint">Loading…</p>;
  if (rows.length === 0) return <p className="p-3 text-[13px] text-text-faint">No events.</p>;
  return (
    <ul>
      {rows.map((row) => (
        <EventLine key={row._id} row={row} statement={row.todoId ? statements.get(row.todoId) : undefined} />
      ))}
    </ul>
  );
}
