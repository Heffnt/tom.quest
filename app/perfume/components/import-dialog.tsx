"use client";

// Inventory import — TWO ways in, side by side (DESIGN.md §Layout "Import"):
//   - a PASTE box: free text -> lib/inventory's tolerant parser -> a correctable
//     preview. Confident lines import as-is; near-miss lines offer ranked
//     guesses to accept; unknown lines are struck out and skipped.
//   - a searchable CLICK-TO-ADD catalog: the same search + frequency/type filter
//     grammar as the input panel (lib/filters), an ingredient grid where each
//     click adds one.
// The two sources MERGE into one set; "Add" merges that into the inventory,
// "Replace" swaps it wholesale — both owner-only (the panel gates opening on
// permissions.editInventory).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImportRow } from "../lib/brew-types";
import type { Ingredient } from "../lib/types";
import { parseInventoryText, type CatalogEntry } from "../lib/inventory";
import { splitFilters, ingredientPasses, ingredientMatchesSearch } from "../lib/filters";
import { ItemArt } from "./item-art";
import FrequencyFilterButton from "./frequency-filter";
import { btn, cn } from "./ui";

export interface ImportDialogProps {
  // every name an inventory line may resolve to (ingredients, pures, perfumes)
  catalog: CatalogEntry[];
  // the clickable catalog for the add-by-click column (ingredients + pures)
  ingredients: Ingredient[];
  onImport: (rows: { itemKey: string; count: number }[], mode: "merge" | "replace") => void;
  onClose: () => void;
}

const PLACEHOLDER = "Noble Roses x3\n2 pemneath peat\nPure Ignetium";

