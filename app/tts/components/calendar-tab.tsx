"use client";

// TTS Calendar tab — horizontal week view (Monday-start, 7 columns). Each day
// stacks, in time order: committed blocks (dtsBlocks), due marks (dueAt),
// wake marks (waiting todos' wakeAt), and — on today only — the day's queue
// from getToday. A category block can open a block session over its todos.
//
// Blocks are created and moved by TIME NOTE, not by picker: the day's `+`
// opens a note for that day ("sat 9–11 deep work"), a block's own note moves
// it ("push this an hour"), and an agent applies them. Delete stays a
// one-click button — it is an exact effect, not a time to parse.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { buildBlockSessionPrompt } from "@/app/lib/tts-session-prompt";
import { reserveSessionTab } from "@/app/lib/use-open-todo-session";
import Info from "./info";
import RepeatsStrip from "./repeats-strip";
import TimeNoteField, {
  groupTimeNotes,
  NO_NOTES,
  type TimeNote,
} from "./time-note-field";
import { errMessage, isoDate } from "../lib";

type Block = Doc<"dtsBlocks">;

const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
const capCls = "text-[10px] font-mono text-text-faint";

// ── Local-time week math ─────────────────────────────────────────────────────
// All day boundaries via new Date(y, m, d) so DST transitions cannot shift a
// column; ms arithmetic on day lengths is deliberately avoided.

