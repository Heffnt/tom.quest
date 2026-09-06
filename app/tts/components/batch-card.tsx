"use client";

// The batch card. A batch is not a todo: it is the container holding how todos
// get completed. Its contents are a graph of task- and goal-todos; a todo is
// ready when everything it needs is done.
//
// WHAT THE CARD SAYS (the lifeos update, phase 7). Four things, and nothing
// else:
//   PURPOSE      — the statement, and the ground-up explanation behind it.
//   MUST NOT BREAK — Tom's own lines, from the batch's goals. They are the
//                  constraint every session on this batch reads, so they are
//                  on the face of the card and not folded into a goal row.
//   READY WORK   — what can be picked up now. An empty ready list says so in
//                  those words and names what is in the way.
//   WAITING      — every task that is not ready, with its reason in the one
//                  spelling (ttsShared.waitingReasonText). Visible, never
//                  hidden: a card that showed only ready work would be a card
//                  that never says why nothing is.
// Gone with the same change: the drawn graph, the plan bar, and the paths bar
// above the cards — three pictures of sequencing, replaced by the sentence
// that says what is actually in the way. FULL NEEDS DETAIL — every unmet need
// of a task, and the batches this batch waits on — lives one click away in the
// detail dialog, where an item's whole record is.
//
// Every item opens that dialog; nothing shifts the page, and everything
// clickable changes on hover.
import Info from "./info";
import VerdictButtons from "./verdict-buttons";
import { MUST_NOT_BREAK_EXPLANATION, SESSIONS_EXPLANATION } from "../explanations";
import { fmtDate, groundUpTeaser, type RulingVerdict } from "../lib";
import {
  isReady,
  isReadyForTom,
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
  /** "waiting" is the stored status, still readable: a sleep with no instant
   * of its own (ttsShared.waitingReason reads it as a wake). Never a made-up
   * wakeAt. */
  status: "active" | "waiting" | "done";
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
  /** Tom's own line on what the work toward this goal must not break. */
  mustNotBreak?: string;
  met: boolean;
  groundUp?: string;
  code?: { repo: string; externalId: string };
  /** Whether the todo behind it offers the four verdicts (lib isRulable). */
  rulable: boolean;
};

/** One batch this batch needs done first — the sequencing that replaced the
 * path (convex/schema.ts batches.needs). `met` is the buildDoneSet rule: the
 * needed batch is done or archived. */
export type BatchNeed = { id: string; statement: string; met: boolean };

