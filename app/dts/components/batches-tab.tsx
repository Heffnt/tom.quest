"use client";

// BATCHES — the default tab. Batch cards (importance desc), then the
// selectNeedsMe rows no batch claims, then the ruled-but-not-yet-applied
// pipeline strip. selectBatches (app/dts/lib.ts) is the ONE selector — the
// shell's tab badge counts the same selection, so count and rows cannot drift.
//
// A card is read at a glance: the statement large, the member progress as a
// segmented bar, importance as a mark. Words that a visual already says
// ("plan", "members", "3 of 7 done") are not printed.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { countdownText } from "@/convex/dtsShared";
import { useAuth } from "@/app/lib/auth";
import {
  useOpenTodoSession,
  type ReservedTab,
} from "@/app/lib/use-open-todo-session";
import type { LiveRulingContext } from "@/app/lib/dts-session-prompt";
import CodeTodoRow from "./code-todo-row";
import OptionsRow, { ImportanceBars } from "./options-row";
import Info from "./info";
import TimeNoteField, {
  groupTimeNotes,
  NO_NOTES,
  type TimeNote,
} from "./time-note-field";
import {
  ageText,
  clientMemberKey,
  codeSubjectKey,
  errMessage,
  fmtDate,
  liveRulingsByKey,
  memberProgress,
  planNeedsYou,
  rulingSubjectKey,
  selectBatches,
  type Member,
  type MirrorRow,
  type PlanStep,
  type Todo,
} from "@/app/dts/lib";

const primaryBtnCls =
  "bg-accent text-bg rounded-md px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none";
const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";
const actorCls = "font-mono text-[11px]";

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="text-xs text-text-faint">
      {title} <span className="text-text-muted">{count}</span>
    </div>
  );
}

/** evidence/text as a link when it is a URL, plain text otherwise. */
function Linkified({ text }: { text: string }) {
  if (text.startsWith("http")) {
    return (
      <a
        href={text}
        target="_blank"
        rel="noreferrer"
        className="text-accent hover:underline break-all"
      >
        {text}
      </a>
    );
  }
  return <span className="break-words">{text}</span>;
}

// ── Member progress ─────────────────────────────────────────────────────────
// One segment per member, filled left to right — the bar IS the count, so the
// count is not also written out (it stays in the native title).
function MemberBar({ done, total }: { done: number; total: number }) {
  return (
    <span
      title={`${done} of ${total} done`}
      className="w-24 h-1.5 rounded-full overflow-hidden flex gap-px bg-border/40"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`flex-1 ${i < done ? "bg-success/70" : "bg-border"}`}
        />
      ))}
    </span>
  );
}

// ── Plan step line (full checklist) ─────────────────────────────────────────
function PlanStepLine({
  step,
  busy,
  dense,
  onToggle,
}: {
  step: PlanStep;
  busy: boolean;
  /** The collapsed done group renders small; live steps read at text-sm. */
  dense?: boolean;
  onToggle: () => void;
}) {
  const done = step.status === "done";
  return (
    <div
      className={`flex items-baseline gap-2 ${dense ? "text-xs" : "text-sm"}`}
    >
      <button
        onClick={onToggle}
        disabled={busy}
        className={`${done ? "text-success" : "text-text-faint"} hover:text-text disabled:opacity-50`}
      >
        {done ? "✓" : "○"}
      </button>
      <span
        className={`${actorCls} ${step.actor === "tom" ? "text-warning" : "text-text-faint"}`}
      >
        {step.actor === "tom" ? "you" : "agent"}
      </span>
      <span
        className={done ? "text-text-faint line-through" : "text-text-muted"}
      >
        {step.text}
      </span>
      {step.evidence && (
        <span className="text-xs text-text-faint">
          <Linkified text={step.evidence} />
        </span>
      )}
    </div>
  );
}

// ── Member line ─────────────────────────────────────────────────────────────
function MemberLine({
  member,
  todoById,
  mirrorByKey,
  onOpenItem,
}: {
  member: Member;
  todoById: Map<string, Todo>;
  mirrorByKey: Map<string, MirrorRow>;
  onOpenItem: (id: string) => void;
}) {
  if (member.todoId !== undefined) {
    const t = todoById.get(member.todoId);
    return (
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-mono text-[11px] text-text-faint">
          {t?.status ?? "missing"}
        </span>
        <span className="text-text-muted">
          {t?.statement ?? member.todoId}
        </span>
        {t && (
          <button
            onClick={() => onOpenItem(member.todoId as string)}
            className="text-accent hover:underline"
          >
            open
          </button>
        )}
      </div>
    );
  }
  // No mirror row: the item may be closed upstream (rows are deleted on close)
  // or the member id may never have matched one. Say only what is known.
  const row = mirrorByKey.get(codeSubjectKey(member.repo!, member.externalId!));
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="font-mono text-[11px] text-text-faint">
        {row ? row.status : "not in mirror"}
      </span>
      <span className="text-text-muted">
        {row?.statement ?? `${member.repo} ${member.externalId}`}
      </span>
      {row && (
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          open in {row.repo}
        </a>
      )}
    </div>
  );
}

