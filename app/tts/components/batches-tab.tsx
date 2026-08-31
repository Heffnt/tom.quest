"use client";

// BATCHES — the default tab. The paths bar over the batch cards (the ratified
// graph design), then the selectNeedsMe rows no batch claims, then the
// ruled-but-not-yet-applied pipeline strip.
//
// A BATCH IS NOT A TODO (schema v2): it is its own row (the `batches` table)
// holding how a set of todos gets completed. Its contents are dtsTodos rows
// pointing back at it — kind "task" (work someone does) and kind "goal" (a
// state of the world the batch is for). A todo is READY when every todo it
// NEEDS is done; the card shows ready, blocked and done, and one click on any
// item opens everything known about it.
//
// selectBatches (app/tts/lib.ts) still owns the OTHER two sections: the
// unbatched strip and the applying strip, so the shell's tab badge counts the
// same selection those render.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { countdownText } from "@/convex/ttsShared";
import { useAuth } from "@/app/lib/auth";
import {
  useOpenBatchSession,
  useOpenTodoSession,
} from "@/app/lib/use-open-todo-session";
import type { BatchSessionContext } from "@/app/lib/tts-session-prompt";
import CodeTodoRow from "./code-todo-row";
import OptionsRow from "./options-row";
import PathsBar, { type PathChip } from "./paths-bar";
import BatchCard, {
  taskSets,
  type BatchGraph,
  type GraphTask,
} from "./batch-card";
import RulingDialog, { type RulingVerdict } from "./ruling-dialog";
import DetailDialog, { type DetailItem } from "./detail-dialog";
import GroundUpView from "./ground-up-view";
import TimeNoteField, {
  groupTimeNotes,
  NO_NOTES,
  type TimeNote,
} from "./time-note-field";
import {
  ageText,
  batchSubjectKey,
  codeSubjectKey,
  fmtDate,
  groundUpTeaser,
  liveRulingsByKey,
  rulingSubjectKey,
  selectBatches,
  type Batch,
  type Todo,
} from "@/app/tts/lib";

const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";

// The chip a batch with no path groups under. A real path name could collide
// with it only if Tom named a path this, which the planner never does.
const UNPATHED = "unpathed";

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="text-xs text-text-faint">
      {title} <span className="text-text-muted">{count}</span>
    </div>
  );
}

// ── Live data → the card's graph model ──────────────────────────────────────
// tasks: every non-goal todo pointing at the batch. A row with no `kind` is a
// legacy standalone todo read as a task (schema comment), which is exactly the
// `kind !== "goal"` test. done and archived both read as done — the same rule
// ttsShared.buildDoneSet uses for the frontier, so what the card calls ready is
// what the scheduler calls ready.
function toGraph(batch: Batch, contents: Todo[]): BatchGraph {
  const tasks: GraphTask[] = [];
  const goals: BatchGraph["goals"] = [];
  for (const t of contents) {
    const done = t.status === "done" || t.status === "archived";
    if (t.kind === "goal") {
      goals.push({
        id: t._id,
        statement: t.statement,
        condition: t.condition,
        met: done,
        groundUp: t.groundUpExplanation ?? t.brief,
        code:
          t.codeRepo !== undefined && t.codeExternalId !== undefined
            ? { repo: t.codeRepo, externalId: t.codeExternalId }
            : undefined,
      });
    } else {
      tasks.push({
        id: t._id,
        statement: t.statement,
        actor: t.actor ?? "agent",
        status: done ? "done" : "active",
        needs: t.needs ?? [],
        evidence: t.evidence,
        groundUp: t.groundUpExplanation,
      });
    }
  }
  return {
    id: batch._id,
    statement: batch.statement,
    groundUp: batch.groundUpExplanation,
    tasks,
    goals,
  };
}

