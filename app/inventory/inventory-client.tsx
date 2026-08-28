"use client";

// DTS Inventory — everything, always (spec §6). A single scrolling page:
// quick-add, then every life-todo grouped by where it stands, the code-todo
// mirror, and the fully browsable done/archive tail. Descriptive copy only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TodoRow from "./components/todo-row";
import CodeTodoRow, {
  type CodeBrief,
  type CodeRuling,
} from "./components/code-todo-row";
import {
  ageText,
  parseDateInput,
  type LinkIntent,
  type MirrorRow,
  type Todo,
} from "./lib";

const inputCls =
  "bg-surface border border-border rounded-md px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";

function SectionHeader({
  title,
  count,
  note,
}: {
  title: string;
  count: number;
  note?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <span className="text-sm text-text-faint">{count}</span>
      {note && <span className="text-xs text-text-faint">{note}</span>}
    </div>
  );
}

// Collapsed-by-default section whose children are BUILT only when opened —
// the done/archive tails grow without bound (nothing is ever deleted), and a
// native <details> would mount every row invisibly on each page load (review
// finding). `children` is a render function for exactly that reason.
function LazySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-baseline gap-2"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-text-faint">{count}</span>
        <span className="text-xs text-text-faint">
          {open ? "click to collapse" : "click to browse"}
        </span>
      </button>
      {open && <div className="space-y-1.5 mt-2">{children()}</div>}
    </section>
  );
}

function QuickAdd() {
  const createTodo = useMutation(api.dts.createTodo);
  const [statement, setStatement] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = statement.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTodo({ statement: trimmed, dueAt: parseDateInput(date) });
      setStatement("");
      setDate("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-bg/95 backdrop-blur border-b border-border">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="Add a todo…"
          className={`${inputCls} flex-1 min-w-48`}
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          title="Optional date (a date set here is a self-imposed date)"
          className={inputCls}
        />
        <button
          type="submit"
          disabled={!statement.trim() || busy}
          className="bg-accent text-bg rounded-md px-4 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <div className="text-xs text-error mt-1">{error}</div>}
    </div>
  );
}

