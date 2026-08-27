"use client";

// DTS Focus — the one-task-at-a-time surface. Serves the daily queue
// (prepared ~5 a.m. by the worker or the fallback cron) as a wrap-around
// ring Tom cycles through until something is worth beginning. All copy is
// descriptive, never evaluative; every ask is entry-shaped.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { countdownText } from "@/convex/dtsShared";
import { ageText, fmtDate } from "../inventory/lib";

type Todo = Doc<"dtsTodos">;
type QueueTodo = Todo & { queueReason?: string };

const BRIEF_COLLAPSE_CHARS = 400;

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function positionStorageKey(day: string): string {
  return `dts-focus-position:${day}`;
}

export default function FocusClient() {
  const { loading, isTom } = useAuth();
  const today = useQuery(api.dts.getToday, isTom ? {} : "skip");
  // The full-inventory subscription exists only for the pull-from-inventory
  // panel, which starts closed — so it stays "skip" until the panel opens
  // (review finding: the table grows forever; Focus renders one card).
  const [pullOpen, setPullOpen] = useState(false);
  const allTodos = useQuery(api.dts.listTodos, isTom && pullOpen ? {} : "skip");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!isTom) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          Focus access is restricted to Tom.
        </div>
      </div>
    );
  }

  if (today === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  return (
    <FocusBoard
      day={today.day}
      queue={today.queue}
      allTodos={allTodos}
      pullOpen={pullOpen}
      setPullOpen={setPullOpen}
    />
  );
}

