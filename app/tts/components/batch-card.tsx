"use client";

// The batch card, graph model. A batch is not a todo: it is the container
// holding how todos get completed. Its plan is a graph of task- and
// goal-todos; a todo is ready when everything it needs is done.
// Collapsed = statement · task progress (amber = Tom's, green = agents') ·
// what's ready now. Expanded = display text (whole block clickable → the
// ground-up explanation) → actions → ready now → blocked (visible, never
// hidden) → done → goals. Every item opens a detail dialog; nothing shifts
// the page, and everything clickable changes on hover.
import PlanBar from "./plan-bar";
import GraphView from "./graph-view";
import Info from "./info";
import { groundUpTeaser } from "../lib";
import type { RulingVerdict } from "./ruling-dialog";
import type { DetailItem } from "./detail-dialog";

export type GraphTask = {
  id: string;
  statement: string;
  actor: "tom" | "agent";
  status: "active" | "done";
  needs: string[];
  evidence?: string;
  groundUp?: string;
};

export type GraphGoal = {
  id: string;
  statement: string;
  condition?: string;
  met: boolean;
  groundUp?: string;
  code?: { repo: string; externalId: string };
};

export type BatchGraph = {
  id: string;
  statement: string;
  groundUp?: string;
  tasks: GraphTask[];
  goals: GraphGoal[];
  /** batches.tomTouchedAt is set: the hourly planner may not rewrite this graph. */
  frozen?: boolean;
};

export function taskSets(tasks: GraphTask[]): {
  done: GraphTask[];
  ready: GraphTask[];
  blocked: GraphTask[];
} {
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const done: GraphTask[] = [];
  const ready: GraphTask[] = [];
  const blocked: GraphTask[] = [];
  for (const t of tasks) {
    if (t.status === "done") done.push(t);
    else if (t.needs.every((n) => doneIds.has(n))) ready.push(t);
    else blocked.push(t);
  }
  return { done, ready, blocked };
}

function needNames(t: GraphTask, all: GraphTask[]): string[] {
  const doneIds = new Set(all.filter((x) => x.status === "done").map((x) => x.id));
  const byId = new Map(all.map((x) => [x.id, x]));
  return t.needs
    .filter((n) => !doneIds.has(n))
    .map((n) => byId.get(n)?.statement ?? n);
}

