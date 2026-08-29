"use client";

// BATCHES — the default tab. Batch cards (importance desc), then the
// selectNeedsMe rows no batch claims, then the ruled-but-not-yet-applied
// pipeline strip. selectBatches (app/dts/lib.ts) is the ONE selector — the
// shell's tab badge counts the same selection, so count and rows cannot drift.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { countdownText } from "@/convex/dtsShared";
import { useAuth } from "@/app/lib/auth";
import { useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import VerdictButtons from "./verdict-buttons";
import Info from "./info";
import {
  ageText,
  clientMemberKey,
  codeSubjectKey,
  errMessage,
  fmtDate,
  IMPORTANCE_LEVELS,
  memberProgress,
  planNeedsYou,
  rulingSubjectKey,
  selectBatches,
  toDatetimeLocal,
  type CodeBrief,
  type Member,
  type MirrorRow,
  type PlanStep,
  type Todo,
} from "@/app/dts/lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
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
  const row = mirrorByKey.get(codeSubjectKey(member.repo!, member.externalId!));
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="font-mono text-[11px] text-text-faint">
        {row ? row.status : "closed upstream"}
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
  todoById: Map<string, Todo>;
  mirrorByKey: Map<string, MirrorRow>;
  todos: Todo[];
  mirror: MirrorRow[];
  expanded: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
}) {
  const recordRuling = useMutation(api.dtsRulings.recordRuling);
  const setStatus = useMutation(api.dts.setStatus);
  const createBlock = useMutation(api.dts.createBlock);
  const setImportance = useMutation(api.dts.setImportance);
  const setPlanStep = useMutation(api.dts.setPlanStep);
  const {
    open: openSession,
    busy: sessionBusy,
    error: sessionError,
  } = useOpenTodoSession();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneNoteDraft, setDoneNoteDraft] = useState("");
  const [unarchiveDraft, setUnarchiveDraft] = useState("");
  const [blockStartDraft, setBlockStartDraft] = useState("");
  const [blockEndDraft, setBlockEndDraft] = useState("");

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
  const progress = memberProgress(members, todos, mirror);
  const needsYou = planNeedsYou(todo.plan);
  const stepAt = (i: number, status: "open" | "done") =>
    void run(() => setPlanStep({ id: todo._id, index: i, status }));

  const commitBlock = () => {
    const start = blockStartDraft ? new Date(blockStartDraft).getTime() : NaN;
    const end = blockEndDraft ? new Date(blockEndDraft).getTime() : NaN;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      setError("pick start and end");
      return;
    }
    if (end <= start) {
      setError("end must be after start");
      return;
    }
    void run(async () => {
      await createBlock({ start, end, todoId: todo._id });
      setBlockStartDraft("");
      setBlockEndDraft("");
    });
  };

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
                onClick={() => void openSession(todo)}
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
            afterSession={() => openSession(todo)}
          />

          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            {todo.status !== "done" && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      void run(() =>
                        setStatus({
                          id: todo._id,
                          status: "done",
                          note: doneNoteDraft.trim() || undefined,
                        }),
                      )
                    }
                    disabled={busy}
                    className={btnCls}
                  >
                    Done
                  </button>
                  <input
                    value={doneNoteDraft}
                    onChange={(e) => setDoneNoteDraft(e.target.value)}
                    placeholder="note (optional)"
                    className={`${inputCls} w-36`}
                  />
                </div>
                <Info label='dts.setStatus({status:"done"})' />
              </div>
            )}
            {todo.status !== "archived" && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      void run(() =>
                        setStatus({
                          id: todo._id,
                          status: "archived",
                          unarchiveCondition:
                            unarchiveDraft.trim() || undefined,
                        }),
                      )
                    }
                    disabled={busy}
                    className={btnCls}
                  >
                    Archive
                  </button>
                  <input
                    value={unarchiveDraft}
                    onChange={(e) => setUnarchiveDraft(e.target.value)}
                    placeholder="propose back when (optional)"
                    className={`${inputCls} w-44`}
                  />
                </div>
                <Info label='dts.setStatus({status:"archived"})' />
              </div>
            )}
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <input
                  type="datetime-local"
                  value={blockStartDraft}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBlockStartDraft(v);
                    const ms = v ? new Date(v).getTime() : NaN;
                    if (!Number.isNaN(ms)) {
                      setBlockEndDraft(toDatetimeLocal(ms + 3_600_000));
                    }
                  }}
                  className={inputCls}
                />
                <input
                  type="datetime-local"
                  value={blockEndDraft}
                  onChange={(e) => setBlockEndDraft(e.target.value)}
                  className={inputCls}
                />
                <button
                  onClick={commitBlock}
                  disabled={busy}
                  className={btnCls}
                >
                  Commit time
                </button>
              </div>
              <Info label="dts.createBlock({todoId})" />
            </div>
          </div>

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
                <Info label='dts.setPlanStep({index, status:"done"})' />
              </div>
              {(todo.plan ?? []).map((step, i) =>
                step.actor === "tom" && step.status === "open" ? (
                  <div key={i} className="flex items-baseline gap-2 text-xs">
                    <button
                      onClick={() => stepAt(i, "done")}
                      disabled={busy}
                      className="text-text-faint hover:text-text disabled:opacity-50"
                    >
                      ○
                    </button>
                    <span className="text-text-muted">{step.text}</span>
                  </div>
                ) : null,
              )}
            </div>
          )}

          {/* full plan */}
          {todo.plan && todo.plan.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-text-faint">plan</span>
                <Info label="dts.setPlanStep({index, status})" />
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

          {/* importance override */}
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              {IMPORTANCE_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() =>
                    void run(() => setImportance({ id: todo._id, level }))
                  }
                  disabled={busy}
                  className={`${btnCls} ${
                    todo.importance?.level === level
                      ? "border-accent/60 text-text"
                      : ""
                  }`}
                >
                  {level}
                </button>
              ))}
              {todo.importance && (
                <button
                  onClick={() =>
                    void run(() =>
                      setImportance({ id: todo._id, level: null }),
                    )
                  }
                  disabled={busy}
                  className="text-xs text-text-faint hover:text-text-muted"
                >
                  clear
                </button>
              )}
              {todo.importance?.setBy === "agent" &&
                todo.importance.rationale && (
                  <span className="text-xs text-text-faint">
                    {todo.importance.rationale}
                  </span>
                )}
            </div>
            <Info label="dts.setImportance({level})" />
          </div>

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
  const recordRuling = useMutation(api.dtsRulings.recordRuling);
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

// ── Unbatched code row (open · briefed · no live ruling, in no batch) ───────
function CodeRow({
  row,
  brief,
  expanded,
  onToggle,
}: {
  row: MirrorRow;
  brief: CodeBrief;
  expanded: boolean;
  onToggle: () => void;
}) {
  const recordRuling = useMutation(api.dtsRulings.recordRuling);

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-sm text-text">{row.statement}</span>
        <span className="text-xs text-text-faint">{row.repo}</span>
        <span className={chipCls}>{row.tier}</span>
        <span className={chipCls}>recommends: {brief.recommendation}</span>
        {brief.execClass === "needs-turing" && (
          <span className={chipCls}>needs-turing</span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <VerdictButtons
            record={(args) =>
              recordRuling({
                repo: row.repo,
                externalId: row.externalId,
                ...args,
              })
            }
          />
          <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
            {brief.brief}
          </div>
          {brief.evidence && (
            <div className="text-xs">
              <span className="text-text-faint">evidence: </span>
              <span className="text-text-muted break-words">
                {brief.evidence}
              </span>
            </div>
          )}
          <div className="text-xs">
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              open in {row.repo}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

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
                <CodeRow
                  key={row._id}
                  row={row}
                  brief={brief}
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
