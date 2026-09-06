"use client";

// The batch card, graph model. A batch is not a todo: it is the container
// holding how todos get completed. Its plan is a graph of task- and
// goal-todos; a todo is ready when everything it needs is done.
// Collapsed = statement · task progress (amber = Tom's, green = agents') ·
// what's ready now. Expanded = display text (whole block clickable → the
// ground-up explanation) → actions (open a session; the four verdicts) →
// ready now → blocked (visible, never hidden) → done → goals. Every item opens
// a detail dialog; nothing shifts the page, and everything clickable changes
// on hover.
import PlanBar from "./plan-bar";
import GraphView from "./graph-view";
import Info from "./info";
import VerdictButtons from "./verdict-buttons";
import { SESSIONS_EXPLANATION } from "../explanations";
import { fmtDate, groundUpTeaser, type RulingVerdict } from "../lib";
import {
  isReady,
  waitingReason,
  waitingReasonText,
  type StoredReadiness,
  type WaitingReason,
} from "@/convex/ttsShared";
import type { DetailItem } from "./detail-dialog";

export type GraphTask = {
  id: string;
  statement: string;
  actor: "tom" | "agent";
  status: "active" | "done";
  needs: string[];
  /** A sleep on an active task (the lifeos update); absent = awake. */
  wakeAt?: number;
  readiness: StoredReadiness;
  evidence?: string;
  groundUp?: string;
  /** Whether the todo behind it offers the four verdicts (lib isRulable). */
  rulable: boolean;
};

export type GraphGoal = {
  id: string;
  statement: string;
  condition?: string;
  met: boolean;
  groundUp?: string;
  code?: { repo: string; externalId: string };
  /** Whether the todo behind it offers the four verdicts (lib isRulable). */
  rulable: boolean;
};

export type BatchGraph = {
  id: string;
  statement: string;
  groundUp?: string;
  tasks: GraphTask[];
  goals: GraphGoal[];
};

/** The card's done set: a task's status here is already collapsed to
 * done/active by the tab (done and archived both read as done — the same rule
 * ttsShared.buildDoneSet uses), so this is that set's local spelling. */
function graphDoneSet(tasks: readonly GraphTask[]): Set<string> {
  return new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
}

/** The graph slice ttsShared reads: a GraphTask's id under the `_id` name. */
function asGraphTodo(t: GraphTask) {
  return { _id: t.id, status: t.status, needs: t.needs, wakeAt: t.wakeAt };
}

/** Ready is ttsShared.isReady — active, awake, every need done — so the card
 * and the scheduler agree on the frontier; blocked is the rest. */
export function taskSets(
  tasks: GraphTask[],
  now: number,
): {
  done: GraphTask[];
  ready: GraphTask[];
  blocked: GraphTask[];
} {
  const doneIds = graphDoneSet(tasks);
  const done: GraphTask[] = [];
  const ready: GraphTask[] = [];
  const blocked: GraphTask[] = [];
  for (const t of tasks) {
    if (t.status === "done") done.push(t);
    else if (isReady(asGraphTodo(t), doneIds, now)) ready.push(t);
    else blocked.push(t);
  }
  return { done, ready, blocked };
}

/** Why a task waits — ttsShared.waitingReason against this graph, naming the
 * need it waits on. Exported because the detail dialog's "waiting on" row is
 * the same reason, and the batches tab recomputes it when it re-resolves an
 * open dialog's item. null = waiting on nothing. */
export function taskWaiting(
  t: GraphTask,
  all: GraphTask[],
  now: number,
): WaitingReason | null {
  const byId = new Map(all.map((x) => [x.id, x]));
  return waitingReason(
    { ...asGraphTodo(t), readiness: t.readiness, actor: t.actor },
    { now, doneSet: graphDoneSet(all), statementOf: (id) => byId.get(id)?.statement },
  );
}

/** The statements of everything a task still waits on — its unmet `needs`,
 * every one of them (the reason names only the first). */
export function needNames(t: GraphTask, all: GraphTask[]): string[] {
  const doneIds = graphDoneSet(all);
  const byId = new Map(all.map((x) => [x.id, x]));
  return t.needs
    .filter((n) => !doneIds.has(n))
    .map((n) => byId.get(n)?.statement ?? n);
}

export default function BatchCard({
  graph,
  now,
  expanded,
  onToggle,
  onRule,
  onDetail,
  onGroundUp,
  onOpenSession,
}: {
  graph: BatchGraph;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  /** ttsRulings.recordRuling on the batch with this verdict and sentence
   * (empty for approve and session); see verdict-buttons.tsx. */
  onRule: (verdict: RulingVerdict, sentence: string) => Promise<unknown> | void;
  onDetail: (item: DetailItem) => void;
  onGroundUp: (title: string, content: string) => void;
  onOpenSession: () => void;
}) {
  const { done, ready, blocked } = taskSets(graph.tasks, now);
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
    waiting: taskWaiting(t, graph.tasks, now),
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

          <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-1.5">
            <span className="inline-flex items-center gap-0.5">
              <button
                type="button"
                onClick={onOpenSession}
                className="rounded-md border border-accent/50 bg-accent-dim px-2.5 py-1 text-xs text-accent hover:border-accent hover:opacity-80"
              >
                open batch session
              </button>
              <Info
                call='claudeSessions.createSession({ kind: "focus-item", batchId, initialPrompt })'
                explanation={SESSIONS_EXPLANATION}
                explanationTitle="opening a session — what is created and where it runs"
              >
                Opens a Claude session on the Jarvis Box in a new tab, with this
                graph — its ready, blocked and done tasks and its goals — in the
                opening prompt. It checks out the repositories the batch
                declares and can only push to its own branch. No ruling is
                recorded.
              </Info>
            </span>
            <VerdictButtons
              subject="batch"
              statement={graph.statement}
              plan={planForBar}
              onRule={onRule}
            />
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
              {blocked.map((t) => {
                const reason = taskWaiting(t, graph.tasks, now);
                return (
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
                      {reason && (
                        <span className="text-text-faint">
                          {" "}
                          · {waitingReasonText(reason, fmtDate)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
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
