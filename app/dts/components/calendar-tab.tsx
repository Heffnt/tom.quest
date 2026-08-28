"use client";

// DTS Calendar tab — horizontal week view (Monday-start, 7 columns). Each day
// stacks, in time order: committed blocks (dtsBlocks), due marks (dueAt),
// wake marks (waiting todos' wakeAt), and — on today only — the day's queue
// from getToday. Blocks are calendar strokes: create / move / delete freely;
// a category block can open a block session over its todos.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { buildBlockSessionPrompt } from "@/app/lib/dts-session-prompt";

type Todo = Doc<"dtsTodos">;
type Block = Doc<"dtsBlocks">;

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
const capCls = "text-[10px] font-mono text-text-faint";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

/** epoch ms → <input type="datetime-local"> value in LOCAL time. */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "HH:mm" on a given local day-start → epoch ms (local). */
function timeOnDay(dayStart: number, time: string): number | null {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

// ── One placed block chip: collapsed = time + target; expanded = note,
// move (datetime-local), delete, and (category blocks) open-session ─────────
function BlockChip({
  block,
  label,
  onOpenSession,
  sessionBusy,
  sessionError,
}: {
  block: Block;
  label: string;
  onOpenSession: () => void;
  sessionBusy: boolean;
  sessionError: string | null;
}) {
  const updateBlock = useMutation(api.dts.updateBlock);
  const deleteBlock = useMutation(api.dts.deleteBlock);
  const isCategory = block.category !== undefined;
  const [open, setOpen] = useState(false);
  const [startDraft, setStartDraft] = useState(toDatetimeLocal(block.start));
  const [endDraft, setEndDraft] = useState(toDatetimeLocal(block.end));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartDraft(toDatetimeLocal(block.start));
    setEndDraft(toDatetimeLocal(block.end));
  }, [block.start, block.end]);

  const dirty =
    startDraft !== toDatetimeLocal(block.start) ||
    endDraft !== toDatetimeLocal(block.end);

  const move = async () => {
    const start = new Date(startDraft).getTime();
    const end = new Date(endDraft).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateBlock({ id: block._id, start, end });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
          <input
            type="datetime-local"
            value={startDraft}
            onChange={(e) => setStartDraft(e.target.value)}
            className={`${inputCls} w-full text-xs`}
          />
          <input
            type="datetime-local"
            value={endDraft}
            onChange={(e) => setEndDraft(e.target.value)}
            className={`${inputCls} w-full text-xs`}
          />
          {dirty && (
            <div>
              <button onClick={move} disabled={busy} className={btnCls}>
                Move
              </button>
              <div className={capCls}>{"dts.updateBlock({start,end})"}</div>
            </div>
          )}
          <div>
            <button onClick={remove} disabled={busy} className={btnCls}>
              Delete
            </button>
            <div className={capCls}>{"dts.deleteBlock({id})"}</div>
          </div>
          {isCategory && (
            <div>
              <button
                onClick={onOpenSession}
                disabled={sessionBusy}
                className={btnCls}
              >
                {sessionBusy ? "Opening…" : "Open block session"}
              </button>
              <div className={capCls}>
                {'claudeSessions.createSession({kind:"block"})'}
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

// ── Inline per-day create form: start/end time, target = one todo OR one
// category (datalist of existing categories + "code") ───────────────────────
function AddBlockForm({
  dayStart,
  activeTodos,
  categories,
  onClose,
}: {
  dayStart: number;
  activeTodos: Todo[];
  categories: string[];
  onClose: () => void;
}) {
  const createBlock = useMutation(api.dts.createBlock);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [endTouched, setEndTouched] = useState(false);
  const [mode, setMode] = useState<"todo" | "category">("todo");
  const [filter, setFilter] = useState("");
  const [todoId, setTodoId] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // End follows start at +1h until end is touched by hand.
  const onStartChange = (v: string) => {
    setStartTime(v);
    if (endTouched) return;
    const [h, m] = v.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return;
    setEndTime(
      `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    );
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return activeTodos;
    return activeTodos.filter((t) => t.statement.toLowerCase().includes(q));
  }, [activeTodos, filter]);

  const ready =
    mode === "todo" ? todoId !== "" : category.trim() !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = timeOnDay(dayStart, startTime);
    const end = timeOnDay(dayStart, endTime);
    if (start === null || end === null || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBlock({
        start,
        end,
        ...(mode === "todo"
          ? { todoId: todoId as Id<"dtsTodos"> }
          : { category: category.trim() }),
      });
      onClose();
    } catch (e2) {
      setError(errMessage(e2));
      setBusy(false);
    }
  };

  const listId = `dts-cats-${dayStart}`;

  return (
    <form
      onSubmit={submit}
      className="rounded border border-accent/40 bg-surface p-1.5 space-y-1.5"
    >
      <div className="flex items-center gap-1">
        <input
          type="time"
          value={startTime}
          onChange={(e) => onStartChange(e.target.value)}
          className={`${inputCls} text-xs px-1 w-full`}
        />
        <span className="text-text-faint text-xs">–</span>
        <input
          type="time"
          value={endTime}
          onChange={(e) => {
            setEndTouched(true);
            setEndTime(e.target.value);
          }}
          className={`${inputCls} text-xs px-1 w-full`}
        />
      </div>
      <div className="flex gap-1">
        {(["todo", "category"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`${btnCls} ${
              mode === m ? "text-accent border-accent/60" : ""
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "todo" ? (
        <div className="space-y-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className={`${inputCls} w-full text-xs`}
          />
          <select
            value={todoId}
            onChange={(e) => setTodoId(e.target.value)}
            className={`${inputCls} w-full text-xs`}
          >
            <option value="">— todo —</option>
            {filtered.map((t) => (
              <option key={t._id} value={t._id}>
                {t.statement.length > 60
                  ? `${t.statement.slice(0, 60)}…`
                  : t.statement}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="category"
            list={listId}
            className={`${inputCls} w-full text-xs`}
          />
          <datalist id={listId}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      )}
      <div>
        <button type="submit" disabled={!ready || busy} className={btnCls}>
          Add
        </button>
        <div className={capCls}>
          {mode === "todo"
            ? "dts.createBlock({start,end,todoId})"
            : "dts.createBlock({start,end,category})"}
        </div>
      </div>
      {error && <div className="text-xs text-error">{error}</div>}
    </form>
  );
}

// ── The tab ─────────────────────────────────────────────────────────────────
export default function CalendarTab() {
  const { isTom } = useAuth();
  const router = useRouter();
  const todos = useQuery(api.dts.listTodos, isTom ? {} : "skip");
  const blocks = useQuery(api.dts.listBlocks, isTom ? {} : "skip");
  const today = useQuery(api.dts.getToday, isTom ? {} : "skip");
  const createSession = useMutation(api.claudeSessions.createSession);

  const now = Date.now();
  const [weekStart, setWeekStart] = useState(() => mondayStartMs(Date.now()));
  const [addDay, setAddDay] = useState<number | null>(null); // dayStart ms
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
  const categories = useMemo(() => {
    const set = new Set<string>(["code"]);
    for (const t of todos ?? []) if (t.category) set.add(t.category);
    return [...set].sort();
  }, [todos]);

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => ({
        start: shiftDays(weekStart, i),
        end: shiftDays(weekStart, i + 1),
      })),
    [weekStart],
  );

  // Same navigation/error idiom as use-open-todo-session: create, then push;
  // failures land in state and render under the button that fired them.
  const openBlockSession = async (block: Block) => {
    const category = block.category;
    if (category === undefined || sessionBusyId !== null) return;
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
      router.push(`/sessions?session=${id}`);
    } catch (e) {
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
                      setAddDay((d) => (d === day.start ? null : day.start))
                    }
                    className="text-xs text-text-faint hover:text-text px-1"
                    title="add block"
                  >
                    +
                  </button>
                </div>

                {addDay === day.start && (
                  <AddBlockForm
                    dayStart={day.start}
                    activeTodos={activeTodos}
                    categories={categories}
                    onClose={() => setAddDay(null)}
                  />
                )}

                {dayBlocks.map((b) => (
                  <BlockChip
                    key={b._id}
                    block={b}
                    label={blockLabel(b)}
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
                      <div
                        key={`q-${t._id}`}
                        className="px-1 text-[11px] flex items-baseline gap-1"
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
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