export default function InventoryClient() {
  const { loading, isTom } = useAuth();
  const router = useRouter();
  const todos = useQuery(api.dts.listTodos, isTom ? {} : "skip");
  const mirror = useQuery(api.dts.listMirror, isTom ? {} : "skip");
  const codeBriefs = useQuery(api.dtsCode.listCodeBriefs, isTom ? {} : "skip");
  const codeRulings = useQuery(api.dtsCode.listCodeRulings, isTom ? {} : "skip");
  const recordEvent = useMutation(api.dts.recordEvent);

  const now = Date.now();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Code-todo rows expand independently, keyed by repo + externalId.
  const [codeExpanded, setCodeExpanded] = useState<Set<string>>(new Set());
  const [link, setLink] = useState<{
    item: string;
    intent: LinkIntent | null;
  } | null>(null);

  // Read ?item=…&intent=… once on mount. The mutation NEVER fires here —
  // only the highlighted confirm button in the row does (GETs must not
  // change state; Slack's link-preview crawler fetches these URLs).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const item = sp.get("item");
    if (!item) return;
    const raw = sp.get("intent");
    const intent =
      raw === "done" || raw === "archive" || raw === "engage" ? raw : null;
    setLink({ item, intent });
  }, []);

  // Once data is here: expand the linked item and scroll to it.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!link || scrolledRef.current || todos === undefined) return;
    scrolledRef.current = true;
    setExpanded((prev) => new Set(prev).add(link.item));
    requestAnimationFrame(() => {
      document
        .getElementById(`todo-${link.item}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [link, todos]);

  const clearLink = () => {
    setLink(null);
    router.replace("/inventory", { scroll: false });
  };

  // Instrumentation: one inventory-opened per load, once data is here.
  // Fire-and-forget — never blocks the UI.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || todos === undefined) return;
    openedRef.current = true;
    void recordEvent({ kind: "inventory-opened" }).catch(() => {});
  }, [todos, recordEvent]);

  const engage = (id: Id<"dtsTodos">) =>
    void recordEvent({
      kind: "engaged",
      todoId: id,
      data: { via: "inventory" },
    }).catch(() => {});

  const toggle = (id: Id<"dtsTodos">) => {
    const opening = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (opening) engage(id);
  };

  const openAndScroll = (id: Id<"dtsTodos">) => {
    if (!expanded.has(id)) {
      setExpanded((prev) => new Set(prev).add(id));
      engage(id);
    }
    requestAnimationFrame(() => {
      document
        .getElementById(`todo-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // ── Grouping ──────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const all = todos ?? [];
    const active = all.filter((t) => t.status === "active");
    const readyForTom = active.filter((t) => t.readiness === "ready-for-tom");
    const rest = active.filter((t) => t.readiness !== "ready-for-tom");
    const byDue = (a: Todo, b: Todo) =>
      (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER);
    return {
      readyForTom: [...readyForTom].sort(byDue),
      dated: rest.filter((t) => t.timingClass === "dated").sort(byDue),
      conditionBound: rest
        .filter((t) => t.timingClass === "condition-bound")
        .sort(
          (a, b) =>
            (a.latestSafeAt ?? Number.MAX_SAFE_INTEGER) -
            (b.latestSafeAt ?? Number.MAX_SAFE_INTEGER),
        ),
      whenever: rest
        .filter((t) => t.timingClass === "whenever")
        .sort((a, b) => a.createdAt - b.createdAt),
      // Exactly the active-minus-ready-for-tom set: readiness is a closed
      // 3-value union, so deriving from `rest` keeps the two sections in
      // lockstep if a tier is ever added (review finding).
      inPreparation: [...rest].sort((a, b) => a.createdAt - b.createdAt),
      waiting: all
        .filter((t) => t.status === "waiting")
        .sort(
          (a, b) =>
            (a.wakeAt ?? Number.MAX_SAFE_INTEGER) -
            (b.wakeAt ?? Number.MAX_SAFE_INTEGER),
        ),
      done: all
        .filter((t) => t.status === "done")
        .sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)),
      archived: all
        .filter((t) => t.status === "archived")
        .sort(
          (a, b) =>
            (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt),
        ),
    };
  }, [todos]);

  const mirrorByRepo = useMemo(() => {
    const map = new Map<string, MirrorRow[]>();
    for (const row of mirror ?? []) {
      const list = map.get(row.repo) ?? [];
      list.push(row);
      map.set(row.repo, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const openA = a.status === "open" ? 0 : 1;
        const openB = b.status === "open" ? 0 : 1;
        if (openA !== openB) return openA - openB;
        return a.statement.localeCompare(b.statement);
      });
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mirror]);

  // Briefs and rulings, keyed by repo + externalId. For rulings, the row
  // with the latest ruledAt is the live one — earlier rows are history.
  const codeKey = (repo: string, externalId: string) =>
    `${repo}\u0000${externalId}`;

  const briefByKey = useMemo(() => {
    const map = new Map<string, CodeBrief>();
    for (const b of codeBriefs ?? []) map.set(codeKey(b.repo, b.externalId), b);
    return map;
  }, [codeBriefs]);

  const liveRulingByKey = useMemo(() => {
    const map = new Map<string, CodeRuling>();
    for (const r of codeRulings ?? []) {
      const key = codeKey(r.repo, r.externalId);
      const prev = map.get(key);
      if (!prev || r.ruledAt > prev.ruledAt) map.set(key, r);
    }
    return map;
  }, [codeRulings]);

  const toggleCode = (repo: string, externalId: string) => {
    const key = codeKey(repo, externalId);
    const opening = !codeExpanded.has(key);
    setCodeExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Instrumentation: expanding a briefed row is an engagement. Code todos
    // have no dtsTodos id, so the ids ride in data (todoId is life-todo only).
    if (opening) {
      void recordEvent({
        kind: "engaged",
        data: { via: "inventory-code", repo, externalId },
      }).catch(() => {});
    }
  };

  // ── Gates ─────────────────────────────────────────────────────────────────
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
          Inventory access is restricted to Tom.
        </div>
      </div>
    );
  }

  if (todos === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading inventory…</span>
      </div>
    );
  }

  const row = (t: Todo) => (
    <TodoRow
      key={t._id}
      todo={t}
      now={now}
      expanded={expanded.has(t._id)}
      onToggle={() => toggle(t._id)}
      intent={link && link.item === t._id ? link.intent : null}
      onIntentCleared={clearLink}
    />
  );

  const activeCount =
    groups.dated.length + groups.conditionBound.length + groups.whenever.length;
  const openMirrorCount = (mirror ?? []).filter(
    (r) => r.status === "open",
  ).length;
  // Open items with a prepared brief and no ruling yet — the section summary.
  const briefedAwaitingCount = (mirror ?? []).filter(
    (r) =>
      r.status === "open" &&
      briefByKey.has(codeKey(r.repo, r.externalId)) &&
      !liveRulingByKey.has(codeKey(r.repo, r.externalId)),
  ).length;

  return (
    <div className="max-w-5xl mx-auto px-6 pb-16">
      <QuickAdd />

      <header className="pt-8 pb-2">
        <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
        <p className="text-text-muted mt-1">
          Everything, always — every todo, its age, and where it stands.
          Nothing is hidden.
        </p>
      </header>

      <div className="space-y-8 mt-4">
        {/* 1 — Waiting on you */}
        <section className="space-y-2">
          <SectionHeader
            title="Waiting on you"
            count={groups.readyForTom.length}
            note="active, readiness ready-for-tom"
          />
          {groups.readyForTom.length === 0 ? (
            <p className="text-sm text-text-faint">
              Nothing is at a tom-gate right now.
            </p>
          ) : (
            <div className="space-y-1.5">{groups.readyForTom.map(row)}</div>
          )}
        </section>

        {/* 2 — Active, by timing class */}
        <section className="space-y-3">
          <SectionHeader
            title="Active"
            count={activeCount}
            note="not yet ready-for-tom, grouped by timing class"
          />
          <div className="space-y-1.5">
            <h3 className="text-sm text-text-muted">
              dated <span className="text-text-faint">{groups.dated.length}</span>
            </h3>
            {groups.dated.length === 0 ? (
              <p className="text-xs text-text-faint">No dated items.</p>
            ) : (
              groups.dated.map(row)
            )}
          </div>
          <div className="space-y-1.5">
            <h3 className="text-sm text-text-muted">
              condition-bound{" "}
              <span className="text-text-faint">
                {groups.conditionBound.length}
              </span>
            </h3>
            {groups.conditionBound.length === 0 ? (
              <p className="text-xs text-text-faint">No condition-bound items.</p>
            ) : (
              groups.conditionBound.map(row)
            )}
          </div>
          <div className="space-y-1.5">
            <h3 className="text-sm text-text-muted">
              whenever{" "}
              <span className="text-text-faint">{groups.whenever.length}</span>
            </h3>
            {groups.whenever.length === 0 ? (
              <p className="text-xs text-text-faint">No whenever items.</p>
            ) : (
              groups.whenever.map(row)
            )}
          </div>
        </section>

        {/* 3 — In preparation (readiness lens on the same active items) */}
        <section className="space-y-2">
          <SectionHeader
            title="In preparation"
            count={groups.inPreparation.length}
            note="active, readiness unprepared or preparing — agents hold these"
          />
          {groups.inPreparation.length === 0 ? (
            <p className="text-sm text-text-faint">
              No items are in preparation.
            </p>
          ) : (
            <div className="space-y-0.5">
              {groups.inPreparation.map((t) => (
                <button
                  key={t._id}
                  onClick={() => openAndScroll(t._id)}
                  className="w-full text-left flex flex-wrap items-baseline gap-x-3 px-2 py-1 rounded hover:bg-surface/60"
                >
                  <span className="text-sm text-text-muted truncate">
                    {t.statement}
                  </span>
                  <span className="text-xs text-text-faint ml-auto">
                    {t.readiness} · from {t.source} · captured{" "}
                    {ageText(t.createdAt, now)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 4 — Waiting */}
        <section className="space-y-2">
          <SectionHeader
            title="Waiting"
            count={groups.waiting.length}
            note="asleep until a wake condition or wake time"
          />
          {groups.waiting.length === 0 ? (
            <p className="text-sm text-text-faint">Nothing is waiting.</p>
          ) : (
            <div className="space-y-1.5">{groups.waiting.map(row)}</div>
          )}
        </section>

        {/* 5 — Code todos (mirrored; each repo is its own system of record.
            Open items carry a prepared brief and Tom's ruling controls;
            rulings are recorded here and applied back by the worker). */}
        <section className="space-y-2">
          <SectionHeader
            title="Code todos"
            count={(mirror ?? []).length}
            note={`${openMirrorCount} open — mirrored; each repo is its own system of record`}
          />
          {briefedAwaitingCount > 0 && (
            <p className="text-sm text-text-muted">
              {briefedAwaitingCount} briefed awaiting your ruling
            </p>
          )}
          {mirrorByRepo.length === 0 ? (
            <p className="text-sm text-text-faint">No mirrored code todos.</p>
          ) : (
            mirrorByRepo.map(([repo, rows]) => (
              <div key={repo} className="space-y-1">
                <h3 className="text-sm text-text-muted">
                  {repo} <span className="text-text-faint">{rows.length}</span>
                </h3>
                <div className="space-y-1">
                  {rows.map((r) => {
                    const key = codeKey(r.repo, r.externalId);
                    const brief = briefByKey.get(key);
                    if (r.status === "open" && brief) {
                      return (
                        <CodeTodoRow
                          key={r._id}
                          row={r}
                          brief={brief}
                          ruling={liveRulingByKey.get(key)}
                          now={now}
                          expanded={codeExpanded.has(key)}
                          onToggle={() => toggleCode(r.repo, r.externalId)}
                        />
                      );
                    }
                    return (
                      <a
                        key={r._id}
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex flex-wrap items-baseline gap-x-3 px-2 py-1 rounded hover:bg-surface/60"
                      >
                        <span
                          className={`text-sm ${
                            r.status === "open"
                              ? "text-text"
                              : "text-text-faint line-through"
                          }`}
                        >
                          {r.statement}
                        </span>
                        <span className="text-xs text-text-faint border border-border rounded px-1 py-px">
                          {r.tier}
                        </span>
                        {r.status === "open" && (
                          <span className="text-xs text-text-faint">
                            not yet briefed
                          </span>
                        )}
                        <span className="text-xs text-text-faint ml-auto">
                          {r.status} · synced {ageText(r.syncedAt, now)}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </section>

        {/* 6 — Done */}
        <LazySection title="Done" count={groups.done.length}>
          {() =>
            groups.done.length === 0 ? (
              <p className="text-sm text-text-faint">No completed items yet.</p>
            ) : (
              groups.done.map(row)
            )
          }
        </LazySection>

        {/* 7 — Archive */}
        <LazySection title="Archive" count={groups.archived.length}>
          {() =>
            groups.archived.length === 0 ? (
              <p className="text-sm text-text-faint">The archive is empty.</p>
            ) : (
              groups.archived.map(row)
            )
          }
        </LazySection>
      </div>
    </div>
  );
}