export default function ImportDialog({ catalog, ingredients, onImport, onClose }: ImportDialogProps) {
  const [text, setText] = useState("");
  // accepted guesses, keyed by row position + raw line so edits invalidate
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  // items added by clicking the catalog column, keyed by itemKey -> count
  const [picked, setPicked] = useState<Record<string, number>>({});
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => parseInventoryText(text, catalog), [text, catalog]);
  const nameOf = useMemo(() => new Map(catalog.map((c) => [c.key, c.name])), [catalog]);

  const resolved = useMemo(
    () =>
      rows.map((row, i) => {
        const id = `${i}|${row.line}`;
        return { row, id, itemKey: row.itemKey ?? accepted[id] ?? null };
      }),
    [rows, accepted],
  );

  // paste rows + clicked picks merge by key so "replace" can't depend on order
  const valid = useMemo(() => {
    const byKey = new Map<string, number>();
    for (const r of resolved) {
      if (r.itemKey && r.row.count > 0)
        byKey.set(r.itemKey, (byKey.get(r.itemKey) ?? 0) + r.row.count);
    }
    for (const [key, n] of Object.entries(picked)) {
      if (n > 0) byKey.set(key, (byKey.get(key) ?? 0) + n);
    }
    return [...byKey.entries()].map(([itemKey, count]) => ({ itemKey, count }));
  }, [resolved, picked]);

  const skipped = resolved.filter((r) => !r.itemKey).length;
  const units = valid.reduce((s, r) => s + r.count, 0);

  const addOne = (key: string) => setPicked((p) => ({ ...p, [key]: (p[key] ?? 0) + 1 }));
  const removePick = (key: string) =>
    setPicked((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });

  const commit = (mode: "merge" | "replace") => {
    onImport(valid, mode);
    onClose();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import inventory"
    >
      <div className="absolute inset-0 bg-black/60" onMouseDown={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Import inventory</h2>
            <p className="mt-0.5 font-mono text-[11px] text-text-faint">
              paste a list or click ingredients to add — counts anywhere, names forgiving of typos
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(btn.ghost, "h-6 w-6 shrink-0 p-0 text-text-faint")}
          >
            ✕
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-2 md:divide-x md:divide-border">
          {/* ── paste column ── */}
          <div className="min-h-0 space-y-3 overflow-y-auto p-4">
            <p className="font-mono text-[10px] uppercase tracking-wider text-text-faint">paste a list</p>
            <textarea
              ref={boxRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              rows={6}
              className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
            />
            {resolved.length > 0 && (
              <ul className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border">
                {resolved.map(({ row, id, itemKey }) => (
                  <li key={id} className="flex min-h-9 items-center gap-2 px-2.5 py-1.5">
                    {itemKey ? (
                      <>
                        <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
                          ×{row.count}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-text">
                          {nameOf.get(itemKey) ?? itemKey}
                        </span>
                        {row.itemKey === null && (
                          <button
                            type="button"
                            onClick={() =>
                              setAccepted((a) => {
                                const next = { ...a };
                                delete next[id];
                                return next;
                              })
                            }
                            title={`guessed from "${row.line.trim()}"`}
                            className={cn(btn.outline, "shrink-0 px-1.5 py-0.5 text-[10px] text-text-faint")}
                          >
                            undo
                          </button>
                        )}
                      </>
                    ) : row.guesses.length > 0 ? (
                      <GuessRow row={row} onAccept={(key) => setAccepted((a) => ({ ...a, [id]: key }))} />
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-faint line-through">
                          {row.line.trim()}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase text-error/80">
                          no match
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── click-to-add catalog column ── */}
          <CatalogColumn
            ingredients={ingredients}
            picked={picked}
            onAdd={addOne}
            onRemove={removePick}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="min-w-0 truncate font-mono text-[11px] text-text-faint">
            {valid.length === 0
              ? "nothing to import yet"
              : `${units} item${units === 1 ? "" : "s"} ready` +
                (skipped > 0 ? ` — ${skipped} line${skipped === 1 ? "" : "s"} skipped` : "")}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={valid.length === 0}
              onClick={() => commit("replace")}
              title="Discard the current inventory and start from these items"
              className={cn(
                btn.outline,
                "border-error/50 py-1.5 font-semibold text-error/90 hover:border-error hover:bg-error/10 hover:text-error",
              )}
            >
              Replace inventory
            </button>
            <button
              type="button"
              disabled={valid.length === 0}
              onClick={() => commit("merge")}
              className={cn(btn.accent, "px-2.5")}
            >
              Add to inventory
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── the searchable click-to-add catalog column ───────────────────────────────
// Reuses the input panel's search + frequency/type filter grammar (lib/filters):
// a search box + the multi-select FrequencyFilterButton narrow the ingredient
// grid; each click adds one to the pending import.

function CatalogColumn({
  ingredients,
  picked,
  onAdd,
  onRemove,
}: {
  ingredients: Ingredient[];
  picked: Record<string, number>;
  onAdd: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const { types, freqs } = useMemo(() => splitFilters(filters), [filters]);
  const query = q.trim().toLowerCase();

  const shown = useMemo(
    () =>
      ingredients.filter(
        (ing) => ingredientPasses(ing, types, freqs) && ingredientMatchesSearch(ing, query),
      ),
    [ingredients, types, freqs, query],
  );

  return (
    <div className="flex min-h-0 flex-col overflow-hidden p-4">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">
        or click to add
      </p>
      <div className="mb-2 flex items-stretch gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search ingredients, frequencies…"
          spellCheck={false}
          className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
        <FrequencyFilterButton values={filters} onChange={setFilters} includeCharges includeTypes />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center font-mono text-xs text-text-faint">no ingredients match</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
            {shown.map((ing) => {
              const n = picked[ing.key] ?? 0;
              return (
                <li key={ing.key}>
                  <button
                    type="button"
                    onClick={() => onAdd(ing.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (n > 0) onRemove(ing.key);
                    }}
                    aria-label={`Add ${ing.name}${n > 0 ? ` (${n} added)` : ""}`}
                    title={
                      n > 0
                        ? `${ing.name} — click to add another; right-click to remove`
                        : `${ing.name} — click to add`
                    }
                    className={cn(
                      "group relative flex w-full flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors duration-150",
                      n > 0 ? "border-accent bg-accent/10" : "border-border hover:border-text-muted",
                    )}
                  >
                    <ItemArt itemKey={ing.key} name={ing.name} color={ing.color} size={30} ing={ing} />
                    <span className="w-full truncate text-center text-[10px] leading-tight text-text-muted">
                      {ing.name}
                    </span>
                    {n > 0 && (
                      <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-[9px] font-bold tabular-nums text-bg">
                        {n}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// One unresolved line: the raw text, a select of the ranked guesses, accept.
function GuessRow({ row, onAccept }: { row: ImportRow; onAccept: (itemKey: string) => void }) {
  const [choice, setChoice] = useState(row.guesses[0].itemKey);
  return (
    <>
      <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
        ×{row.count}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-warning" title={row.line}>
        {row.line.trim()}
      </span>
      <span aria-hidden="true" className="shrink-0 font-mono text-[10px] text-text-faint">
        →
      </span>
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        aria-label="Possible matches"
        className="w-36 shrink-0 rounded-md border border-border bg-bg px-1.5 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
      >
        {row.guesses.map((g) => (
          <option key={g.itemKey} value={g.itemKey}>
            {g.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onAccept(choice)}
        className={cn(btn.accent, "shrink-0 px-2 py-1 text-[11px]")}
      >
        accept
      </button>
    </>
  );
}