/** The graph as the session prompt reads it — the card's own three sets. */
function sessionContext(batch: Batch, graph: BatchGraph): BatchSessionContext {
  const { done, ready, blocked } = taskSets(graph.tasks);
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const doneIds = new Set(done.map((t) => t.id));
  const shape = (t: GraphTask, state: "done" | "ready" | "blocked") => ({
    statement: t.statement,
    actor: t.actor,
    state,
    waitingOn: t.needs
      .filter((n) => !doneIds.has(n))
      .map((n) => byId.get(n)?.statement ?? n),
    evidence: t.evidence,
  });
  return {
    statement: batch.statement,
    groundUp: batch.groundUpExplanation,
    path: batch.path
      ? { name: batch.path.name, index: batch.path.index }
      : undefined,
    tasks: [
      ...ready.map((t) => shape(t, "ready")),
      ...blocked.map((t) => shape(t, "blocked")),
      ...done.map((t) => shape(t, "done")),
    ],
    goals: graph.goals.map((g) => ({
      statement: g.statement,
      condition: g.condition,
      met: g.met,
    })),
  };
}

// ── Unbatched life row (active · ready-for-tom, in no batch) ────────────────
function LifeRow({
  todo,
  now,
  notes,
  expanded,
  onToggle,
}: {
  todo: Todo;
  now: number;
  /** This todo's time notes (the tab holds the query). */
  notes: readonly TimeNote[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { open: openSession, error: sessionError } = useOpenTodoSession();

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-base text-text">{todo.statement}</span>
        <span className={chipCls}>{todo.timingClass}</span>
        {todo.dueAt !== undefined && (
          <span
            className={`text-xs border border-border rounded px-1 py-px ${
              todo.dueAt < now ? "text-warning" : "text-text-faint"
            }`}
          >
            {countdownText(todo.dueAt, now)} · {fmtDate(todo.dueAt)}
          </span>
        )}
        <span className={chipCls}>{todo.source}</span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <OptionsRow
            todo={todo}
            rulable
            afterSession={(tab, ruling) => void openSession(todo, { tab, ruling })}
          />
          {sessionError && (
            <div className="text-xs text-error">{sessionError}</div>
          )}
          <TimeNoteField todoId={todo._id} notes={notes} />
          {todo.brief && (
            <div className="text-sm text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
              {todo.brief}
            </div>
          )}
          {todo.entryAction && (
            <div className="text-xs">
              <span className="text-text-faint">entryAction: </span>
              <span className="text-text-muted">{todo.entryAction}</span>
            </div>
          )}
          {todo.workDescription && (
            <div className="text-xs">
              <span className="text-text-faint">workDescription: </span>
              <span className="text-text-muted whitespace-pre-wrap">
                {todo.workDescription}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Unbatched code rows are the shared CodeTodoRow (./code-todo-row) — brief,
// evidence, the options row and the live ruling all come from that one row, so
// a code item looks and behaves the same on this tab and on the by-individual
// tab.

// ── The tab ─────────────────────────────────────────────────────────────────
// No onOpenItem: on this tab every item — a task, a goal, the batch itself —
// opens the detail dialog, which holds everything known about it. Nothing here
// hands an item off to the by-individual tab any more.
export default function BatchesTab() {
  const { canReadSurface } = useAuth();
  // Read gate, not the write gate: Tom, plus the read-only `agent` role a TTS
  // session browses as. Every mutation on this surface stays Tom-only and is
  // refused by Convex regardless of what renders here.
  const canRead = canReadSurface("TTS");
  const todos = useQuery(api.tts.listTodos, canRead ? {} : "skip");
  const batches = useQuery(api.tts.listBatches, canRead ? {} : "skip");
  const mirror = useQuery(api.tts.listMirror, canRead ? {} : "skip");
  const briefs = useQuery(api.ttsCode.listCodeBriefs, canRead ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, canRead ? {} : "skip");
  // ONE time-note subscription for the whole tab; each row slices it.
  const timeNotes = useQuery(api.tts.listTimeNotes, canRead ? {} : "skip");
  const recordEvent = useMutation(api.tts.recordEvent);
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const { open: openBatchSession, error: batchSessionError } =
    useOpenBatchSession();

  const now = Date.now();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ruling, setRuling] = useState<{
    batchId: Id<"batches">;
    graph: BatchGraph;
    verdict: RulingVerdict;
  } | null>(null);
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const [groundUp, setGroundUp] = useState<{ title: string; content: string } | null>(null);

  const flip = (id: string, set: (fn: (p: Set<string>) => Set<string>) => void) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggle = (key: string, engage: () => void) => {
    const opening = !expanded.has(key);
    flip(key, setExpanded);
    if (opening) engage();
  };

  // ONE definition of the selection (app/tts/lib.ts selectBatches) — the
  // shell's tab badge counts the same selection, so count and rows cannot
  // drift.
  const selection = useMemo(
    () => selectBatches(todos ?? [], mirror ?? [], briefs ?? [], rulings ?? []),
    [todos, mirror, briefs, rulings],
  );

  // The graph cards, grouped by path. Within a path: path order (`index`).
  // The batches on no path group under one "unpathed" chip, listed last and
  // ordered by recency, which is the only order they have.
  const { chips, byPath } = useMemo(() => {
    const contents = new Map<string, Todo[]>();
    for (const t of todos ?? []) {
      if (t.batchId === undefined) continue;
      const list = contents.get(t.batchId) ?? [];
      list.push(t);
      contents.set(t.batchId, list);
    }
    const byPath = new Map<string, { batch: Batch; graph: BatchGraph }[]>();
    for (const batch of batches ?? []) {
      if (batch.status !== "active") continue;
      const name = batch.path?.name ?? UNPATHED;
      const list = byPath.get(name) ?? [];
      list.push({ batch, graph: toGraph(batch, contents.get(batch._id) ?? []) });
      byPath.set(name, list);
    }
    for (const [name, list] of byPath) {
      list.sort((a, b) =>
        name === UNPATHED
          ? b.batch.updatedAt - a.batch.updatedAt
          : (a.batch.path?.index ?? 0) - (b.batch.path?.index ?? 0),
      );
    }
    const chips: PathChip[] = [...byPath.keys()]
      .filter((n) => n !== UNPATHED)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, count: (byPath.get(name) ?? []).length }));
    if (byPath.has(UNPATHED))
      chips.push({
        name: UNPATHED,
        count: (byPath.get(UNPATHED) ?? []).length,
      });
    return { chips, byPath };
  }, [batches, todos]);

  // Live ruling per subject — the shared derivation (app/tts/lib.ts), the same
  // one the by-individual tab feeds CodeTodoRow.
  const liveRulingByKey = useMemo(
    () => liveRulingsByKey(rulings ?? []),
    [rulings],
  );

  // ONE bucketing pass over the subscription; each row indexes into it.
  const notesByContext = useMemo(
    () => groupTimeNotes(timeNotes ?? []),
    [timeNotes],
  );

  const unbatchedLife = useMemo(
    () =>
      [...selection.unbatchedLife].sort(
        (a, b) =>
          (a.dueAt ?? Number.MAX_SAFE_INTEGER) -
          (b.dueAt ?? Number.MAX_SAFE_INTEGER),
      ),
    [selection],
  );
  const unbatchedCode = useMemo(
    () =>
      [...selection.unbatchedCode].sort(
        (a, b) =>
          a.row.repo.localeCompare(b.row.repo) ||
          a.row.statement.localeCompare(b.row.statement),
      ),
    [selection],
  );

  // Ruled, applying: live rulings whose appliedAt is unset.
  const statementByRulingKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of todos ?? [])
      map.set(
        rulingSubjectKey({ subjectType: "life", todoId: t._id }),
        t.statement,
      );
    for (const b of batches ?? []) map.set(batchSubjectKey(b._id), b.statement);
    for (const r of mirror ?? [])
      map.set(codeSubjectKey(r.repo, r.externalId), r.statement);
    return map;
  }, [todos, batches, mirror]);

  const applying = useMemo(
    () => [...selection.pending].sort((a, b) => b.ruledAt - a.ruledAt),
    [selection],
  );

  if (
    todos === undefined ||
    batches === undefined ||
    mirror === undefined ||
    briefs === undefined ||
    rulings === undefined
  ) {
    return <div className="text-sm text-text-faint py-8">Loading…</div>;
  }

  const shownPath =
    selectedPath !== null && byPath.has(selectedPath)
      ? selectedPath
      : (chips[0]?.name ?? UNPATHED);
  const list = byPath.get(shownPath) ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <PathsBar
          paths={chips}
          selected={shownPath}
          onSelect={setSelectedPath}
        />
        <div className="flex flex-col">
          {list.map(({ batch, graph }, i) => (
            <div key={graph.id}>
              {/* The connector is the path's own sequencing; the unpathed
                  group has no order to draw. */}
              {i > 0 && shownPath !== UNPATHED && (
                <div className="flex justify-center py-0.5">
                  <div className="h-3 w-px bg-[#2c3a52]" />
                </div>
              )}
              <BatchCard
                graph={graph}
                expanded={expanded.has(graph.id)}
                onToggle={() =>
                  toggle(graph.id, () => {
                    void recordEvent({
                      kind: "engaged",
                      data: { via: "batches", batchId: graph.id },
                    }).catch(() => {});
                  })
                }
                onRule={(verdict) =>
                  setRuling({ batchId: batch._id, graph, verdict })
                }
                onDetail={setDetail}
                onGroundUp={(title, content) => setGroundUp({ title, content })}
                onOpenSession={() =>
                  void openBatchSession(sessionContext(batch, graph))
                }
              />
            </div>
          ))}
        </div>
        {batchSessionError && (
          <div className="text-xs text-error">{batchSessionError}</div>
        )}
      </section>

      <section className="space-y-2">
        <SectionHeader
          title="unbatched · awaiting"
          count={unbatchedLife.length + unbatchedCode.length}
        />
        {(unbatchedLife.length > 0 || unbatchedCode.length > 0) && (
          <div className="space-y-1.5">
            {unbatchedLife.map((t) => (
              <LifeRow
                key={t._id}
                todo={t}
                now={now}
                notes={notesByContext.get(t._id) ?? NO_NOTES}
                expanded={expanded.has(t._id)}
                onToggle={() =>
                  toggle(t._id, () => {
                    void recordEvent({
                      kind: "engaged",
                      todoId: t._id,
                      data: { via: "batches-unbatched" },
                    }).catch(() => {});
                  })
                }
              />
            ))}
            {unbatchedCode.map(({ row, brief }) => {
              const key = codeSubjectKey(row.repo, row.externalId);
              return (
                <CodeTodoRow
                  key={row._id}
                  row={row}
                  brief={brief}
                  ruling={liveRulingByKey.get(key)}
                  now={now}
                  expanded={expanded.has(key)}
                  onToggle={() =>
                    toggle(key, () => {
                      void recordEvent({
                        kind: "engaged",
                        data: {
                          via: "batches-code",
                          repo: row.repo,
                          externalId: row.externalId,
                        },
                      }).catch(() => {});
                    })
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-1">
        <SectionHeader title="ruled, applying" count={applying.length} />
        {applying.map((r) => (
          <div
            key={r._id}
            className="text-xs flex flex-wrap items-baseline gap-x-2"
          >
            <span className="font-mono text-text-muted">{r.verdict}</span>
            <span className="text-text-muted">
              {statementByRulingKey.get(rulingSubjectKey(r)) ??
                (r.subjectType === "code"
                  ? `${r.repo} ${r.externalId}`
                  : // A batch subject carries batchId, not todoId — without
                    // the fallback the row renders with a blank subject.
                    (r.todoId ?? r.batchId))}
            </span>
            <span className="text-text-faint">{ageText(r.ruledAt, now)}</span>
          </div>
        ))}
      </section>

      {ruling && (
        <RulingDialog
          verdict={ruling.verdict}
          statement={ruling.graph.statement}
          brief={
            ruling.graph.groundUp !== undefined
              ? groundUpTeaser(ruling.graph.groundUp)
              : undefined
          }
          plan={ruling.graph.tasks.map((t) => ({
            text: t.statement,
            actor: t.actor,
            status: t.status === "done" ? ("done" as const) : ("open" as const),
          }))}
          onConfirm={(sentence) =>
            recordRuling({
              batchId: ruling.batchId,
              // The chip says "edit" (Tom's word for it); the stored verdict
              // is still named "revise".
              verdict: ruling.verdict === "edit" ? "revise" : ruling.verdict,
              sentence: sentence || undefined,
            })
          }
          onClose={() => setRuling(null)}
        />
      )}
      {detail && (
        <DetailDialog
          item={detail}
          onClose={() => setDetail(null)}
          onGroundUp={(title, content) => setGroundUp({ title, content })}
        />
      )}
      {groundUp && (
        <GroundUpView
          title={groundUp.title}
          content={groundUp.content}
          onClose={() => setGroundUp(null)}
        />
      )}
    </div>
  );
}