/** Monday 00:00 local of the week containing ms. */
function mondayStartMs(ms: number): number {
  const d = new Date(ms);
  const back = (d.getDay() + 6) % 7; // Sun=0 → back 6, Mon=1 → back 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

/** Same local wall-clock midnight, n days later. */
function shiftDays(ms: number, n: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** "9a", "2:30p" — dense time-of-day for chips. */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const ap = d.getHours() < 12 ? "a" : "p";
  return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`;
}

/** "Sep 1" */
function monthDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** "Mon 1" */
function dayHeading(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}

// ── One placed block chip: collapsed = time + target; expanded = note, a
// time note (moves it), delete, and (category blocks) open-session ──────────
function BlockChip({
  block,
  label,
  notes,
  onOpenSession,
  sessionBusy,
  sessionError,
}: {
  block: Block;
  label: string;
  /** This block's time notes (the tab holds the query). */
  notes: readonly TimeNote[];
  onOpenSession: () => void;
  sessionBusy: boolean;
  sessionError: string | null;
}) {
  const deleteBlock = useMutation(api.tts.deleteBlock);
  const isCategory = block.category !== undefined;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBlock({ id: block._id });
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded border ${
        isCategory ? "border-accent/40" : "border-border"
      } bg-surface`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-1.5 py-1"
        title={`${fmtTime(block.start)}–${fmtTime(block.end)} ${label}`}
      >
        <span className={capCls}>
          {fmtTime(block.start)}–{fmtTime(block.end)}
        </span>
        <span
          className={`block truncate text-[11px] ${
            isCategory ? "text-accent" : "text-text"
          }`}
        >
          {label}
        </span>
      </button>
      {open && (
        <div className="px-1.5 pb-1.5 pt-1 space-y-1.5 border-t border-border">
          {block.note && (
            <div className="text-[11px] text-text-muted">{block.note}</div>
          )}
          <TimeNoteField blockId={block._id} notes={notes} />
          <div className="flex items-center gap-1">
            <button onClick={remove} disabled={busy} className={btnCls}>
              Delete
            </button>
            <Info label="tts.deleteBlock({id})" />
          </div>
          {isCategory && (
            <div>
              <div className="flex items-center gap-1">
                <button
                  onClick={onOpenSession}
                  disabled={sessionBusy}
                  className={btnCls}
                >
                  {sessionBusy ? "Opening…" : "Open block session"}
                </button>
                <Info label='claudeSessions.createSession({kind:"block"})' />
              </div>
              {sessionError && (
                <div className="text-xs text-error">{sessionError}</div>
              )}
            </div>
          )}
          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

// ── The tab ─────────────────────────────────────────────────────────────────
export default function CalendarTab({
  onOpenItem,
}: {
  /** Queue-chip click-through: the shell jumps to the item on the everything tab. */
  onOpenItem?: (todoId: string) => void;
}) {
  const { isTom } = useAuth();
  const now = Date.now();
  const [weekStart, setWeekStart] = useState(() => mondayStartMs(Date.now()));
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  // Only the visible week's blocks ride the subscription (dtsBlocks grows
  // forever; the by_start index serves the range).
  const blocks = useQuery(
    api.tts.listBlocks,
    isTom ? { start: weekStart, end: shiftDays(weekStart, 7) } : "skip",
  );
  const today = useQuery(api.tts.getToday, isTom ? {} : "skip");
  // External-calendar mirror rows (Google/Outlook/Canvas ICS feeds) for the
  // visible week — read-only schedule knowledge next to the blocks.
  const calendarEvents = useQuery(
    api.ttsCalendar.listCalendarEvents,
    isTom ? { start: weekStart, end: shiftDays(weekStart, 7) } : "skip",
  );
  // ONE time-note subscription for the whole tab; days and blocks slice it.
  const timeNotes = useQuery(api.tts.listTimeNotes, isTom ? {} : "skip");
  const createSession = useMutation(api.claudeSessions.createSession);
  const recordEvent = useMutation(api.tts.recordEvent);
  const [addDay, setAddDay] = useState<string | null>(null); // "YYYY-MM-DD"
  const [sessionBusyId, setSessionBusyId] = useState<Id<"dtsBlocks"> | null>(
    null,
  );
  const [sessionError, setSessionError] = useState<{
    blockId: Id<"dtsBlocks">;
    message: string;
  } | null>(null);

  const todosById = useMemo(
    () => new Map((todos ?? []).map((t) => [t._id as string, t])),
    [todos],
  );
  const activeTodos = useMemo(
    () =>
      (todos ?? [])
        .filter((t) => t.status === "active")
        .sort((a, b) => a.statement.localeCompare(b.statement)),
    [todos],
  );
  // `key` is the column's calendar-day label from its own local date parts
  // (isoDate) — that string IS the day a note is filed against, so the note
  // never carries an instant that a timezone could re-date.
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const start = shiftDays(weekStart, i);
        return { start, end: shiftDays(weekStart, i + 1), key: isoDate(start) };
      }),
    [weekStart],
  );

  // ONE bucketing pass over the subscription; days and blocks index into it.
  const notesByContext = useMemo(
    () => groupTimeNotes(timeNotes ?? []),
    [timeNotes],
  );

  // Same idiom as use-open-todo-session: reserve the tab inside the click (no
  // await before window.open), create, then point the tab at the session;
  // failures close it again and land in state under the button that fired it.
  const openBlockSession = async (block: Block) => {
    const category = block.category;
    if (category === undefined || sessionBusyId !== null) return;
    const tab = reserveSessionTab();
    setSessionBusyId(block._id);
    setSessionError(null);
    try {
      const matching = activeTodos.filter((t) => t.category === category);
      const id = await createSession({
        title: `Block: ${category}`,
        kind: "block",
        repo: "none",
        blockCategory: category,
        initialPrompt: buildBlockSessionPrompt(category, matching),
      });
      tab.goto(id);
    } catch (e) {
      tab.close();
      setSessionError({ blockId: block._id, message: errMessage(e) });
    } finally {
      setSessionBusyId(null);
    }
  };

  if (todos === undefined || blocks === undefined) {
    return (
      <div className="py-12 text-center text-sm text-text-faint">
        Loading calendar…
      </div>
    );
  }

  const blockLabel = (b: Block): string =>
    b.todoId !== undefined
      ? (todosById.get(b.todoId as string)?.statement ?? "(todo gone)")
      : (b.category ?? "");

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <button
          className={btnCls}
          onClick={() => setWeekStart((w) => shiftDays(w, -7))}
        >
          ‹
        </button>
        <button
          className={btnCls}
          onClick={() => setWeekStart(mondayStartMs(Date.now()))}
        >
          today
        </button>
        <button
          className={btnCls}
          onClick={() => setWeekStart((w) => shiftDays(w, 7))}
        >
          ›
        </button>
        <span className="text-sm text-text-muted">
          {monthDay(days[0].start)} – {monthDay(days[6].start)}
        </span>
      </div>

      <div className="overflow-x-auto mt-3 pb-2">
        <div className="grid grid-cols-7 gap-1.5 min-w-[980px]">
          {days.map((day) => {
            const isToday = now >= day.start && now < day.end;
            const dayBlocks = blocks
              .filter((b) => b.start < day.end && b.end > day.start)
              .sort((a, b) => a.start - b.start);
            const dayEvents = (calendarEvents ?? [])
              .filter((e) => e.start < day.end && e.end > day.start)
              .sort((a, b) =>
                a.allDay === b.allDay
                  ? a.start - b.start
                  : a.allDay
                    ? -1
                    : 1,
              );
            const dueMarks = (todos ?? [])
              .filter(
                (t) =>
                  t.dueAt !== undefined &&
                  t.dueAt >= day.start &&
                  t.dueAt < day.end,
              )
              .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
            const wakeMarks = (todos ?? [])
              .filter(
                (t) =>
                  t.status === "waiting" &&
                  t.wakeAt !== undefined &&
                  t.wakeAt >= day.start &&
                  t.wakeAt < day.end,
              )
              .sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0));
            const queue = isToday ? (today?.queue?.todos ?? []) : [];
            const dayNotes = notesByContext.get(day.key) ?? NO_NOTES;

            return (
              <div
                key={day.start}
                className={`rounded-md border ${
                  isToday ? "border-accent/60" : "border-border"
                } bg-surface/40 p-1.5 space-y-1 min-h-44`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs ${
                      isToday ? "text-accent" : "text-text-muted"
                    }`}
                  >
                    {dayHeading(day.start)}
                  </span>
                  <button
                    onClick={() =>
                      setAddDay((d) => (d === day.key ? null : day.key))
                    }
                    className="text-xs text-text-faint hover:text-text px-1"
                    title="time note for this day"
                  >
                    +
                  </button>
                </div>

                {/* The day's time notes always show; `+` opens the input. */}
                {(addDay === day.key || dayNotes.length > 0) && (
                  <TimeNoteField
                    day={day.key}
                    notes={dayNotes}
                    showInput={addDay === day.key}
                  />
                )}

                {dayEvents.map((e) => (
                  <div
                    key={e._id}
                    className="px-1.5 py-0.5 rounded border border-dashed border-border text-[11px] truncate"
                    title={`${e.feed}: ${e.title}${e.location ? ` @ ${e.location}` : ""}`}
                  >
                    <span className={capCls}>
                      {e.allDay
                        ? "all day"
                        : `${fmtTime(e.start)}–${fmtTime(e.end)}`}
                    </span>{" "}
                    <span className="text-text-muted">{e.title}</span>
                  </div>
                ))}

                {dayBlocks.map((b) => (
                  <BlockChip
                    key={b._id}
                    block={b}
                    label={blockLabel(b)}
                    notes={notesByContext.get(b._id) ?? NO_NOTES}
                    onOpenSession={() => void openBlockSession(b)}
                    sessionBusy={sessionBusyId === b._id}
                    sessionError={
                      sessionError && sessionError.blockId === b._id
                        ? sessionError.message
                        : null
                    }
                  />
                ))}

                {dueMarks.map((t) => {
                  const past = (t.dueAt ?? 0) < now;
                  return (
                    <div
                      key={`due-${t._id}`}
                      className="px-1 text-[11px] truncate"
                      title={`due ${new Date(t.dueAt ?? 0).toLocaleString()} (${t.dateKind ?? "self-imposed"}) — ${t.statement}`}
                    >
                      <span
                        className={past ? "text-warning" : "text-text-faint"}
                      >
                        ◆
                      </span>{" "}
                      <span
                        className={past ? "text-warning" : "text-text-muted"}
                      >
                        {t.statement}
                      </span>{" "}
                      <span className="text-text-faint">{t.dateKind}</span>
                    </div>
                  );
                })}

                {wakeMarks.map((t) => (
                  <div
                    key={`wake-${t._id}`}
                    className="px-1 text-[11px] text-text-muted truncate"
                    title={`wakes ${new Date(t.wakeAt ?? 0).toLocaleString()}${t.wakeCondition ? ` — ${t.wakeCondition}` : ""} — ${t.statement}`}
                  >
                    <span className="text-text-faint">○ wakes</span>{" "}
                    {t.statement}
                  </div>
                ))}

                {queue.length > 0 && (
                  <div className="border-t border-border pt-1 mt-1 space-y-0.5">
                    {queue.map((t) => (
                      <button
                        key={`q-${t._id}`}
                        type="button"
                        onClick={() => {
                          void recordEvent({
                            kind: "engaged",
                            todoId: t._id,
                            data: { via: "calendar-queue" },
                          }).catch(() => {});
                          onOpenItem?.(t._id);
                        }}
                        className="w-full text-left px-1 text-[11px] flex items-baseline gap-1 rounded hover:bg-surface/60"
                        title={t.statement}
                      >
                        <span className="text-text truncate">
                          {t.statement}
                        </span>
                        {t.queueReason && (
                          <span className="text-[10px] text-text-faint border border-border rounded px-1 shrink-0">
                            {t.queueReason}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <RepeatsStrip />
    </div>
  );
}
