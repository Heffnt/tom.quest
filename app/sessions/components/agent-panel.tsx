"use client";

// Right-hand column of a session: the tool work that is still open — Task
// subagents the session spawned, and background Bash commands. Every line is
// quoted from the transcript (the SDK's own input fields, the daemon's own
// result text); the panel never invents a status of its own. Renders nothing
// when there is no open work and nothing has finished.

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { previewLine, shortAge } from "../lib";

/** Elapsed span: "12s", "4m", "2h" — durations, not ages (shortAge's job). */
function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export default function AgentPanel({
  sessionId,
}: {
  sessionId: Id<"claudeSessions">;
}) {
  const work = useQuery(api.claudeSessions.getOpenToolWork, { sessionId });

  // Elapsed is derived at render; a 15s tick keeps it honest (the same
  // cadence the rest of the surface ticks its ages at).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!work) return null;

  const { agents, finished, commands } = work;
  if (agents.length === 0 && commands.length === 0 && finished.length === 0) {
    return null;
  }

  // finished arrives already ordered and already capped to a tail by
  // getOpenToolWork — rendered as given. The fold is a tail, not a history;
  // the transcript itself keeps every subagent that ever ran.
  return (
    <div className="w-72 h-full overflow-y-auto border-l border-border px-2.5 py-3 space-y-3">
      {(agents.length > 0 || finished.length > 0) && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-faint">agents</div>
          {agents.map((a) => (
            <div
              key={a.toolUseId}
              className="border border-border rounded px-2 py-1.5 space-y-0.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-text truncate min-w-0">
                  {a.subagentType}
                </span>
                <span className="shrink-0 text-[10px] text-text-faint">
                  {shortAge(a.startedAt, now)}
                </span>
              </div>
              <div className="text-[11px] text-text-muted break-words">
                {previewLine(a.description, 120)}
              </div>
              {a.current && (
                <div className="font-mono text-[10px] text-text-faint break-words">
                  current: {a.current.toolName}{" "}
                  {previewLine(a.current.inputPreview, 80)}
                </div>
              )}
            </div>
          ))}
          {finished.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer list-none text-[10px] text-text-faint hover:text-text-muted">
                finished ({finished.length})
              </summary>
              <div className="mt-1 space-y-1">
                {finished.map((a) => (
                  <div
                    key={a.toolUseId}
                    className="border border-border/60 rounded px-2 py-1.5 space-y-0.5"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-[11px] truncate min-w-0 ${
                          a.isError ? "text-error" : "text-text-muted"
                        }`}
                      >
                        {a.subagentType}
                      </span>
                      <span className="shrink-0 text-[10px] text-text-faint">
                        {durationText(a.durationMs)}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-text-faint break-words">
                      {previewLine(a.resultPreview, 160)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {commands.length > 0 && (
        <div className="space-y-1.5">
          {/* Not "running": the panel knows the command was launched in the
              background and knows what the last check printed. Whether it is
              still alive is the evidence's business, not the header's. */}
          <div className="text-[10px] text-text-faint">
            background · latest evidence
          </div>
          {commands.map((c) => (
            <div
              key={c.toolUseId}
              className="border border-border rounded px-2 py-1.5 space-y-1"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] text-text truncate min-w-0">
                  {previewLine(c.command, 60)}
                </span>
                <span className="shrink-0 text-[10px] text-text-faint">
                  {shortAge(c.startedAt, now)}
                </span>
              </div>
              {/* Verbatim, capped by scroll rather than by truncation — the
                  launch line first, then the newest check that came back. */}
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-text-faint max-h-24 overflow-y-auto">
                {c.launchResultText}
              </pre>
              {c.latestCheck && (
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-text-muted border-t border-border pt-1 max-h-40 overflow-y-auto">
                  {c.latestCheck.resultText}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