function FocusBoard({
  day,
  queue,
  allTodos,
  pullOpen,
  setPullOpen,
}: {
  day: string;
  queue: {
    preparedAt: number;
    preparedBy: string;
    digestSentAt?: number;
    todos: QueueTodo[];
  } | null;
  allTodos: Todo[] | undefined;
  pullOpen: boolean;
  setPullOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const recordEvent = useMutation(api.dts.recordEvent);
  const setStatus = useMutation(api.dts.setStatus);

  const [now] = useState(() => Date.now());
  const [position, setPosition] = useState(() => {
    try {
      const raw = window.localStorage.getItem(positionStorageKey(day));
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  });
  const [pulled, setPulled] = useState<Todo | null>(null);
  const [engagedIds, setEngagedIds] = useState<Set<string>>(() => new Set());
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneNote, setDoneNote] = useState("");
  const [doneError, setDoneError] = useState<string | null>(null);
  const [briefOpenIds, setBriefOpenIds] = useState<Set<string>>(() => new Set());

  // Fire-and-forget instrumentation — never blocks the UI.
  const fire = (kind: string, todoId?: Id<"dtsTodos">, data?: unknown) => {
    void recordEvent({ kind, todoId, data }).catch(() => {});
  };

  // queue-served: once per mount, once a queue exists.
  const servedRef = useRef(false);
  const queueCount = queue?.todos.length;
  useEffect(() => {
    if (servedRef.current || queueCount === undefined) return;
    servedRef.current = true;
    fire("queue-served", undefined, { day, count: queueCount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueCount, day]);

  // Persist the ring position per day so a reload lands on the same card.
  useEffect(() => {
    try {
      window.localStorage.setItem(positionStorageKey(day), String(position));
    } catch {
      // storage unavailable — position just resets on reload
    }
  }, [position, day]);

  const todos = queue?.todos ?? [];
  const idx =
    todos.length > 0 ? ((position % todos.length) + todos.length) % todos.length : 0;
  const queueCurrent: QueueTodo | null = todos.length > 0 ? todos[idx] : null;
  const current: QueueTodo | Todo | null = pulled ?? queueCurrent;
  const currentId = current?._id ?? null;

  // Reset the done affordance when the card changes.
  useEffect(() => {
    setDoneOpen(false);
    setDoneNote("");
    setDoneError(null);
  }, [currentId]);

  const advance = () => {
    setPulled(null);
    if (todos.length > 0) setPosition((idx + 1) % todos.length);
  };

  const onNext = () => {
    if (current) fire("queue-cycled", current._id, { day, position: idx });
    advance();
  };

  const onBegin = () => {
    if (!current) return;
    fire("engaged", current._id, { via: "focus", day });
    setEngagedIds((prev) => new Set(prev).add(current._id));
  };

  const onConfirmDone = async () => {
    if (!current) return;
    setDoneError(null);
    try {
      await setStatus({
        id: current._id,
        status: "done",
        note: doneNote.trim() === "" ? undefined : doneNote.trim(),
      });
      fire("completed-from-focus", current._id, { day });
      setDoneOpen(false);
      setDoneNote("");
      advance();
    } catch {
      setDoneError("The status change did not save. It can be retried.");
    }
  };

  const onPull = (todo: Todo) => {
    fire("pulled-from-inventory", todo._id, { day });
    setPulled(todo);
    setPullOpen(false);
  };

  const engaged = current !== null && engagedIds.has(current._id);
  const queueReason =
    current !== null && "queueReason" in current ? current.queueReason : undefined;
  const briefOpen = current !== null && briefOpenIds.has(current._id);
  const briefIsLong =
    current?.brief !== undefined && current.brief.length > BRIEF_COLLAPSE_CHARS;

  const activeInventory = (allTodos ?? [])
    .filter((t) => t.status === "active")
    .sort((a, b) => a.updatedAt - b.updatedAt);

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Focus</h1>
        <p className="text-text-faint text-xs">
          {queue
            ? `Queue for ${day} — prepared by ${queue.preparedBy} at ${timeOfDay(queue.preparedAt)}` +
              (queue.digestSentAt ? `, digest sent ${timeOfDay(queue.digestSentAt)}` : "")
            : `No queue prepared for ${day} yet`}
        </p>
      </header>

      {current ? (
        <div
          className={`border rounded-lg bg-surface p-6 space-y-5 ${
            engaged ? "border-accent" : "border-border"
          }`}
        >
          {/* Position + reason line — facts about where this card sits. */}
          <div className="flex items-center gap-3 text-xs text-text-faint">
            <span>
              {pulled
                ? "pulled from inventory"
                : todos.length > 0
                  ? `${idx + 1} of ${todos.length} today`
                  : ""}
            </span>
            {queueReason && (
              <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">
                {queueReason}
              </span>
            )}
          </div>

          <h2 className="text-xl font-semibold leading-snug">{current.statement}</h2>

          {current.dueAt !== undefined && (
            <p className="text-sm text-text-muted">
              {countdownText(current.dueAt, now)}
              <span className="text-text-faint"> — {fmtDate(current.dueAt)}</span>
            </p>
          )}

          {current.workDescription && (
            <p className="text-sm text-text-muted">{current.workDescription}</p>
          )}

          {current.brief !== undefined &&
            (briefIsLong && !briefOpen ? (
              <button
                type="button"
                onClick={() =>
                  setBriefOpenIds((prev) => new Set(prev).add(current._id))
                }
                className="text-xs text-accent hover:underline"
              >
                Show brief
              </button>
            ) : (
              <div className="space-y-1">
                {briefIsLong && (
                  <button
                    type="button"
                    onClick={() =>
                      setBriefOpenIds((prev) => {
                        const next = new Set(prev);
                        next.delete(current._id);
                        return next;
                      })
                    }
                    className="text-xs text-accent hover:underline"
                  >
                    Hide brief
                  </button>
                )}
                <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text-muted bg-surface-alt/50 border border-border rounded p-3 overflow-x-auto">
                  {current.brief}
                </pre>
              </div>
            ))}

          {/* Actions — the primary ask is always entry-shaped. */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onBegin}
              className={`rounded px-4 py-2 text-sm font-medium border ${
                engaged
                  ? "border-accent text-accent bg-surface-alt"
                  : "border-accent text-accent hover:bg-surface-alt"
              }`}
            >
              {current.entryAction ?? "Begin"}
            </button>
            <button
              type="button"
              onClick={onNext}
              className="rounded px-4 py-2 text-sm border border-border text-text-muted hover:bg-surface-alt"
            >
              Next
            </button>
            <button
              type="button"
              onClick={() => setDoneOpen((v) => !v)}
              className="rounded px-4 py-2 text-sm border border-border text-text-muted hover:bg-surface-alt"
            >
              Done
            </button>
            <Link
              href={`/inventory?item=${current._id}`}
              className="text-xs text-text-faint hover:text-text-muted"
            >
              Open in Inventory
            </Link>
          </div>

          {engaged && !doneOpen && (
            <p className="text-xs text-text-faint">
              Begun.{" "}
              <button
                type="button"
                onClick={() => setDoneOpen(true)}
                className="text-accent hover:underline"
              >
                Done with this?
              </button>
            </p>
          )}

          {doneOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={doneNote}
                onChange={(e) => setDoneNote(e.target.value)}
                placeholder="Optional note"
                className="flex-1 min-w-48 bg-surface-alt border border-border rounded px-3 py-1.5 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void onConfirmDone()}
                className="rounded px-3 py-1.5 text-sm border border-accent text-accent hover:bg-surface-alt"
              >
                Mark done
              </button>
              <button
                type="button"
                onClick={() => {
                  setDoneOpen(false);
                  setDoneNote("");
                  setDoneError(null);
                }}
                className="text-xs text-text-faint hover:text-text-muted"
              >
                Cancel
              </button>
              {doneError && <p className="w-full text-xs text-text-muted">{doneError}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-lg bg-surface p-6 text-sm text-text-muted">
          {queue === null
            ? `No queue prepared for ${day} yet. The fallback prepares one in the 4 a.m. hour; the digest sends at 5.`
            : `The queue for ${day} has no items.`}
        </div>
      )}

      {/* Pull from Inventory — always available so the page is never a dead end.
          Selecting swaps the item into the card slot client-side only. */}
      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setPullOpen((v) => !v)}
          className="text-xs text-text-faint hover:text-text-muted"
        >
          {pullOpen ? "Hide inventory" : "Pull from Inventory"}
        </button>
        {pullOpen &&
          (allTodos === undefined ? (
            <p className="text-xs text-text-faint">Loading inventory…</p>
          ) : activeInventory.length === 0 ? (
            <p className="text-xs text-text-faint">No active todos in the inventory.</p>
          ) : (
            <ul className="border border-border rounded-lg bg-surface/40 divide-y divide-border">
              {activeInventory.map((todo) => (
                <li key={todo._id}>
                  <button
                    type="button"
                    onClick={() => onPull(todo)}
                    className="w-full text-left px-4 py-2.5 hover:bg-surface-alt flex items-baseline justify-between gap-4"
                  >
                    <span className="text-sm">{todo.statement}</span>
                    <span className="text-xs text-text-faint whitespace-nowrap">
                      updated {ageText(todo.updatedAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
