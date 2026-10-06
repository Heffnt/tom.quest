"use client";

// The sessions page's right column: the agents the open session's run
// started, running and finished, each with its state. Pressing one opens its
// transcript in the center in place of the session's.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ageText,
  costText,
  runDurationText,
  runStatusChipClass,
} from "@/app/agents/lib";

export default function BackgroundColumn({
  runId,
  selectedRunId,
  now,
  onOpenRun,
}: {
  /** The open session's run; absent until its first reply is recorded. */
  runId?: string;
  selectedRunId?: string;
  now: number;
  onOpenRun: (runId: string) => void;
}) {
  const children = useQuery(api.agents.children, runId !== undefined ? { agentId: runId } : "skip");

  if (runId === undefined) {
    return <div className="px-3 py-2 text-xs text-text-faint">none</div>;
  }
  if (children === undefined) {
    return <div className="px-3 py-2 text-xs text-text-faint">loading…</div>;
  }
  const items = [...children.items].sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    return aRunning - bRunning || b.startedAt - a.startedAt;
  });
  if (items.length === 0) {
    return <div className="px-3 py-2 text-xs text-text-faint">none</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((child) => {
        const selected = child.runId === selectedRunId;
        return (
          <li key={child.runId}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onOpenRun(child.runId)}
              className={`w-full text-left px-3 py-2 space-y-1 hover:bg-surface-alt ${
                selected ? "bg-surface-alt border-l-2 border-accent" : "border-l-2 border-transparent"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-text truncate min-w-0 flex-1">
                  {child.originGiven ?? child.kind}
                </span>
                <span className={`shrink-0 border rounded px-1.5 py-0.5 text-[10px] ${runStatusChipClass(child.status)}`}>
                  {child.status}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-2 font-mono text-[10px] text-text-faint">
                <span>{child.kind}</span>
                {child.model !== undefined && <span>{child.model}</span>}
                {runDurationText(child) !== "" && <span>{runDurationText(child)}</span>}
                <span>{ageText(child.startedAt, now)}</span>
                {costText(child.outcome?.costUsd) !== "" && <span>{costText(child.outcome?.costUsd)}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
