"use client";

// EVERYTHING tab — the default tab. On top, the todos awaiting Tom's ruling
// (app/jarvis/lib.ts selectNeedsMe, the rows the tab's badge counts), then the
// rulings recorded and not yet applied. Under them one
// unified filterable flat list of all life todos.
// Toolbar: text search, status chips, category select, sort select
// — counts on every chip. Rows carry their own state chips.
//
// The two sections on top were the batches tab's, under its batch cards;
// with batches gone (Tom, 2026-09-24) they moved here unchanged.
//
// TWO FILTERS ARE GONE (the lifeos update, phase 7). The ready-for-tom toggle
// filtered by readiness, which is no longer a thing to filter on: ready is
// computed (prepared, active, awake, every need done) and what a reader wants
// from a row that is not ready is the REASON, which every row now prints
// (ttsShared.waitingReason). And "waiting" is no longer a status of its own —
// a sleep is a wakeAt on an active row — so the four status chips are three,
// and a row still carrying the stored status reads as active here, exactly as
// the migration will rewrite it. Neither row is hidden by either change.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { useCoarseNow } from "@/app/lib/hooks/use-coarse-now";
import { useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import TodoRow from "./todo-row";
import OptionsRow from "./options-row";
import SectionHeader from "./section-header";
import {
  countdownText,
  waitingReason,
  type WaitingContext,
} from "@/convex/ttsShared";
import {
  ageText,
  buildDoneSet,
  fmtDate,
  rulingSubjectKey,
  selectNeedsMe,
  type Todo,
} from "../lib";
const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";

const STATUSES = ["active", "done", "archived"] as const;
type Status = (typeof STATUSES)[number];
type SortKey = "dueAt" | "createdAt" | "updatedAt";
type Row = { kind: "life"; key: string; todo: Todo };

const MAX = Number.MAX_SAFE_INTEGER;

const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";

// The expanded-row key of a row in the awaiting section. An awaiting todo is
// also in the list below; its own key keeps opening one from opening both.
const awaitingKey = (key: string) => `awaiting ${key}`;

function rowStatuses(r: Row): Status[] {
  return [r.todo.status === "waiting" ? "active" : r.todo.status];
}
function rowStatement(r: Row): string {
  return r.todo.statement;
}
function rowCategory(r: Row): string | undefined {
  return r.todo.category;
}
function rowCreatedAt(r: Row): number {
  return r.todo.createdAt;
}
function rowUpdatedAt(r: Row): number {
  return r.todo.updatedAt;
}
function rowDueAt(r: Row): number {
  return r.todo.dueAt ?? MAX;
}

// ── Awaiting life row (active · ready for Tom) ──────────────────────────────
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

function Chip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`border rounded-md px-2 py-0.5 text-xs ${
        on
          ? "border-accent text-text"
          : "border-border text-text-muted hover:text-text"
      }`}
    >
      {label} <span className="text-text-faint">{count}</span>
    </button>
  );
}

