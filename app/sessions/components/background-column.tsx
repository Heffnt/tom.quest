"use client";

// The sessions page's right column: the agents the open session's run
// started, running and finished, each with its state, a hundred at a time
// with a control for the next hundred while the record holds more. Pressing
// one opens its transcript in the center in place of the session's.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  ageText,
  costText,
  runDurationText,
  runStatusChipClass,
} from "@/app/agents/lib";

const PAGE = 100;

function AgentLine({
  child,
  selected,
  now,
  onOpenRun,
}: {
  child: Doc<"runs">;
  selected: boolean;
  now: number;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <li>
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
}

/** One page of agents.children; offers the next page when it is the last one read. */
function ChildrenPage({
  runId,
  cursor,
  last,
  selectedRunId,
  now,
  onOpenRun,
  onMore,
}: {
  runId: string;
  cursor: string | null;
  last: boolean;
  selectedRunId?: string;
  now: number;
  onOpenRun: (runId: string) => void;
  onMore: (cursor: string) => void;
}) {
  const page = useQuery(api.agents.children, {
    agentId: runId,
    limit: PAGE,
    ...(cursor === null ? {} : { cursor }),
  });
  if (page === undefined) {
    return <div className="px-3 py-2 text-xs text-text-faint">loading…</div>;
  }
  if (cursor === null && page.items.length === 0) {
    return <div className="px-3 py-2 text-xs text-text-faint">none</div>;
  }
  // Running first, then newest, within the page.
  const items = [...page.items].sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    return aRunning - bRunning || b.startedAt - a.startedAt;
  });
  const next = page.nextCursor;
  return (
    <>
      <ul className="divide-y divide-border border-b border-border">
        {items.map((child) => (
          <AgentLine
            key={child.runId}
            child={child}
            selected={child.runId === selectedRunId}
            now={now}
            onOpenRun={onOpenRun}
          />
        ))}
      </ul>
      {last && next !== null && (
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={() => onMore(next)}
            className="w-full rounded px-3 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt hover:text-text"
          >
            More agents
          </button>
        </div>
      )}
    </>
  );
}

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
  // The cursors of the pages read so far, per run; a new run starts at one page.
  const [read, setRead] = useState<{ runId?: string; cursors: (string | null)[] }>({ cursors: [null] });
  const cursors = read.runId === runId ? read.cursors : [null];

  if (runId === undefined) {
    return <div className="px-3 py-2 text-xs text-text-faint">none</div>;
  }
  return (
    <>
      {cursors.map((cursor, i) => (
        <ChildrenPage
          key={cursor ?? "first"}
          runId={runId}
          cursor={cursor}
          last={i === cursors.length - 1}
          selectedRunId={selectedRunId}
          now={now}
          onOpenRun={onOpenRun}
          onMore={(next) => setRead({ runId, cursors: [...cursors, next] })}
        />
      ))}
    </>
  );
}