export default function BatchCard({
  graph,
  expanded,
  onToggle,
  onRule,
  onSetFrozen,
  onDetail,
  onGroundUp,
  onOpenSession,
}: {
  graph: BatchGraph;
  expanded: boolean;
  onToggle: () => void;
  onRule: (verdict: RulingVerdict) => void;
  /** Fires tts.setBatchFrozen. Absent = the button is not rendered (the mockup route). */
  onSetFrozen?: (frozen: boolean) => void;
  onDetail: (item: DetailItem) => void;
  onGroundUp: (title: string, content: string) => void;
  onOpenSession: () => void;
}) {
  const { done, ready, blocked } = taskSets(graph.tasks);
  const planForBar = graph.tasks.map((t) => ({
    text: t.statement,
    actor: t.actor,
    status: t.status === "done" ? ("done" as const) : ("open" as const),
  }));
  const next = ready[0];

  const taskDetail = (t: GraphTask): DetailItem => ({
    kind: "task",
    batchStatement: graph.statement,
    task: t,
    waitingOn: needNames(t, graph.tasks),
  });

  return (
    <div
      className={`rounded-lg border bg-surface ${expanded ? "border-[#2c3a52]" : "border-border"}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 py-2 text-left hover:bg-surface-alt/40"
      >
        <span className="text-[11px] text-text-faint">{expanded ? "▾" : "▸"}</span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] text-text">{graph.statement}</span>
          {next ? (
            <span className="block truncate text-xs text-text-muted">
              ready now:{" "}
              <span className={next.actor === "tom" ? "text-accent" : "text-text-faint"}>
                {next.actor === "tom" ? "you" : "agents"}
              </span>{" "}
              — {next.statement}
              {ready.length > 1 && (
                <span className="text-text-faint"> · +{ready.length - 1} more ready</span>
              )}
            </span>
          ) : blocked.length > 0 ? (
            <span className="block truncate text-xs text-text-faint">
              nothing ready — {blocked.length} blocked
            </span>
          ) : null}
        </span>
        {graph.tasks.length > 0 && (
          <span className="text-right">
            <PlanBar plan={planForBar} />
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2.5">
          {graph.groundUp !== undefined && (
            <button
              type="button"
              onClick={() => onGroundUp(graph.statement, graph.groundUp ?? "")}
              className="-mx-1.5 mb-2.5 block w-[calc(100%+0.75rem)] rounded px-1.5 py-1 text-left text-[13px] text-text-muted hover:bg-surface-alt/60 hover:text-text"
            >
              {groundUpTeaser(graph.groundUp)}
            </button>
          )}

          <GraphView
            tasks={graph.tasks}
            goals={graph.goals}
            onPick={(id) => {
              const t = graph.tasks.find((x) => x.id === id);
              if (t) onDetail(taskDetail(t));
              else {
                const g = graph.goals.find((x) => x.id === id);
                if (g)
                  onDetail({ kind: "goal", batchStatement: graph.statement, goal: g });
              }
            }}
          />

          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenSession}
              className="rounded-md border border-accent/50 bg-accent-dim px-2.5 py-1 text-xs text-accent hover:border-accent hover:opacity-80"
            >
              open batch session
            </button>
            {/* No "approve": nothing executes a batch, so the verdict wrote
                "graph ratified" and stopped (ruled 2026-08-30). Holding the
                graph still — the only thing it really did — is the freeze
                button beside these. */}
            {(["archive", "edit"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onRule(v)}
                className="rounded-md border border-border bg-surface-alt px-2.5 py-1 text-xs text-text-muted hover:border-text-faint hover:text-text"
              >
                {v}
              </button>
            ))}
            {onSetFrozen && (
              <span className="inline-flex items-baseline gap-1">
                <button
                  type="button"
                  onClick={() => onSetFrozen(!graph.frozen)}
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    graph.frozen
                      ? "border-accent/50 bg-accent-dim text-accent hover:border-accent hover:opacity-80"
                      : "border-border bg-surface-alt text-text-muted hover:border-text-faint hover:text-text"
                  }`}
                >
                  {graph.frozen ? "let the planner rewrite" : "freeze this graph"}
                </button>
                <Info
                  label={`tts.setBatchFrozen({frozen:${graph.frozen ? "false" : "true"}})`}
                />
              </span>
            )}
          </div>

          {ready.length > 0 && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-text-faint">
                ready now
              </div>
              {ready.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onDetail(taskDetail(t))}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[13px] hover:bg-surface-alt/60"
                >
                  <span className="text-text-faint">○</span>
                  <span
                    className={`w-10 shrink-0 text-[10px] uppercase tracking-wide ${
                      t.actor === "tom" ? "text-accent" : "text-text-faint"
                    }`}
                  >
                    {t.actor === "tom" ? "you" : "agent"}
                  </span>
                  <span className="truncate text-text">{t.statement}</span>
                </button>
              ))}
            </>
          )}

          {blocked.length > 0 && (
            <>
              <div className="mb-1 mt-2.5 text-[11px] uppercase tracking-wide text-text-faint">
                blocked
              </div>
              {blocked.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onDetail(taskDetail(t))}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[13px] opacity-60 hover:bg-surface-alt/60 hover:opacity-90"
                >
                  <span className="text-text-faint">○</span>
                  <span
                    className={`w-10 shrink-0 text-[10px] uppercase tracking-wide ${
                      t.actor === "tom" ? "text-accent" : "text-text-faint"
                    }`}
                  >
                    {t.actor === "tom" ? "you" : "agent"}
                  </span>
                  <span className="min-w-0 truncate">
                    <span className="text-text-muted">{t.statement}</span>
                    <span className="text-text-faint">
                      {" "}
                      · waiting on: {needNames(t, graph.tasks).join(", ")}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {done.length > 0 && (
            <>
              <div className="mb-1 mt-2.5 text-[11px] uppercase tracking-wide text-text-faint">
                done
              </div>
              {done.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onDetail(taskDetail(t))}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[13px] hover:bg-surface-alt/60"
                >
                  <span className="text-success">✓</span>
                  <span
                    className={`w-10 shrink-0 text-[10px] uppercase tracking-wide ${
                      t.actor === "tom" ? "text-accent/70" : "text-text-faint"
                    }`}
                  >
                    {t.actor === "tom" ? "you" : "agent"}
                  </span>
                  <span className="truncate text-text-faint">{t.statement}</span>
                </button>
              ))}
            </>
          )}

          {graph.goals.length > 0 && (
            <>
              <div className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-text-faint">
                goals · {graph.goals.filter((g) => g.met).length} of {graph.goals.length} met
              </div>
              {graph.goals.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onDetail({ kind: "goal", batchStatement: graph.statement, goal: g })}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[13px] hover:bg-surface-alt/60"
                >
                  <span className={g.met ? "text-success" : "text-text-faint"}>
                    {g.met ? "✓" : "◇"}
                  </span>
                  <span className={`truncate ${g.met ? "text-text-faint" : "text-text-muted"}`}>
                    {g.statement}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
