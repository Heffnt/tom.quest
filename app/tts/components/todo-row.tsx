"use client";

// One life-todo row: click-to-expand summary line + detail panel.
// Panel order: intent banner → action row (session + verdicts) → status strip
// → importance → date controls → brief → "edit" disclosure (field editors,
// full fact grid, date history). Actions sit at the top everywhere.
//
// A batch is a life todo with members, so it reaches this row too (the by-
// individual tab lists every todo): the header marks it and the fact grid
// carries the member count — the members and the plan are worked on the
// batches tab.

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { countdownText } from "@/convex/ttsShared";
import { useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import Info from "./info";
import VerdictButtons from "./verdict-buttons";
import { ImportanceButtons, StatusActions } from "./status-actions";
import {
  ageText,
  errMessage,
  fmtDate,
  isoDate,
  parseDateInput,
  type LinkIntent,
  type Todo,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
const primaryBtnCls =
  "bg-accent text-bg rounded-md px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none";
const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";

/** The mono caption naming the mutation a control fires — behind an ⓘ. */
function Caption({ children }: { children: string }) {
  return <Info label={children} />;
}

// ── Small inline field editor ───────────────────────────────────────────────
function FieldEditor({
  label,
  caption,
  value,
  multiline,
  onSave,
}: {
  label: string;
  caption: string;
  value: string | undefined;
  multiline?: boolean;
  onSave: (next: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value ?? ""), [value]);
  const dirty = draft !== (value ?? "");

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-text-faint">{label}</span>
        <Caption>{caption}</Caption>
      </div>
      <div className="flex gap-2 items-start">
        {multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            className={`${inputCls} w-full resize-y`}
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={`${inputCls} w-full`}
          />
        )}
        {dirty && (
          <button onClick={save} disabled={busy} className={btnCls}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-text-faint">{label}: </span>
      <span className="text-text-muted">{children}</span>
    </div>
  );
}

// ── The row ─────────────────────────────────────────────────────────────────
export default function TodoRow({
  todo,
  now,
  expanded,
  onToggle,
  intent,
  onIntentCleared,
}: {
  todo: Todo;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  /** Deep-link intent aimed at THIS todo (?item=…&intent=…), else null. */
  intent: LinkIntent | null;
  onIntentCleared: () => void;
}) {
  const updateTodo = useMutation(api.tts.updateTodo);
  const setStatus = useMutation(api.tts.setStatus);
  const recordDateOutcome = useMutation(api.tts.recordDateOutcome);
  const recordEvent = useMutation(api.tts.recordEvent);
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const {
    open: openTodoSession,
    busy: sessionBusy,
    error: sessionError,
  } = useOpenTodoSession();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // Date-control drafts (Done/Archive/commit-time drafts live in StatusActions)
  const [dateDraft, setDateDraft] = useState("");
  const [latestSafeDraft, setLatestSafeDraft] = useState("");
  // Edit-disclosure drafts
  const [wakeAtDraft, setWakeAtDraft] = useState("");
  const [wakeConditionDraft, setWakeConditionDraft] = useState("");

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

  const noDateFlag =
    todo.status === "active" &&
    todo.timingClass === "whenever" &&
    todo.dueAt === undefined;

  const intentCaption =
    intent === "done"
      ? 'tts.setStatus({status:"done"})'
      : intent === "archive"
        ? 'tts.setStatus({status:"archived"})'
        : 'tts.recordEvent({kind:"engaged"})';

  const confirmIntent = () =>
    run(async () => {
      if (intent === "done") {
        await setStatus({ id: todo._id, status: "done" });
      } else if (intent === "archive") {
        await setStatus({ id: todo._id, status: "archived" });
      } else if (intent === "engage") {
        await recordEvent({
          kind: "engaged",
          todoId: todo._id,
          data: { via: "everything", intent: "slack-link" },
        });
      }
      onIntentCleared();
    });

  const renegotiate = () => {
    const newDueAt = parseDateInput(dateDraft);
    if (todo.dueAt !== undefined && now >= todo.dueAt) {
      setError("date already passed — record missed instead");
      return;
    }
    if (newDueAt === undefined) {
      setError("pick a date first");
      return;
    }
    void run(() =>
      recordDateOutcome({ id: todo._id, outcome: "renegotiated", newDueAt }),
    );
  };

  const recordMissed = () => {
    const newDueAt = parseDateInput(dateDraft);
    void run(() =>
      recordDateOutcome({ id: todo._id, outcome: "missed", newDueAt }),
    );
  };

  // Summary-line facts, per status/timing.
  const facts: React.ReactNode[] = [];
  if (todo.dueAt !== undefined) {
    facts.push(
      <span key="due">
        <span
          className={todo.dueAt < now ? "text-warning" : "text-text-muted"}
        >
          {countdownText(todo.dueAt, now)}
        </span>{" "}
        <span className="text-text-faint">
          {fmtDate(todo.dueAt)}
          {todo.dateKind ? ` · ${todo.dateKind} date` : ""}
        </span>
      </span>,
    );
  }
  if (todo.timingClass === "condition-bound") {
    if (todo.condition) {
      facts.push(
        <span key="cond" className="text-text-muted">
          when: {todo.condition}
        </span>,
      );
    }
    if (todo.latestSafeAt !== undefined) {
      facts.push(
        <span key="safe">
          <span className="text-text-muted">
            latest safe {countdownText(todo.latestSafeAt, now)}
          </span>{" "}
          <span className="text-text-faint">{fmtDate(todo.latestSafeAt)}</span>
        </span>,
      );
    }
  }
  if (noDateFlag) {
    facts.push(
      <span key="nodate" className="text-warning">
        no date
      </span>,
    );
  }
  if (todo.status === "waiting") {
    facts.push(
      <span key="wake" className="text-text-muted">
        {todo.wakeCondition ? `until: ${todo.wakeCondition}` : "waiting"}
        {todo.wakeAt !== undefined && (
          <span className="text-text-faint">
            {" "}
            · wakes {countdownText(todo.wakeAt, now)} ({fmtDate(todo.wakeAt)})
          </span>
        )}
      </span>,
    );
  }
  if (todo.status === "done" && todo.doneAt !== undefined) {
    facts.push(
      <span key="done" className="text-text-faint">
        done {fmtDate(todo.doneAt)}
      </span>,
    );
  }
  if (todo.status === "archived") {
    facts.push(
      <span key="arch" className="text-text-faint">
        {todo.archivedAt !== undefined
          ? `archived ${fmtDate(todo.archivedAt)}`
          : "archived"}
        {todo.unarchiveCondition
          ? ` · propose back when: ${todo.unarchiveCondition}`
          : ""}
      </span>,
    );
  }

  return (
    <div
      id={`todo-${todo._id}`}
      className={`border rounded-lg bg-surface/40 ${
        intent ? "border-accent" : "border-border"
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-sm text-text">{todo.statement}</span>
        {todo.members !== undefined && (
          <span className={chipCls}>batch · {todo.members.length} members</span>
        )}
        <span className={chipCls}>{todo.readiness}</span>
        {todo.status !== "active" && (
          <span className={chipCls}>{todo.status}</span>
        )}
        {todo.category && <span className={chipCls}>{todo.category}</span>}
        {todo.importance && (
          <span className="text-xs">
            <span
              className={
                todo.importance.level === "high"
                  ? "text-accent"
                  : "text-text-muted"
              }
            >
              {todo.importance.level}
            </span>
            <span className="text-text-faint"> · {todo.importance.setBy}</span>
          </span>
        )}
        <span className="text-xs flex flex-wrap gap-x-3 gap-y-0.5 ml-auto">
          {facts}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-3">
          {/* 1 — intent banner */}
          {intent && (
            <div className="border border-accent bg-accent-dim rounded-md px-3 py-1.5 flex flex-wrap items-center gap-3">
              <span className="text-sm text-text">intent: {intent}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={confirmIntent}
                  disabled={busy}
                  className={primaryBtnCls}
                >
                  Confirm {intent}
                </button>
                <Caption>{intentCaption}</Caption>
              </div>
              <button
                onClick={onIntentCleared}
                className="text-xs text-text-faint hover:text-text-muted"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* 2 — action row */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void openTodoSession(todo)}
                  disabled={busy || sessionBusy}
                  className={btnCls}
                >
                  Open session
                </button>
                <Caption>
                  {`claudeSessions.createSession({kind:"${
                    todo.readiness === "ready-for-tom" ? "gate" : "focus-item"
                  }"})`}
                </Caption>
              </div>
              {sessionError && (
                <div className="text-xs text-error">{sessionError}</div>
              )}
            </div>
          </div>

          {/* verdicts — a gate item is ruled from wherever it is seen, not
              only from the batches tab (batched members lose that strip) */}
          {todo.status === "active" && todo.readiness === "ready-for-tom" && (
            <VerdictButtons
              record={(args) => recordRuling({ todoId: todo._id, ...args })}
              afterSession={() => openTodoSession(todo)}
            />
          )}

          {/* status strip — same component the batch card renders */}
          <StatusActions todo={todo} />

          <ImportanceButtons todo={todo} />

          {/* date controls */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <input
                type="date"
                value={dateDraft}
                onChange={(e) => setDateDraft(e.target.value)}
                className={inputCls}
              />
              {todo.dueAt === undefined ? (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      const dueAt = parseDateInput(dateDraft);
                      if (dueAt === undefined) {
                        setError("pick a date first");
                        return;
                      }
                      void run(() => updateTodo({ id: todo._id, dueAt }));
                    }}
                    disabled={busy}
                    className={btnCls}
                  >
                    Set date
                  </button>
                  <Caption>{"tts.updateTodo({dueAt})"}</Caption>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={renegotiate}
                      disabled={busy}
                      className={btnCls}
                    >
                      Renegotiate
                    </button>
                    <Caption>
                      {'tts.recordDateOutcome({outcome:"renegotiated", newDueAt})'}
                    </Caption>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={recordMissed}
                      disabled={busy}
                      className={btnCls}
                    >
                      Record missed
                    </button>
                    <Caption>
                      {`tts.recordDateOutcome({outcome:"missed"${
                        dateDraft ? ", newDueAt" : ""
                      }})`}
                    </Caption>
                  </div>
                  <div className="flex items-center gap-1">
                    <select
                      value={todo.dateKind ?? "self-imposed"}
                      onChange={(e) =>
                        void run(() =>
                          updateTodo({
                            id: todo._id,
                            dateKind: e.target.value as
                              | "external"
                              | "self-imposed",
                          }),
                        )
                      }
                      className={inputCls}
                    >
                      <option value="external">external</option>
                      <option value="self-imposed">self-imposed</option>
                    </select>
                    <Caption>{"tts.updateTodo({dateKind})"}</Caption>
                  </div>
                </>
              )}
            </div>
            {todo.timingClass === "condition-bound" && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-xs text-text-faint self-center">
                  latest safe:
                </span>
                <input
                  type="date"
                  value={latestSafeDraft}
                  onChange={(e) => setLatestSafeDraft(e.target.value)}
                  className={inputCls}
                />
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      const latestSafeAt = parseDateInput(latestSafeDraft);
                      if (latestSafeAt === undefined) {
                        setError("pick a latest-safe date first");
                        return;
                      }
                      void run(() =>
                        updateTodo({ id: todo._id, latestSafeAt }),
                      );
                    }}
                    disabled={busy}
                    className={btnCls}
                  >
                    Set latest safe
                  </button>
                  <Caption>{"tts.updateTodo({latestSafeAt})"}</Caption>
                </div>
                {todo.latestSafeAt !== undefined && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        void run(() =>
                          updateTodo({ id: todo._id, latestSafeAt: null }),
                        )
                      }
                      disabled={busy}
                      className={btnCls}
                    >
                      Clear latest safe
                    </button>
                    <Caption>{"tts.updateTodo({latestSafeAt:null})"}</Caption>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 3 — brief */}
          {todo.brief && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">brief</div>
              <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
                {todo.brief}
              </div>
            </div>
          )}

          {/* 4 — edit disclosure */}
          <button
            onClick={() => setEditOpen((v) => !v)}
            className="text-xs text-text-faint hover:text-text-muted"
          >
            {editOpen ? "edit ▾" : "edit ▸"}
          </button>

          {editOpen && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <FieldEditor
                  label="statement"
                  caption="tts.updateTodo({statement})"
                  value={todo.statement}
                  onSave={(v) => updateTodo({ id: todo._id, statement: v })}
                />
                <FieldEditor
                  label="entry action"
                  caption="tts.updateTodo({entryAction})"
                  value={todo.entryAction}
                  onSave={(v) => updateTodo({ id: todo._id, entryAction: v })}
                />
                <FieldEditor
                  label="body"
                  caption="tts.updateTodo({body})"
                  value={todo.body}
                  multiline
                  onSave={(v) => updateTodo({ id: todo._id, body: v })}
                />
                <FieldEditor
                  label="work description"
                  caption="tts.updateTodo({workDescription})"
                  value={todo.workDescription}
                  multiline
                  onSave={(v) =>
                    updateTodo({ id: todo._id, workDescription: v })
                  }
                />
                <FieldEditor
                  label="category"
                  caption="tts.updateTodo({category})"
                  value={todo.category}
                  onSave={(v) =>
                    updateTodo({ id: todo._id, category: v.trim() || null })
                  }
                />
                <div className="space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-text-faint">readiness</span>
                    <Caption>{"tts.updateTodo({readiness})"}</Caption>
                  </div>
                  <select
                    value={todo.readiness}
                    onChange={(e) =>
                      void run(() =>
                        updateTodo({
                          id: todo._id,
                          readiness: e.target.value as Todo["readiness"],
                        }),
                      )
                    }
                    className={inputCls}
                  >
                    <option value="unprepared">unprepared</option>
                    <option value="preparing">preparing</option>
                    <option value="ready-for-tom">ready-for-tom</option>
                  </select>
                </div>
              </div>

              {todo.status !== "waiting" && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <input
                    value={wakeConditionDraft}
                    onChange={(e) => setWakeConditionDraft(e.target.value)}
                    placeholder="wake condition (optional)"
                    className={`${inputCls} w-64`}
                  />
                  <input
                    type="date"
                    value={wakeAtDraft}
                    onChange={(e) => setWakeAtDraft(e.target.value)}
                    className={inputCls}
                  />
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        void run(() =>
                          setStatus({
                            id: todo._id,
                            status: "waiting",
                            wakeCondition:
                              wakeConditionDraft.trim() || undefined,
                            wakeAt: parseDateInput(wakeAtDraft),
                          }),
                        )
                      }
                      disabled={busy}
                      className={btnCls}
                    >
                      Set waiting
                    </button>
                    <Caption>{'tts.setStatus({status:"waiting"})'}</Caption>
                  </div>
                </div>
              )}

              {todo.status !== "active" && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      void run(() =>
                        setStatus({ id: todo._id, status: "active" }),
                      )
                    }
                    disabled={busy}
                    className={btnCls}
                  >
                    Set active
                  </button>
                  <Caption>{'tts.setStatus({status:"active"})'}</Caption>
                </div>
              )}

              {/* full fact grid */}
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <Fact label="readiness">{todo.readiness}</Fact>
                <Fact label="status">{todo.status}</Fact>
                <Fact label="timingClass">{todo.timingClass}</Fact>
                {todo.category && (
                  <Fact label="category">{todo.category}</Fact>
                )}
                {todo.members !== undefined && (
                  <Fact label="members">{todo.members.length}</Fact>
                )}
                {todo.importance && (
                  <Fact label="importance">
                    {todo.importance.level} · {todo.importance.setBy}
                  </Fact>
                )}
                <Fact label="source">
                  {todo.source}
                  {todo.provenance ? ` (${todo.provenance})` : ""}
                </Fact>
                <Fact label="createdAt">
                  {ageText(todo.createdAt, now)} · {fmtDate(todo.createdAt)}
                </Fact>
                <Fact label="updatedAt">{ageText(todo.updatedAt, now)}</Fact>
                {todo.dueAt !== undefined && (
                  <Fact label="dueAt">
                    {countdownText(todo.dueAt, now)} · {fmtDate(todo.dueAt)}
                    {todo.dateKind ? ` · ${todo.dateKind}` : ""}
                  </Fact>
                )}
                {todo.condition && (
                  <Fact label="condition">{todo.condition}</Fact>
                )}
                {todo.latestSafeAt !== undefined && (
                  <Fact label="latestSafeAt">
                    {countdownText(todo.latestSafeAt, now)} ·{" "}
                    {fmtDate(todo.latestSafeAt)}
                  </Fact>
                )}
                {todo.wakeCondition && (
                  <Fact label="wakeCondition">{todo.wakeCondition}</Fact>
                )}
                {todo.wakeAt !== undefined && (
                  <Fact label="wakeAt">
                    {countdownText(todo.wakeAt, now)} · {fmtDate(todo.wakeAt)}
                  </Fact>
                )}
                {todo.unarchiveCondition && (
                  <Fact label="unarchiveCondition">
                    {todo.unarchiveCondition}
                  </Fact>
                )}
                {todo.doneAt !== undefined && (
                  <Fact label="doneAt">{fmtDate(todo.doneAt)}</Fact>
                )}
                {todo.archivedAt !== undefined && (
                  <Fact label="archivedAt">{fmtDate(todo.archivedAt)}</Fact>
                )}
              </div>

              {/* date-outcome history */}
              {todo.dateOutcomes && todo.dateOutcomes.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs text-text-faint">dateOutcomes</div>
                  {todo.dateOutcomes.map((o, i) => {
                    const next = todo.dateOutcomes![i + 1];
                    const target =
                      o.outcome === "renegotiated"
                        ? next
                          ? next.dueAt
                          : todo.dueAt
                        : undefined;
                    return (
                      <div key={i} className="text-xs text-text-muted">
                        {isoDate(o.dueAt)}: {o.outcome}
                        {target !== undefined ? ` → ${isoDate(target)}` : ""}
                        <span className="text-text-faint">
                          {" "}
                          (recorded {isoDate(o.recordedAt)})
                        </span>
                        {o.note ? <span> — {o.note}</span> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