export default function EverythingTab({
  link,
  onLinkCleared,
}: {
  link: { item: string; intent: "done" | "archive" | "engage" | null } | null;
  onLinkCleared: () => void;
}) {
  const { isTom, canReadSurface } = useAuth();
  // Read gate, not the write gate: Tom, plus the read-only `agent` role a TTS
  // session browses as. Every mutation on this surface stays Tom-only and is
  // refused by Convex regardless of what renders here — isTom below gates the
  // one write that fires on its own, without a click.
  const canRead = canReadSurface("TTS");
  const todos = useQuery(api.tts.listTodos, canRead ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, canRead ? {} : "skip");
  const recordEvent = useMutation(api.tts.recordEvent);

  const now = Date.now();
  // The sections on top tick once a minute on their own — a "3 min ago" has
  // to move while nothing else re-renders the tab.
  const coarseNow = useCoarseNow();

  // ── Filters ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Set<Status>>(
    () => new Set<Status>(["active"]),
  );
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("dueAt");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows: Row[] = useMemo(
    () => (todos ?? []).map((todo) => ({ kind: "life", key: todo._id, todo })),
    [todos],
  );

  // ── The awaiting section and the ruled, applying section ─────────────────
  // ONE definition of what awaits Tom (app/jarvis/lib.ts selectNeedsMe) — the
  // shell's badge on this tab counts the same selection.
  const needsMe = useMemo(
    () => selectNeedsMe(todos ?? [], rulings ?? []),
    [todos, rulings],
  );
  const awaitingLife = useMemo(
    () =>
      [...needsMe.lifeRows].sort(
        (a, b) => (a.dueAt ?? MAX) - (b.dueAt ?? MAX),
      ),
    [needsMe],
  );
  const applying = useMemo(
    () => [...needsMe.pending].sort((a, b) => b.ruledAt - a.ruledAt),
    [needsMe],
  );
  const statementByRulingKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of todos ?? [])
      map.set(
        rulingSubjectKey({ subjectType: "life", todoId: t._id }),
        t.statement,
      );
    return map;
  }, [todos]);

  // ── Predicates (each chip's count ignores its OWN dimension) ──────────────
  const q = search.trim().toLowerCase();
  const bySearch = (r: Row) =>
    q === "" || rowStatement(r).toLowerCase().includes(q);
  const byStatus = (r: Row) => rowStatuses(r).some((s) => statuses.has(s));
  const doneSet = buildDoneSet(todos ?? []);
  // The waiting context every row's reason is computed against: the same
  // done set, and need names looked up here. Declined sources arrive with
  // phase 6 (the archived integration todos); until then none is declined.
  const statementById = new Map((todos ?? []).map((t) => [t._id as string, t.statement]));
  const waitingCtx: WaitingContext = {
    now,
    doneSet,
    statementOf: (id) => statementById.get(id),
  };
  const byCategory = (r: Row) =>
    category === "" || rowCategory(r) === category;

  const isLinked = (r: Row) =>
    link !== null && r.kind === "life" && r.todo._id === link.item;

  const matches = useMemo(() => {
    const list = rows.filter(
      (r) => isLinked(r) || (bySearch(r) && byStatus(r) && byCategory(r)),
    );
    const cmp = (a: Row, b: Row): number => {
      if (sort === "dueAt") {
        const d = rowDueAt(a) - rowDueAt(b);
        if (d !== 0) return d;
        return rowCreatedAt(a) - rowCreatedAt(b);
      }
      if (sort === "createdAt") return rowCreatedAt(b) - rowCreatedAt(a);
      return rowUpdatedAt(b) - rowUpdatedAt(a);
    };
    return [...list].sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, statuses, category, sort, link]);

  // Counts, each ignoring its own filter dimension.
  const statusCount = (s: Status) =>
    rows.filter(
      (r) => bySearch(r) && byCategory(r) && rowStatuses(r).includes(s),
    ).length;
  const categoryCount = (c: string) =>
    rows.filter(
      (r) => bySearch(r) && byStatus(r) && rowCategory(r) === c,
    ).length;

  // Category options: every category on a todo.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos ?? []) if (t.category) set.add(t.category);
    return [...set].sort();
  }, [todos]);

  // ── Engagement instrumentation + expand/collapse ──────────────────────────
  const engage = (r: Row) => {
    void recordEvent({
      kind: "engaged",
      todoId: r.todo._id,
      data: { via: "everything" },
    }).catch(() => {});
  };

  const flip = (key: string, engageIt: () => void) => {
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening) engageIt();
  };
  const toggle = (r: Row) => flip(r.key, () => engage(r));

  // ── Deep link: force-expand + scroll to the linked todo once loaded ───────
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!link || scrolledRef.current || todos === undefined) return;
    scrolledRef.current = true;
    setExpanded((prev) => new Set(prev).add(link.item));
    const linkedId = link.item as Id<"todos">;
    // isTom, not canRead: this is the ONE write on this page that fires
    // without a click, so a headless ?item= screenshot would otherwise record
    // engagement nobody performed — and, being a refused mutation for the
    // read-only `agent` role, print a console error that tts-browse reports
    // as page breakage. The click-driven engage() below needs no such guard:
    // a click is a person, and Convex refuses it anyway.
    if (isTom && todos.some((t) => t._id === linkedId)) {
      // The link arrives from a Slack item link (?item=): a link landed on
      // this item.
      void recordEvent({
        kind: "engaged",
        todoId: linkedId,
        data: { via: "everything-link" },
      }).catch(() => {});
    }
    requestAnimationFrame(() => {
      document
        .getElementById(`todo-${link.item}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [isTom, link, todos, recordEvent]);

  if (todos === undefined || rulings === undefined) {
    return <div className="text-sm text-text-faint py-8">Loading…</div>;
  }

  const toggleSet = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionHeader
          title="awaiting"
          count={awaitingLife.length}
        />
        {awaitingLife.length > 0 && (
          <div className="space-y-1.5">
            {awaitingLife.map((t) => (
              <LifeRow
                key={t._id}
                todo={t}
                now={coarseNow}
                expanded={expanded.has(awaitingKey(t._id))}
                onToggle={() =>
                  flip(awaitingKey(t._id), () => {
                    void recordEvent({
                      kind: "engaged",
                      todoId: t._id,
                      data: { via: "everything-awaiting" },
                    }).catch(() => {});
                  })
                }
              />
            ))}
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
            <span className="text-text-faint">{ageText(r.ruledAt, coarseNow)}</span>
          </div>
        ))}
      </section>

      <div className="space-y-3">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search"
            className={`${inputCls} w-48`}
          />
          {STATUSES.map((s) => (
            <Chip
              key={s}
              label={s}
              count={statusCount(s)}
              on={statuses.has(s)}
              onClick={() => setStatuses((prev) => toggleSet(prev, s))}
            />
          ))}
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputCls}
          >
            <option value="">category: all</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c} ({categoryCount(c)})
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className={inputCls}
          >
            <option value="dueAt">sort: dueAt</option>
            <option value="createdAt">sort: createdAt</option>
            <option value="updatedAt">sort: updatedAt</option>
          </select>
          <span className="text-xs text-text-faint ml-auto">
            {matches.length} of {rows.length}
          </span>
        </div>

        {/* Rows */}
        <div className="space-y-1.5">
          {matches.map((r) => (
            <TodoRow
              key={r.key}
              todo={r.todo}
              now={now}
              expanded={expanded.has(r.key)}
              onToggle={() => toggle(r)}
              intent={link && link.item === r.todo._id ? link.intent : null}
              onIntentCleared={onLinkCleared}
              waiting={waitingReason(r.todo, waitingCtx)}
              waitingOn={(r.todo.needs ?? [])
                .filter((n) => !doneSet.has(n))
                .map((n) => statementById.get(n) ?? n)}
            />
          ))}
          {matches.length === 0 && (
            <div className="text-sm text-text-faint py-4">0 rows</div>
          )}
        </div>
      </div>
    </div>
  );
}