// ── Batch card ──────────────────────────────────────────────────────────────
function BatchCard({
  todo,
  awaitingRuling,
  todoById,
  mirrorByKey,
  todos,
  mirror,
  notes,
  expanded,
  onToggle,
  onOpenItem,
}: {
  todo: Todo;
  awaitingRuling: boolean;
  /** The tab's prebuilt lookups — member progress and the member lines. */
  todoById: Map<string, Todo>;
  mirrorByKey: Map<string, MirrorRow>;
  /** The raw arrays, for the batch session prompt's member resolution. */
  todos: Todo[];
  mirror: MirrorRow[];
  /** This batch's time notes (the tab holds the query). */
  notes: readonly TimeNote[];
  expanded: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
}) {
  const setPlanStep = useMutation(api.dts.setPlanStep);
  const {
    open: openSession,
    busy: sessionBusy,
    error: sessionError,
  } = useOpenTodoSession();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const members = todo.members ?? [];
  const progress = memberProgress(members, todoById, mirrorByKey);
  const needsYou = planNeedsYou(todo.plan);
  const stepAt = (i: number, status: "open" | "done") =>
    void run(() => setPlanStep({ id: todo._id, index: i, status }));

  const plan = todo.plan ?? [];
  const openSteps = plan
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status !== "done");
  const doneSteps = plan
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "done");

  // The batch session prompt carries live member statements + statuses, which
  // useOpenTodoSession resolves from the todos + mirror this card already
  // holds — so every batch open, button or verdict, passes that context.
  // `tab`/`ruling` come from the session verdict's own click when fired there.
  const openBatchSession = (tab?: ReservedTab, ruling?: LiveRulingContext) =>
    openSession(todo, { batch: { todos, mirror }, tab, ruling });

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-text-faint text-xs">{expanded ? "▾" : "▸"}</span>
        {todo.importance && (
          <span
            title={`${todo.importance.level} · ${todo.importance.setBy}${
              todo.importance.rationale ? ` — ${todo.importance.rationale}` : ""
            }`}
            className="inline-flex"
          >
            <ImportanceBars
              level={todo.importance.level}
              fillCls="bg-warning"
            />
          </span>
        )}
        <span className="text-base text-text">{todo.statement}</span>
        {awaitingRuling && (
          <span className="text-xs text-accent">awaiting ruling</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {needsYou.count > 0 && (
            <span className="text-xs text-accent">
              {needsYou.count} for you
            </span>
          )}
          {members.length > 0 && (
            <MemberBar done={progress.done} total={progress.total} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-3">
          {/* options first — the session button and every verdict on one line */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              onClick={() => void openBatchSession()}
              disabled={busy || sessionBusy}
              className={primaryBtnCls}
            >
              Open batch session
            </button>
            <Info
              label={`claudeSessions.createSession({kind:"${
                todo.readiness === "ready-for-tom" ? "gate" : "focus-item"
              }"})`}
            />
            <OptionsRow
              todo={todo}
              rulable
              afterSession={(tab, ruling) => void openBatchSession(tab, ruling)}
            />
          </div>
          {sessionError && (
            <div className="text-xs text-error">{sessionError}</div>
          )}

          {/* the batch's only timing INPUT — an agent reads the note */}
          <TimeNoteField todoId={todo._id} notes={notes} />

          {/* needs you */}
          {needsYou.count > 0 && (
            <div className="border-l-2 border-accent pl-2 space-y-1">
              <Info label='dts.setPlanStep({index, status:"done"})' />
              {/* the SAME line the full plan renders — evidence link and all;
                  planNeedsYou keeps each step's plan index, which is what
                  setPlanStep addresses */}
              {needsYou.steps.map(({ step, index }) => (
                <PlanStepLine
                  key={index}
                  step={step}
                  busy={busy}
                  onToggle={() => stepAt(index, "done")}
                />
              ))}
            </div>
          )}

          {/* brief */}
          {todo.brief && (
            <div className="text-sm text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
              {todo.brief}
            </div>
          )}

          {/* full plan — open steps, then the done ones behind one faint line */}
          {plan.length > 0 && (
            <div className="space-y-1">
              <Info label="dts.setPlanStep({index, status})" />
              {openSteps.map(({ step, index }) => (
                <PlanStepLine
                  key={index}
                  step={step}
                  busy={busy}
                  onToggle={() => stepAt(index, "done")}
                />
              ))}
              {doneSteps.length > 0 && (
                <button
                  onClick={() => setShowDone((v) => !v)}
                  className="text-xs text-text-faint hover:text-text-muted"
                >
                  ✓ {doneSteps.length} done
                </button>
              )}
              {showDone &&
                doneSteps.map(({ step, index }) => (
                  <PlanStepLine
                    key={index}
                    step={step}
                    busy={busy}
                    dense
                    onToggle={() => stepAt(index, "open")}
                  />
                ))}
            </div>
          )}

          {/* members */}
          {members.length > 0 && (
            <div className="space-y-1">
              {members.map((m) => (
                <MemberLine
                  key={clientMemberKey(m)}
                  member={m}
                  todoById={todoById}
                  mirrorByKey={mirrorByKey}
                  onOpenItem={onOpenItem}
                />
              ))}
            </div>
          )}

          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
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
export default function BatchesTab({
  onOpenItem,
}: {
  onOpenItem: (id: string) => void;
}) {
  const { isTom } = useAuth();
  const todos = useQuery(api.dts.listTodos, isTom ? {} : "skip");
  const mirror = useQuery(api.dts.listMirror, isTom ? {} : "skip");
  const briefs = useQuery(api.dtsCode.listCodeBriefs, isTom ? {} : "skip");
  const rulings = useQuery(api.dtsRulings.listRulings, isTom ? {} : "skip");
  // ONE time-note subscription for the whole tab; each row slices it.
  const timeNotes = useQuery(api.dts.listTimeNotes, isTom ? {} : "skip");
  const recordEvent = useMutation(api.dts.recordEvent);

  const now = Date.now();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string, engage: () => void) => {
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening) engage();
  };

  // ONE definition of the selection (app/dts/lib.ts selectBatches) — the
  // shell's tab badge counts the same selection, so count and rows cannot
  // drift.
  const selection = useMemo(
    () => selectBatches(todos ?? [], mirror ?? [], briefs ?? [], rulings ?? []),
    [todos, mirror, briefs, rulings],
  );

  const todoById = useMemo(
    () => new Map((todos ?? []).map((t) => [t._id as string, t])),
    [todos],
  );
  const mirrorByKey = useMemo(
    () =>
      new Map(
        (mirror ?? []).map((r) => [codeSubjectKey(r.repo, r.externalId), r]),
      ),
    [mirror],
  );

  // Live ruling per subject — the shared derivation (app/dts/lib.ts), the same
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
    for (const r of mirror ?? [])
      map.set(codeSubjectKey(r.repo, r.externalId), r.statement);
    return map;
  }, [todos, mirror]);

  const applying = useMemo(
    () => [...selection.pending].sort((a, b) => b.ruledAt - a.ruledAt),
    [selection],
  );

  if (
    todos === undefined ||
    mirror === undefined ||
    briefs === undefined ||
    rulings === undefined
  ) {
    return <div className="text-sm text-text-faint py-8">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionHeader
          title="batches · importance desc"
          count={selection.batches.length}
        />
        {selection.batches.length > 0 && (
          <div className="space-y-1.5">
            {selection.batches.map(({ todo, awaitingRuling }) => (
              <BatchCard
                key={todo._id}
                todo={todo}
                awaitingRuling={awaitingRuling}
                todoById={todoById}
                mirrorByKey={mirrorByKey}
                todos={todos}
                mirror={mirror}
                notes={notesByContext.get(todo._id) ?? NO_NOTES}
                expanded={expanded.has(todo._id)}
                onToggle={() =>
                  toggle(todo._id, () => {
                    void recordEvent({
                      kind: "engaged",
                      todoId: todo._id,
                      data: { via: "batches" },
                    }).catch(() => {});
                  })
                }
                onOpenItem={onOpenItem}
              />
            ))}
          </div>
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
                  : r.todoId)}
            </span>
            <span className="text-text-faint">{ageText(r.ruledAt, now)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
