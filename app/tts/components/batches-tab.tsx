"use client";

// BATCHES — the default tab. Batch cards (importance desc), then the
// selectNeedsMe rows no batch claims, then the ruled-but-not-yet-applied
// pipeline strip. selectBatches (app/tts/lib.ts) is the ONE selector — the
// shell's tab badge counts the same selection, so count and rows cannot drift.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { countdownText } from "@/convex/ttsShared";
import { useAuth } from "@/app/lib/auth";
import { useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import VerdictButtons from "./verdict-buttons";
import CodeTodoRow from "./code-todo-row";
import { ImportanceButtons, StatusActions } from "./status-actions";
import Info from "./info";
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
} from "@/app/tts/lib";

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

// ── Plan step line (full checklist) ─────────────────────────────────────────
function PlanStepLine({
  step,
  busy,
  onToggle,
}: {
  step: PlanStep;
  busy: boolean;
  onToggle: () => void;
}) {
  const done = step.status === "done";
  return (
    <div className="flex items-baseline gap-2 text-xs">
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
        <span className="text-text-faint">
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
  expanded: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
}) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const setPlanStep = useMutation(api.tts.setPlanStep);
  const {
    open: openSession,
    busy: sessionBusy,
    error: sessionError,
  } = useOpenTodoSession();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // The batch session prompt carries live member statements + statuses, which
  // useOpenTodoSession resolves from the todos + mirror this card already
  // holds — so every batch open, button or verdict, passes that context.
  const openBatchSession = () => openSession(todo, { batch: { todos, mirror } });

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-text-faint text-xs">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="text-sm text-text">{todo.statement}</span>
        {todo.importance && (
          <span className={chipCls}>
            {todo.importance.level}{" "}
            <span className="text-text-faint">{todo.importance.setBy}</span>
          </span>
        )}
        {awaitingRuling && (
          <span className="text-xs text-accent">awaiting ruling</span>
        )}
        <span className="text-xs text-text-faint ml-auto">
          {progress.done} of {progress.total} done
          {needsYou.count > 0 ? ` · needs you: ${needsYou.count}` : ""}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-3">
          {/* actions first */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="space-y-0.5">
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
              {sessionError && (
                <div className="text-xs text-error">{sessionError}</div>
              )}
            </div>
          </div>

          <VerdictButtons
            record={(args) => recordRuling({ todoId: todo._id, ...args })}
            afterSession={openBatchSession}
          />

          {/* status strip — same component the generic todo row renders */}
          <StatusActions todo={todo} />

          {/* brief */}
          {todo.brief && (
            <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
              {todo.brief}
            </div>
          )}

          {/* needs you */}
          {needsYou.count > 0 && (
            <div className="border-l-2 border-accent pl-2 space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-text">needs you</span>
                <Info label='tts.setPlanStep({index, status:"done"})' />
              </div>
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

          {/* full plan */}
          {todo.plan && todo.plan.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-text-faint">plan</span>
                <Info label="tts.setPlanStep({index, status})" />
              </div>
              {todo.plan.map((step, i) => (
                <PlanStepLine
                  key={i}
                  step={step}
                  busy={busy}
                  onToggle={() =>
                    stepAt(i, step.status === "done" ? "open" : "done")
                  }
                />
              ))}
            </div>
          )}

          {/* members */}
          {members.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">members</div>
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

          {/* importance override — same component the generic todo row renders */}
          <ImportanceButtons todo={todo} />

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
  expanded,
  onToggle,
}: {
  todo: Todo;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const { open: openSession, error: sessionError } = useOpenTodoSession();

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-sm text-text">{todo.statement}</span>
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
          <VerdictButtons
            record={(args) => recordRuling({ todoId: todo._id, ...args })}
            afterSession={() => openSession(todo)}
          />
          {sessionError && (
            <div className="text-xs text-error">{sessionError}</div>
          )}
          {todo.brief && (
            <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
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
// evidence, importance, the live ruling and the verdict buttons behind "rule
// here" all come from that one row, so a code item looks and behaves the same
// on this tab and on the by-individual tab.

// ── The tab ─────────────────────────────────────────────────────────────────
export default function BatchesTab({
  onOpenItem,
}: {
  onOpenItem: (id: string) => void;
}) {
  const { isTom } = useAuth();
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const mirror = useQuery(api.tts.listMirror, isTom ? {} : "skip");
  const briefs = useQuery(api.ttsCode.listCodeBriefs, isTom ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, isTom ? {} : "skip");
  const recordEvent = useMutation(api.tts.recordEvent);

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

  // ONE definition of the selection (app/tts/lib.ts selectBatches) — the
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

  // Live ruling per subject — the shared derivation (app/tts/lib.ts), the same
  // one the by-individual tab feeds CodeTodoRow.
  const liveRulingByKey = useMemo(
    () => liveRulingsByKey(rulings ?? []),
    [rulings],
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
