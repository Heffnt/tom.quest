"use client";

// The first row of an open session's transcript, collapsed until pressed: what
// the agent was given and has read, in the record's words. The rows that say
// what the run started with (kind "context"), the facts the run row holds
// about its context, and every tool result in the loaded window, in order.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import AgentRow from "@/app/agents/components/agent-row";
import type { TranscriptMessage } from "@/app/agents/lib";
import { toolNameOf, toolUseIdOf } from "@/app/agents/lib";

type RunContext = NonNullable<Doc<"runs">["context"]>;

function facts(context: RunContext | undefined): [string, string][] {
  if (context === undefined) return [];
  const list = (xs: string[] | undefined) => (xs === undefined || xs.length === 0 ? undefined : xs.join(", "));
  const pairs: [string, string | undefined][] = [
    ["model requested", context.modelRequested],
    ["working directory", context.cwd],
    ["branch", context.gitBranch],
    ["commit", context.gitCommit],
    ["permission mode", context.permissionMode],
    ["context window", context.contextWindow === undefined ? undefined : `${context.contextWindow} tokens`],
    ["model-of-tom commit", context.wikitomCommit],
    ["layers given", list(context.layersGiven)],
    ["hooks", list(context.hooks)],
    ["tools", list(context.tools)],
    ["skills offered", list(context.skillsOffered)],
    ["skills used", list(context.skillsUsed)],
  ];
  return pairs.filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== "");
}

export default function ContextPanel({
  run,
  rows,
}: {
  run: Doc<"runs"> | null | undefined;
  rows: TranscriptMessage[];
}) {
  const contextRows = useQuery(
    api.agents.contextRows,
    run !== null && run !== undefined ? { agentId: run.runId } : "skip",
  ) as TranscriptMessage[] | undefined;

  const toolNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) {
      if (row.kind !== "tool-call") continue;
      const id = toolUseIdOf(row.content);
      if (id !== undefined) names.set(id, toolNameOf(row.content));
    }
    return names;
  }, [rows]);
  const results = useMemo(() => rows.filter((row) => row.kind === "tool-result"), [rows]);
  const runFacts = facts(run?.context);

  return (
    <details className="border border-border rounded-lg bg-surface/40 text-sm">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-baseline gap-2 text-text-muted hover:bg-surface-alt/50">
        <span>Context as the agent sees it</span>
        <span className="font-mono text-[10px] text-text-faint">
          {(contextRows ?? []).length} context rows · {results.length} tool results
        </span>
      </summary>
      <div className="border-t border-border px-2 py-2 space-y-2">
        {(contextRows ?? []).map((row) => (
          <AgentRow key={row._id} row={row} source="run" />
        ))}
        {runFacts.length > 0 && (
          <table className="w-full text-xs">
            <tbody>
              {runFacts.map(([label, value]) => (
                <tr key={label} className="align-top">
                  <th scope="row" className="w-40 px-2 py-0.5 text-left font-normal text-text-faint">
                    {label}
                  </th>
                  <td className="px-2 py-0.5 font-mono text-text-muted break-all">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {results.map((row) => (
          <AgentRow key={row._id} row={row} source="run" toolNames={toolNames} />
        ))}
      </div>
    </details>
  );
}
