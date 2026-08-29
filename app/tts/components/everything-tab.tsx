"use client";

// EVERYTHING tab — one unified filterable flat list of all life todos and all
// code-mirror rows. Toolbar: text search, status chips, kind chips, a
// ready-for-tom toggle, category select, sort select — counts on every chip.
// Rows carry their own state chips; no sections.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TodoRow from "./todo-row";
import CodeTodoRow from "./code-todo-row";
import { groupTimeNotes, NO_NOTES } from "./time-note-field";
import {
  codeSubjectKey,
  liveRulingsByKey,
  type MirrorRow,
  type Todo,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";

const STATUSES = ["active", "waiting", "done", "archived"] as const;
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
      ruling: Doc<"dtsRulings"> | undefined;
    };

const MAX = Number.MAX_SAFE_INTEGER;

// A mirror row's repo-side status is only open|closed — "closed" cannot say
// whether the item completed or was archived upstream, so a closed row
// matches EITHER terminal chip rather than masquerading as done.
function rowStatuses(r: Row): Status[] {
  if (r.kind === "life") return [r.todo.status];
  return r.row.status === "open" ? ["active"] : ["done", "archived"];
}
function rowStatement(r: Row): string {
  return r.kind === "life" ? r.todo.statement : r.row.statement;
}
function rowCategory(r: Row): string | undefined {
  return r.kind === "life" ? r.todo.category : "code";
}
function rowReady(r: Row): boolean {
  return r.kind === "life" && r.todo.readiness === "ready-for-tom";
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
  const { isTom } = useAuth();
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const mirror = useQuery(api.tts.listMirror, isTom ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, isTom ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, isTom ? {} : "skip");
  // ONE time-note subscription for the whole tab; each row gets its own slice.
  const timeNotes = useQuery(api.tts.listTimeNotes, isTom ? {} : "skip");
  const recordEvent = useMutation(api.tts.recordEvent);

  const now = Date.now();

  // ── Filters ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Set<Status>>(
    () => new Set<Status>(["active", "waiting"]),
  );
  const [kinds, setKinds] = useState<Set<Kind>>(
    () => new Set<Kind>(["life", "code"]),
  );
  const [readyOnly, setReadyOnly] = useState(false);
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

  // ── Predicates (each chip's count ignores its OWN dimension) ──────────────
  const q = search.trim().toLowerCase();
  const bySearch = (r: Row) =>
    q === "" || rowStatement(r).toLowerCase().includes(q);
  const byStatus = (r: Row) => rowStatuses(r).some((s) => statuses.has(s));
  const byKind = (r: Row) => kinds.has(r.kind);
  const byReady = (r: Row) => !readyOnly || rowReady(r);
  const byCategory = (r: Row) =>
    category === "" || rowCategory(r) === category;

  const isLinked = (r: Row) =>
    link !== null && r.kind === "life" && r.todo._id === link.item;

  const matches = useMemo(() => {
    const list = rows.filter(
      (r) =>
        isLinked(r) ||
        (bySearch(r) && byStatus(r) && byKind(r) && byReady(r) && byCategory(r)),
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
  }, [rows, q, statuses, kinds, readyOnly, category, sort, link]);

  // Counts, each ignoring its own filter dimension.
  const statusCount = (s: Status) =>
    rows.filter(
      (r) =>
        bySearch(r) &&
        byKind(r) &&
        byReady(r) &&
        byCategory(r) &&
        rowStatuses(r).includes(s),
    ).length;
  const kindCount = (k: Kind) =>
    rows.filter(
      (r) =>
        bySearch(r) &&
        byStatus(r) &&
        byReady(r) &&
        byCategory(r) &&
        r.kind === k,
    ).length;
  const readyCount = rows.filter(
    (r) =>
      bySearch(r) && byStatus(r) && byKind(r) && byCategory(r) && rowReady(r),
  ).length;
  const categoryCount = (c: string) =>
    rows.filter(
      (r) =>
        bySearch(r) &&
        byStatus(r) &&
        byKind(r) &&
        byReady(r) &&
        rowCategory(r) === c,
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

  const toggle = (r: Row) => {
    const opening = !expanded.has(r.key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(r.key)) next.delete(r.key);
      else next.add(r.key);
      return next;
    });
    if (opening) engage(r);
  };

  // ── Deep link: force-expand + scroll to the linked todo once loaded ───────
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!link || scrolledRef.current || todos === undefined) return;
    scrolledRef.current = true;
    setExpanded((prev) => new Set(prev).add(link.item));
    const linkedId = link.item as Id<"dtsTodos">;
    if (todos.some((t) => t._id === linkedId)) {
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
  }, [link, todos, recordEvent]);

  if (todos === undefined || mirror === undefined) {
    return <div className="text-sm text-text-faint py-8">Loading…</div>;
  }

  const toggleSet = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  return (
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
        <span className="text-text-faint text-xs">·</span>
        <Chip
          label="ready-for-tom"
          count={readyCount}
          on={readyOnly}
          onClick={() => setReadyOnly((v) => !v)}
        />
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
  );
}
