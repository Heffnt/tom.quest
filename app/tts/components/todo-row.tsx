"use client";

// One life-todo row: click-to-expand summary line + detail panel.
// Panel order: intent banner → session + options (verdicts, done/archive) →
// time note → brief → "edit" disclosure (field editors, full fact grid, date
// history). Actions sit at the top everywhere.
//
// Timing FACTS are displayed all over this row (countdown, dueAt, dateKind,
// latest safe, wake, date history); timing INPUT is one time note — the row
// has no date picker at all, and an agent reads the note (app/tts/components/
// time-note-field.tsx).
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
import {
  LINK_INTENT_EXPLANATION,
  READINESS_EXPLANATION,
  SESSIONS_EXPLANATION,
  STATUS_EXPLANATION,
  TODO_FIELDS_EXPLANATION,
} from "../explanations";
import OptionsRow from "./options-row";
import TimeNoteField, { type TimeNote } from "./time-note-field";
import {
  ageText,
  errMessage,
  fmtDate,
  isoDate,
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

/**
 * The ⓘ beside a control, naming the mutation it fires.
 *
 * `children` is the call; `explains` is the plain-language half the ratified
 * info rule requires. Every caller in app/tts now passes both halves plus an
 * `explanation`, so a caption rendering the bare call no longer exists — a new
 * caller with no `explains` is an oversight rather than acknowledged debt.
 *
 * `explanation` is the second register: one complete HTML document (see
 * ../explanations) shown fullscreen behind the popover's "more" control, for
 * a caption whose mechanism has to be taught rather than named. A caption
 * without one shows no "more".
 */
function Caption({
  children,
  explains,
  explanation,
  explanationTitle,
}: {
  children: string;
  explains?: React.ReactNode;
  explanation?: string;
  explanationTitle?: string;
}) {
  return (
    <Info
      call={children}
      explanation={explanation}
      explanationTitle={explanationTitle}
    >
      {explains}
    </Info>
  );
}

// ── Small inline field editor ───────────────────────────────────────────────
// All five fields this renders are the same mechanism — one updateTodo call
// writing one text field, with the same two invisible consequences (the row is
// stamped as Tom-touched, which freezes its grouping; its update time bumps,
// which can reopen a ruled item). So the ground-up document is fixed here and
// only `explains` differs per field.
function FieldEditor({
  label,
  caption,
  explains,
  value,
  multiline,
  onSave,
}: {
  label: string;
  caption: string;
  /** The plain half: what this one field is for. */
  explains: string;
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
        <Caption
          explains={explains}
          explanation={TODO_FIELDS_EXPLANATION}
          explanationTitle="the five text fields of a todo"
        >
          {caption}
        </Caption>
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
  timeNotes,
}: {
  todo: Todo;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  /** Deep-link intent aimed at THIS todo (?item=…&intent=…), else null. */
  intent: LinkIntent | null;
  onIntentCleared: () => void;
  /** This todo's time notes, bucketed by the tab that holds the query. */
  timeNotes: readonly TimeNote[];
}) {
  const updateTodo = useMutation(api.tts.updateTodo);
  const setStatus = useMutation(api.tts.setStatus);
  const recordEvent = useMutation(api.tts.recordEvent);
  const {
    open: openTodoSession,
    busy: sessionBusy,
    error: sessionError,
  } = useOpenTodoSession();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // Edit-disclosure draft (dates never come from this row — see the time note)
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
        <span className="text-base text-text">{todo.statement}</span>
        {todo.members !== undefined && (
          <span className={chipCls}>batch · {todo.members.length} members</span>
        )}
        <span className={chipCls}>{todo.readiness}</span>
        {todo.status !== "active" && (
          <span className={chipCls}>{todo.status}</span>
        )}
        {todo.category && <span className={chipCls}>{todo.category}</span>}
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
                <Caption
                  explains="Carries out what the link proposed. The link itself changed nothing — an address that is merely fetched must never change stored data, or a chat client generating a preview would mark this done for you."
                  explanation={LINK_INTENT_EXPLANATION}
                  explanationTitle="the intent bar — a link that proposes an action"
                >
                  {intentCaption}
                </Caption>
              </div>
              <button
                onClick={onIntentCleared}
                className="text-xs text-text-faint hover:text-text-muted"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* 2 — session + options (the one options surface: verdicts when
              this is a gate item, done/archive). A gate item is
              ruled from wherever it is seen, not only from the batches tab —
              batched members lose that strip. */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1">
                <button
                  // No tab is reserved here: open() reserves one itself,
                  // synchronously, still inside this click's gesture stack.
                  onClick={() => void openTodoSession(todo)}
                  disabled={busy || sessionBusy}
                  className={btnCls}
                >
                  Open session
                </button>
                <Caption
                  explains="Opens a Claude session on the Jarvis Box with this item, its brief and its plan already in the opening prompt. It checks out whatever repositories its batch declares, and can only push to its own branch — merging stays yours."
                  explanation={SESSIONS_EXPLANATION}
                  explanationTitle="opening a session — what is created and where it runs"
                >
                  {`claudeSessions.createSession({ kind: "${
                    todo.readiness === "ready-for-tom" ? "gate" : "focus-item"
                  }" })`}
                </Caption>
              </div>
              {sessionError && (
                <div className="text-xs text-error">{sessionError}</div>
              )}
            </div>
            <OptionsRow
              todo={todo}
              rulable={
                todo.status === "active" && todo.readiness === "ready-for-tom"
              }
              afterSession={(tab, ruling) =>
                void openTodoSession(todo, { tab, ruling })
              }
            />
          </div>

          {/* 3 — time note: the row's only timing INPUT. Due dates, latest
              safe, renegotiations and missed dates are all written by the
              agent that reads this note. */}
          <TimeNoteField todoId={todo._id} notes={timeNotes} />

          {/* 4 — brief */}
          {todo.brief && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">brief</div>
              <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
                {todo.brief}
              </div>
            </div>
          )}

          {/* 5 — edit disclosure */}
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
                  explains="The one line naming this todo, shown wherever it appears and read into the opening prompt of any session on it. The scan that guesses which repositories a session checks out reads this text too, so a repository named here is a repository the session gets."
                  value={todo.statement}
                  onSave={(v) => updateTodo({ id: todo._id, statement: v })}
                />
                <FieldEditor
                  label="entry action"
                  caption="tts.updateTodo({entryAction})"
                  explains="The smallest concrete next step, as one sentence — not a plan. It is printed verbatim in the opening prompt of a session that works a whole category, so it is read as an instruction rather than as a note."
                  value={todo.entryAction}
                  onSave={(v) => updateTodo({ id: todo._id, entryAction: v })}
                />
                <FieldEditor
                  label="body"
                  caption="tts.updateTodo({body})"
                  explains="Free text about the todo: whatever does not fit the one-line statement. Read alongside the statement by the scan that guesses repositories."
                  value={todo.body}
                  multiline
                  onSave={(v) => updateTodo({ id: todo._id, body: v })}
                />
                <FieldEditor
                  label="work description"
                  caption="tts.updateTodo({workDescription})"
                  explains="What the work involves, in words. Never a number of hours or a points estimate — that is a standing rule, not a convention."
                  value={todo.workDescription}
                  multiline
                  onSave={(v) =>
                    updateTodo({ id: todo._id, workDescription: v })
                  }
                />
                <FieldEditor
                  label="category"
                  caption="tts.updateTodo({category})"
                  explains="A free-text tag. It is what lets one span of calendar time cover a set of todos at once. The single reserved value is “code”, which removes the todo from the picker that starts sessions on its own."
                  value={todo.category}
                  onSave={(v) =>
                    updateTodo({ id: todo._id, category: v.trim() || null })
                  }
                />
                <div className="space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-text-faint">readiness</span>
                    <Caption
                      explains="Sets how far the preparing of this item has got, and nothing else. Dropping it to preparing hands it back to an agent, which re-writes the brief within a couple of minutes and returns it — the item, and what you have already decided about it, are untouched."
                      explanation={READINESS_EXPLANATION}
                      explanationTitle="readiness — the field this dropdown writes"
                    >
                      {"tts.updateTodo({ readiness })"}
                    </Caption>
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
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        void run(() =>
                          setStatus({
                            id: todo._id,
                            status: "waiting",
                            wakeCondition:
                              wakeConditionDraft.trim() || undefined,
                          }),
                        )
                      }
                      disabled={busy}
                      className={btnCls}
                    >
                      Set waiting
                    </button>
                    <Caption
                      explains="Parks it until the date or condition you gave. It leaves your active list, and the 4:45 a.m. run brings back anything whose stored wake TIME has arrived — a condition in words alone has nothing for that job to act on, so it waits for you."
                      explanation={STATUS_EXPLANATION}
                      explanationTitle="status — the four states a todo can be in"
                    >
                      {'tts.setStatus({ status: "waiting" })'}
                    </Caption>
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
                  <Caption
                    explains="Brings it back onto the active list now, before whatever it was waiting for. Five fields are cleared as part of reopening: the completion and archive times, the unarchive condition, and both halves of the wait."
                    explanation={STATUS_EXPLANATION}
                    explanationTitle="status — the four states a todo can be in"
                  >
                    {'tts.setStatus({ status: "active" })'}
                  </Caption>
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
