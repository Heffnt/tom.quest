"use client";

// One life-todo row: a click-to-expand summary line plus the full detail
// panel (every field, inline edits, date controls, status transitions, and
// the date-outcome history). Descriptive copy only — facts, never verdicts.

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { countdownText } from "@/convex/dtsShared";
import {
  ageText,
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

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Small inline field editor (statement / body / entry-action / work) ──────
function FieldEditor({
  label,
  value,
  multiline,
  onSave,
}: {
  label: string;
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
      <div className="text-xs text-text-faint">{label}</div>
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
  const updateTodo = useMutation(api.dts.updateTodo);
  const setStatus = useMutation(api.dts.setStatus);
  const recordDateOutcome = useMutation(api.dts.recordDateOutcome);
  const recordEvent = useMutation(api.dts.recordEvent);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Date controls
  const [dateDraft, setDateDraft] = useState("");
  // Status controls
  const [unarchiveDraft, setUnarchiveDraft] = useState("");
  const [wakeAtDraft, setWakeAtDraft] = useState("");
  const [wakeConditionDraft, setWakeConditionDraft] = useState("");
  const [latestSafeDraft, setLatestSafeDraft] = useState("");

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
          data: { via: "inventory", intent: "slack-link" },
        });
      }
      onIntentCleared();
    });

  const renegotiate = () => {
    const newDueAt = parseDateInput(dateDraft);
    if (todo.dueAt !== undefined && now >= todo.dueAt) {
      setError(
        "The date has already passed — renegotiation is only allowed before the date arrives. Record it as missed, then set a new date.",
      );
      return;
    }
    if (newDueAt === undefined) {
      setError("Renegotiation requires the new date — pick one first.");
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
          className={
            todo.dueAt < now ? "text-warning" : "text-text-muted"
          }
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
        no date — set one or archive
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
        {todo.unarchiveCondition ? ` · propose back when: ${todo.unarchiveCondition}` : ""}
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
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-sm text-text">{todo.statement}</span>
        <span className="text-xs text-text-faint border border-border rounded px-1 py-px">
          {todo.readiness}
        </span>
        <span className="text-xs flex flex-wrap gap-x-3 gap-y-0.5 ml-auto">
          {facts}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-4">
          {intent && (
            <div className="border border-accent bg-accent-dim rounded-md px-3 py-2 flex flex-wrap items-center gap-3">
              <span className="text-sm text-text">
                Link intent: {intent === "engage" ? "engage" : intent} — nothing
                has been recorded yet.
              </span>
              <button
                onClick={confirmIntent}
                disabled={busy}
                className={primaryBtnCls}
              >
                {intent === "done"
                  ? "Confirm done"
                  : intent === "archive"
                    ? "Confirm archive"
                    : "Confirm engaged"}
              </button>
              <button
                onClick={onIntentCleared}
                className="text-xs text-text-faint hover:text-text-muted"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* All fields, descriptively */}
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <Fact label="readiness tier">{todo.readiness}</Fact>
            <Fact label="status">{todo.status}</Fact>
            <Fact label="timing class">{todo.timingClass}</Fact>
            <Fact label="source">
              {todo.source}
              {todo.provenance ? ` (${todo.provenance})` : ""}
            </Fact>
            <Fact label="captured">
              {ageText(todo.createdAt, now)} · {fmtDate(todo.createdAt)}
            </Fact>
            <Fact label="last updated">{ageText(todo.updatedAt, now)}</Fact>
            {todo.dueAt !== undefined && (
              <Fact label="date">
                {countdownText(todo.dueAt, now)} · {fmtDate(todo.dueAt)}
                {todo.dateKind ? ` · ${todo.dateKind} date` : ""}
              </Fact>
            )}
            {todo.condition && <Fact label="condition">{todo.condition}</Fact>}
            {todo.latestSafeAt !== undefined && (
              <Fact label="latest safe">
                {countdownText(todo.latestSafeAt, now)} ·{" "}
                {fmtDate(todo.latestSafeAt)}
              </Fact>
            )}
            {todo.wakeCondition && (
              <Fact label="wake condition">{todo.wakeCondition}</Fact>
            )}
            {todo.wakeAt !== undefined && (
              <Fact label="wake at">
                {countdownText(todo.wakeAt, now)} · {fmtDate(todo.wakeAt)}
              </Fact>
            )}
            {todo.unarchiveCondition && (
              <Fact label="propose back when">{todo.unarchiveCondition}</Fact>
            )}
            {todo.doneAt !== undefined && (
              <Fact label="done at">{fmtDate(todo.doneAt)}</Fact>
            )}
            {todo.archivedAt !== undefined && (
              <Fact label="archived at">{fmtDate(todo.archivedAt)}</Fact>
            )}
          </div>

          {todo.brief && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">brief</div>
              <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
                {todo.brief}
              </div>
            </div>
          )}

          {/* Inline edits */}
          <div className="grid sm:grid-cols-2 gap-3">
            <FieldEditor
              label="statement"
              value={todo.statement}
              onSave={(v) => updateTodo({ id: todo._id, statement: v })}
            />
            <FieldEditor
              label="entry action"
              value={todo.entryAction}
              onSave={(v) => updateTodo({ id: todo._id, entryAction: v })}
            />
            <FieldEditor
              label="body"
              value={todo.body}
              multiline
              onSave={(v) => updateTodo({ id: todo._id, body: v })}
            />
            <FieldEditor
              label="work description"
              value={todo.workDescription}
              multiline
              onSave={(v) => updateTodo({ id: todo._id, workDescription: v })}
            />
          </div>

          {/* Date controls */}
          <div className="space-y-2">
            <div className="text-xs text-text-faint">date controls</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={dateDraft}
                onChange={(e) => setDateDraft(e.target.value)}
                className={inputCls}
              />
              {todo.dueAt === undefined ? (
                <button
                  onClick={() => {
                    const dueAt = parseDateInput(dateDraft);
                    if (dueAt === undefined) {
                      setError("Pick a date first.");
                      return;
                    }
                    void run(() => updateTodo({ id: todo._id, dueAt }));
                  }}
                  disabled={busy}
                  className={btnCls}
                >
                  Set date
                </button>
              ) : (
                <>
                  <button onClick={renegotiate} disabled={busy} className={btnCls}>
                    Renegotiate to picked date
                  </button>
                  <button
                    onClick={recordMissed}
                    disabled={busy}
                    className={btnCls}
                  >
                    Record missed
                    {dateDraft ? " (new date from picker)" : " (drops to whenever)"}
                  </button>
                  <select
                    value={todo.dateKind ?? "self-imposed"}
                    onChange={(e) =>
                      void run(() =>
                        updateTodo({
                          id: todo._id,
                          dateKind: e.target.value as "external" | "self-imposed",
                        }),
                      )
                    }
                    className={inputCls}
                  >
                    <option value="external">external date</option>
                    <option value="self-imposed">self-imposed date</option>
                  </select>
                </>
              )}
            </div>
            {todo.timingClass === "condition-bound" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-faint">latest safe:</span>
                <input
                  type="date"
                  value={latestSafeDraft}
                  onChange={(e) => setLatestSafeDraft(e.target.value)}
                  className={inputCls}
                />
                <button
                  onClick={() => {
                    const latestSafeAt = parseDateInput(latestSafeDraft);
                    if (latestSafeAt === undefined) {
                      setError("Pick a latest-safe date first.");
                      return;
                    }
                    void run(() => updateTodo({ id: todo._id, latestSafeAt }));
                  }}
                  disabled={busy}
                  className={btnCls}
                >
                  Set latest safe
                </button>
                {todo.latestSafeAt !== undefined && (
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
                )}
              </div>
            )}
          </div>

          {/* Status transitions */}
          <div className="space-y-2">
            <div className="text-xs text-text-faint">status</div>
            <div className="flex flex-wrap items-center gap-2">
              {todo.status !== "done" && (
                <button
                  onClick={() =>
                    void run(() => setStatus({ id: todo._id, status: "done" }))
                  }
                  disabled={busy}
                  className={btnCls}
                >
                  Mark done
                </button>
              )}
              {todo.status !== "active" && (
                <button
                  onClick={() =>
                    void run(() => setStatus({ id: todo._id, status: "active" }))
                  }
                  disabled={busy}
                  className={btnCls}
                >
                  Set active
                </button>
              )}
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
            {todo.status !== "archived" && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={unarchiveDraft}
                  onChange={(e) => setUnarchiveDraft(e.target.value)}
                  placeholder="propose back when… (optional)"
                  className={`${inputCls} w-64`}
                />
                <button
                  onClick={() =>
                    void run(() =>
                      setStatus({
                        id: todo._id,
                        status: "archived",
                        unarchiveCondition: unarchiveDraft.trim() || undefined,
                      }),
                    )
                  }
                  disabled={busy}
                  className={btnCls}
                >
                  Archive
                </button>
              </div>
            )}
            {todo.status !== "waiting" && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={wakeConditionDraft}
                  onChange={(e) => setWakeConditionDraft(e.target.value)}
                  placeholder="wake condition… (optional)"
                  className={`${inputCls} w-64`}
                />
                <input
                  type="date"
                  value={wakeAtDraft}
                  onChange={(e) => setWakeAtDraft(e.target.value)}
                  className={inputCls}
                />
                <button
                  onClick={() =>
                    void run(() =>
                      setStatus({
                        id: todo._id,
                        status: "waiting",
                        wakeCondition: wakeConditionDraft.trim() || undefined,
                        wakeAt: parseDateInput(wakeAtDraft),
                      }),
                    )
                  }
                  disabled={busy}
                  className={btnCls}
                >
                  Set waiting
                </button>
              </div>
            )}
          </div>

          {/* Date-outcome history */}
          {todo.dateOutcomes && todo.dateOutcomes.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">date history</div>
              {todo.dateOutcomes.map((o, i) => {
                const next = todo.dateOutcomes![i + 1];
                const target =
                  o.outcome === "renegotiated"
                    ? (next ? next.dueAt : todo.dueAt)
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

          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