export type BatchGraph = {
  id: string;
  statement: string;
  groundUp?: string;
  /** The batches that must land first. Absent = this batch waits on none. */
  needs?: BatchNeed[];
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

/**
 * Ready, BY WHOSE FRONTIER (review finding). The two are not the same rule and
 * the card must ask the one that belongs to the row's actor:
 *   an agent task — ttsShared.isReady: active, awake, every need done. That is
 *     the frontier a worker picks from, and it does not read readiness,
 *     because an agent works a capture from raw.
 *   one of Tom's — ttsShared.isReadyForTom: all of that AND prepared. A raw
 *     capture is never ready for him (ruling 18), and listing one under "ready
 *     now" told him to go and do a todo nobody has written up yet.
 * Blocked is the rest, and an unprepared row of his says so there in the one
 * spelling ("waiting: unprepared") — the preparer job clears it on its own.
 */
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
    const isReadyNow =
      t.actor === "tom"
        ? isReadyForTom(
            { ...asGraphTodo(t), readiness: t.readiness },
            doneIds,
            now,
          )
        : isReady(asGraphTodo(t), doneIds, now);
    if (t.status === "done") done.push(t);
    else if (isReadyNow) ready.push(t);
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
    {
      ...asGraphTodo(t),
      readiness: t.readiness,
      actor: t.actor,
    },
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

/** The batches this one still waits on — every unmet need, by statement. */
export function unmetBatchNeeds(graph: BatchGraph): BatchNeed[] {
  return (graph.needs ?? []).filter((n) => !n.met);
}

/**
 * WHY NOTHING IS READY, in one sentence — the line the card prints where the
 * ready list would be. A batch that waits on another batch says so first:
 * none of its own tasks can move until that one lands, whatever their own
 * needs look like. Otherwise it is the first waiting task's own reason. null =
 * nothing is in the way (every task is done, or there are none).
 */
export function noReadyReason(
  graph: BatchGraph,
  now: number,
): string | null {
  const batchNeed = unmetBatchNeeds(graph)[0];
  if (batchNeed !== undefined) {
    return waitingReasonText(
      { kind: "need", id: batchNeed.id, statement: batchNeed.statement },
      fmtDate,
    );
  }
  const { blocked } = taskSets(graph.tasks, now);
  for (const t of blocked) {
    const reason = taskWaiting(t, graph.tasks, now);
    if (reason !== null) return waitingReasonText(reason, fmtDate);
  }
  return null;
}

const SECTION = "mb-1 text-[11px] uppercase tracking-wide text-text-faint";
const ITEM =
  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[13px] hover:bg-surface-alt/60";

function Who({ actor, dim }: { actor: "tom" | "agent"; dim?: boolean }) {
  return (
    <span
      className={`w-10 shrink-0 text-[10px] uppercase tracking-wide ${
        actor === "tom" ? (dim ? "text-accent/70" : "text-accent") : "text-text-faint"
      }`}
    >
      {actor === "tom" ? "you" : "agent"}
    </span>
  );
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
  const next = ready[0];
  const stuck = noReadyReason(graph, now);
  const mustNotBreak = graph.goals.filter(
    (g) => (g.mustNotBreak ?? "").trim() !== "",
  );

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
        className="grid w-full grid-cols-[14px_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3 py-2 text-left hover:bg-surface-alt/40"
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
          ) : (
            // The words, and then what is in the way. A batch with nothing
            // ready and nothing waiting has finished its work.
            <span className="block truncate text-xs text-text-faint">
              no ready todo{stuck !== null ? ` — ${stuck}` : ""}
            </span>
          )}
        </span>
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

          {mustNotBreak.length > 0 && (
            <div className="mb-2.5">
              <div className="flex items-baseline gap-1">
                <span className={SECTION}>must not break</span>
                <Info
                  call="tts.updateTodo({ mustNotBreak })"
                  explanation={MUST_NOT_BREAK_EXPLANATION}
                  explanationTitle="must not break — Tom's line on a goal"
                >
                  Your own line on what the work toward this batch&rsquo;s goals
                  must not break. Only you write it, and every agent working
                  this batch reads it in its opening prompt.
                </Info>
              </div>
              {mustNotBreak.map((g) => (
                <div key={g.id} className="text-[13px] text-text-muted">
                  {g.mustNotBreak}
                </div>
              ))}
            </div>
          )}

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
                graph — its ready and waiting tasks and its goals — in the
                opening prompt. It checks out the repositories the batch
                declares and can only push to its own branch. No ruling is
                recorded.
              </Info>
            </span>
            <VerdictButtons
              subject="batch"
              statement={graph.statement}
              onRule={onRule}
            />
          </div>

          <div className={SECTION}>ready now</div>
          {ready.length > 0 ? (
            ready.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onDetail(taskDetail(t))}
                className={ITEM}
              >
                <span className="text-text-faint">○</span>
                <Who actor={t.actor} />
                <span className="truncate text-text">{t.statement}</span>
              </button>
            ))
          ) : (
            <div className="text-[13px] text-text-faint">
              no ready todo{stuck !== null ? ` — ${stuck}` : ""}
            </div>
          )}

          {blocked.length > 0 && (
            <>
              <div className={`${SECTION} mt-2.5`}>waiting</div>
              {blocked.map((t) => {
                const reason = taskWaiting(t, graph.tasks, now);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onDetail(taskDetail(t))}
                    className={`${ITEM} opacity-60 hover:opacity-90`}
                  >
                    <span className="text-text-faint">○</span>
                    <Who actor={t.actor} />
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
              <div className={`${SECTION} mt-2.5`}>done</div>
              {done.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onDetail(taskDetail(t))}
                  className={ITEM}
                >
                  <span className="text-success">✓</span>
                  <Who actor={t.actor} dim />
                  <span className="truncate text-text-faint">{t.statement}</span>
                </button>
              ))}
            </>
          )}

          {graph.goals.length > 0 && (
            <>
              <div className={`${SECTION} mt-3`}>
                goals · {graph.goals.filter((g) => g.met).length} of {graph.goals.length} met
              </div>
              {graph.goals.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onDetail({ kind: "goal", batchStatement: graph.statement, goal: g })}
                  className={ITEM}
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
