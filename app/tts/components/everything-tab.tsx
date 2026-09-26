"use client";

// EVERYTHING tab — the default tab. On top, the todos
// awaiting Tom's ruling (app/tts/lib.ts selectNeedsMe, the rows the tab's
// badge counts), then the rulings recorded and not yet applied. Under them one
// unified filterable flat list of all life todos and all code-mirror rows.
// Toolbar: text search, status chips, kind chips, category select, sort select
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
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { useCoarseNow } from "@/app/lib/hooks/use-coarse-now";
import { useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import TodoRow from "./todo-row";
import CodeTodoRow from "./code-todo-row";
import OptionsRow from "./options-row";
import SignoffBlock from "./signoff-block";
import SectionHeader from "./section-header";
import TimeNoteField, {
  groupTimeNotes,
  NO_NOTES,
  type TimeNote,
} from "./time-note-field";
import {
  countdownText,
  waitingReason,
  type WaitingContext,
} from "@/convex/ttsShared";
import {
  ageText,
  buildDoneSet,
  codeSubjectKey,
  fmtDate,
  liveRulingsByKey,
  rulingSubjectKey,
  selectNeedsMe,
  type MirrorRow,
  type Todo,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";

const STATUSES = ["active", "done", "archived"] as const;
type Status = (typeof STATUSES)[number];
const KINDS = ["life", "code"] as const;
type Kind = (typeof KINDS)[number];
type SortKey = "dueAt" | "createdAt" | "updatedAt";

type Row =
  | { kind: "life"; key: string; todo: Todo }
  | {
      kind: "code";
      key: string;
      row: MirrorRow;
      brief: Doc<"dtsCodeBriefs"> | undefined;
      ruling: Doc<"rulings"> | undefined;
    };

const MAX = Number.MAX_SAFE_INTEGER;

const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";

// The expanded-row key of a row in the awaiting section. An awaiting todo is
// also in the list below; its own key keeps opening one from opening both.
const awaitingKey = (key: string) => `awaiting ${key}`;

// A mirror row's repo-side status is only open|closed — "closed" cannot say
// whether the item completed or was archived upstream, so a closed row
// matches EITHER terminal chip rather than masquerading as done.
//
// A life row still carrying the stored status "waiting" reads as ACTIVE: a
// sleep is a wakeAt on an active row (the widen), and the row's own waiting
// line says it is asleep. Reading it as anything else would hide it — there
// is no waiting chip left to match.
function rowStatuses(r: Row): Status[] {
  if (r.kind === "life") {
    return [r.todo.status === "waiting" ? "active" : r.todo.status];
  }
  return r.row.status === "open" ? ["active"] : ["done", "archived"];
}
function rowStatement(r: Row): string {
  return r.kind === "life" ? r.todo.statement : r.row.statement;
}
function rowCategory(r: Row): string | undefined {
  return r.kind === "life" ? r.todo.category : "code";
}
function rowCreatedAt(r: Row): number {
  return r.kind === "life" ? r.todo.createdAt : r.row._creationTime;
}
function rowUpdatedAt(r: Row): number {
  return r.kind === "life" ? r.todo.updatedAt : r.row.syncedAt;
}
function rowDueAt(r: Row): number {
  return r.kind === "life" ? (r.todo.dueAt ?? MAX) : MAX;
}

// ── Awaiting life row (active · ready for Tom) ──────────────────────────────
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
  const mirror = useQuery(api.tts.listMirror, canRead ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, canRead ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, canRead ? {} : "skip");
  // ONE time-note subscription for the whole tab; each row gets its own slice.
  const timeNotes = useQuery(api.tts.listTimeNotes, canRead ? {} : "skip");
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
  const [kinds, setKinds] = useState<Set<Kind>>(
    () => new Set<Kind>(["life", "code"]),
  );
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("dueAt");

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Joins ─────────────────────────────────────────────────────────────────
  const briefByKey = useMemo(() => {
    const map = new Map<string, Doc<"dtsCodeBriefs">>();
    for (const b of codeBriefs ?? []) map.set(codeSubjectKey(b.repo, b.externalId), b);
    return map;
  }, [codeBriefs]);

  // Live ruling per subject — the shared derivation (app/tts/lib.ts), same
  // rule the server and the needs-me selector use.
  const liveRulingByKey = useMemo(
    () => liveRulingsByKey(rulings ?? []),
    [rulings],
  );

  // ONE bucketing pass over the subscription; each row indexes into it.
  const notesByContext = useMemo(
    () => groupTimeNotes(timeNotes ?? []),
    [timeNotes],
  );

  const rows: Row[] = useMemo(() => {
    const life: Row[] = (todos ?? []).map((t) => ({
      kind: "life",
      key: t._id,
      todo: t,
    }));
    const code: Row[] = (mirror ?? []).map((r) => {
      const key = codeSubjectKey(r.repo, r.externalId);
      return {
        kind: "code",
        key,
        row: r,
        brief: briefByKey.get(key),
        ruling: liveRulingByKey.get(key),
      };
    });
    return [...life, ...code];
  }, [todos, mirror, briefByKey, liveRulingByKey]);

  // ── The awaiting section and the ruled, applying section ─────────────────
  // ONE definition of what awaits Tom (app/tts/lib.ts selectNeedsMe) — the
  // shell's badge on this tab counts the same selection.
  const needsMe = useMemo(
    () =>
      selectNeedsMe(todos ?? [], mirror ?? [], codeBriefs ?? [], rulings ?? []),
    [todos, mirror, codeBriefs, rulings],
  );
  const awaitingLife = useMemo(
    () =>
      [...needsMe.lifeRows].sort(
        (a, b) => (a.dueAt ?? MAX) - (b.dueAt ?? MAX),
      ),
    [needsMe],
  );
  const awaitingCode = useMemo(
    () =>
      [...needsMe.codeRows].sort(
        (a, b) =>
          a.row.repo.localeCompare(b.row.repo) ||
          a.row.statement.localeCompare(b.row.statement),
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
    for (const r of mirror ?? [])
      map.set(codeSubjectKey(r.repo, r.externalId), r.statement);
    return map;
  }, [todos, mirror]);

  // ── Predicates (each chip's count ignores its OWN dimension) ──────────────
  const q = search.trim().toLowerCase();
  const bySearch = (r: Row) =>
    q === "" || rowStatement(r).toLowerCase().includes(q);
  const byStatus = (r: Row) => rowStatuses(r).some((s) => statuses.has(s));
  const byKind = (r: Row) => kinds.has(r.kind);
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
      (r) =>
        isLinked(r) ||
        (bySearch(r) && byStatus(r) && byKind(r) && byCategory(r)),
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
  }, [rows, q, statuses, kinds, category, sort, link]);

  // Counts, each ignoring its own filter dimension.
  const statusCount = (s: Status) =>
    rows.filter(
      (r) => bySearch(r) && byKind(r) && byCategory(r) && rowStatuses(r).includes(s),
    ).length;
  const kindCount = (k: Kind) =>
    rows.filter(
      (r) => bySearch(r) && byStatus(r) && byCategory(r) && r.kind === k,
    ).length;
  const categoryCount = (c: string) =>
    rows.filter(
      (r) => bySearch(r) && byStatus(r) && byKind(r) && rowCategory(r) === c,
    ).length;

  // Category options: every category on a todo, plus "code" for mirror rows.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos ?? []) if (t.category) set.add(t.category);
    if ((mirror ?? []).length > 0) set.add("code");
    return [...set].sort();
  }, [todos, mirror]);

  // ── Engagement instrumentation + expand/collapse ──────────────────────────
  const engage = (r: Row) => {
    if (r.kind === "life") {
      void recordEvent({
        kind: "engaged",
        todoId: r.todo._id,
        data: { via: "everything" },
      }).catch(() => {});
    } else {
      void recordEvent({
        kind: "engaged",
        data: {
          via: "everything-code",
          repo: r.row.repo,
          externalId: r.row.externalId,
        },
      }).catch(() => {});
    }
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
    const linkedId = link.item as Id<"dtsTodos">;
    // isTom, not canRead: this is the ONE write on this page that fires
    // without a click, so a headless ?item= screenshot would otherwise record
    // engagement nobody performed — and, being a refused mutation for the
    // read-only `agent` role, print a console error that tts-browse reports
    // as page breakage. The click-driven engage() below needs no such guard:
    // a click is a person, and Convex refuses it anyway.
    if (isTom && todos.some((t) => t._id === linkedId)) {
      // The link arrives from a Slack item link (?item=) or a calendar
      // queue-chip click-through — either way, a link landed on this item.
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

  if (
    todos === undefined ||
    mirror === undefined ||
    codeBriefs === undefined ||
    rulings === undefined
  ) {
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
      <SignoffBlock now={coarseNow} />

      <section className="space-y-2">
        <SectionHeader
          title="awaiting"
          count={awaitingLife.length + awaitingCode.length}
        />
        {(awaitingLife.length > 0 || awaitingCode.length > 0) && (
          <div className="space-y-1.5">
            {awaitingLife.map((t) => (
              <LifeRow
                key={t._id}
                todo={t}
                now={coarseNow}
                notes={notesByContext.get(t._id) ?? NO_NOTES}
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
            {awaitingCode.map(({ row, brief }) => {
              const key = codeSubjectKey(row.repo, row.externalId);
              return (
                <CodeTodoRow
                  key={row._id}
                  row={row}
                  brief={brief}
                  ruling={liveRulingByKey.get(key)}
                  now={coarseNow}
                  expanded={expanded.has(awaitingKey(key))}
                  onToggle={() =>
                    flip(awaitingKey(key), () => {
                      void recordEvent({
                        kind: "engaged",
                        data: {
                          via: "everything-awaiting-code",
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
          <span className="text-text-faint text-xs">·</span>
          {KINDS.map((k) => (
            <Chip
              key={k}
              label={k}
              count={kindCount(k)}
              on={kinds.has(k)}
              onClick={() => setKinds((prev) => toggleSet(prev, k))}
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
          {matches.map((r) =>
            r.kind === "life" ? (
              <TodoRow
                key={r.key}
                todo={r.todo}
                now={now}
                expanded={expanded.has(r.key)}
                onToggle={() => toggle(r)}
                intent={link && link.item === r.todo._id ? link.intent : null}
                onIntentCleared={onLinkCleared}
                timeNotes={notesByContext.get(r.todo._id) ?? NO_NOTES}
                waiting={waitingReason(r.todo, waitingCtx)}
                waitingOn={(r.todo.needs ?? [])
                  .filter((n) => !doneSet.has(n))
                  .map((n) => statementById.get(n) ?? n)}
              />
            ) : (
              <CodeTodoRow
                key={r.key}
                row={r.row}
                brief={r.brief}
                ruling={r.ruling}
                now={now}
                expanded={expanded.has(r.key)}
                onToggle={() => toggle(r)}
              />
            ),
          )}
          {matches.length === 0 && (
            <div className="text-sm text-text-faint py-4">0 rows</div>
          )}
        </div>
      </div>
    </div>
  );
}
