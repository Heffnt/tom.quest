"use client";

import { forwardRef } from "react";
import type { Action, Told } from "@/convex/historyRows";
import { displayDayKey, displayTime } from "@/shared/clock.mjs";

export type DayColumn = { day: string; told: Told[]; actions: Action[] };

function ActionLine({ action }: { action: Action }) {
  if (action.href === null) return <span>{action.text}</span>;
  const external = action.href.startsWith("http");
  return (
    <a
      href={action.href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="underline decoration-text-faint underline-offset-2 transition-colors hover:text-text hover:decoration-text"
    >
      {action.text}
    </a>
  );
}

/**
 * One column per day, oldest on the left. The row is laid out right to left
 * so that its scroll starts at the newest day without the page scrolling it.
 */
const DayColumns = forwardRef<HTMLDivElement, { columns: DayColumn[]; columnRef: (day: string, node: HTMLElement | null) => void }>(
  function DayColumns({ columns, columnRef }, ref) {
    return (
      <div ref={ref} aria-label="Days in the range" className="flex flex-row-reverse gap-3 overflow-x-auto pb-2">
        {[...columns].reverse().map((column) => (
          <article
            key={column.day}
            ref={(node) => columnRef(column.day, node)}
            aria-label={displayDayKey(column.day)}
            data-day={column.day}
            className="flex max-h-[40rem] w-72 shrink-0 flex-col rounded-lg border border-border bg-surface/40"
          >
            <h3 className="border-b border-border px-3 py-2 font-mono text-xs text-text-faint">{displayDayKey(column.day)}</h3>
            <div className="min-h-24 flex-1 space-y-3 overflow-y-auto px-3 py-2">
              {column.told.length > 0 && (
                <section aria-label="Tom">
                  <h4 className="mb-1 text-xs font-medium text-text-muted">Tom</h4>
                  <ul className="space-y-2">
                    {column.told.map((told) => (
                      <li key={told.id} className="text-sm leading-5 text-text">
                        <time dateTime={new Date(told.at).toISOString()} className="mr-1.5 text-xs tabular-nums text-text-faint">{displayTime(told.at)}</time>
                        <span className="whitespace-pre-wrap break-words">{told.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {column.actions.length > 0 && (
                <section aria-label="Jarvis">
                  <h4 className="mb-1 text-xs font-medium text-text-muted">Jarvis</h4>
                  <ul className="space-y-1.5">
                    {column.actions.map((action) => (
                      <li key={action.id} className="break-words text-xs leading-4 text-text-muted" data-kind={action.kind}>
                        <time dateTime={new Date(action.at).toISOString()} className="mr-1.5 tabular-nums text-text-faint">{displayTime(action.at)}</time>
                        <ActionLine action={action} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </article>
        ))}
      </div>
    );
  },
);

export default DayColumns;
