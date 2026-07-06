"use client";

// Paste-anything inventory import: free text -> lib/inventory's tolerant
// parser -> a correctable preview. Confident lines import as-is; near-miss
// lines offer ranked guesses to accept; unknown lines are struck out and
// skipped. "Add" merges into the inventory, "Replace" swaps it wholesale —
// both owner-only (the panel gates opening on permissions.editInventory).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImportRow } from "../lib/brew-types";
import { parseInventoryText, type CatalogEntry } from "../lib/inventory";
import { btn, cn } from "./ui";

export interface ImportDialogProps {
  // every name an inventory line may resolve to (ingredients, pures, perfumes)
  catalog: CatalogEntry[];
  onImport: (rows: { itemKey: string; count: number }[], mode: "merge" | "replace") => void;
  onClose: () => void;
}

const PLACEHOLDER = "Noble Roses x3\n2 pemneath peat\nPure Ignetium";

export default function ImportDialog({ catalog, onImport, onClose }: ImportDialogProps) {
  const [text, setText] = useState("");
  // accepted guesses, keyed by row position + raw line so edits invalidate
  const [accepted, setAccepted] = useState<Record<string, string>>({});
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

  // duplicate names merge here so "replace" can't depend on row order
  const valid = useMemo(() => {
    const byKey = new Map<string, number>();
    for (const r of resolved) {
      if (r.itemKey && r.row.count > 0)
        byKey.set(r.itemKey, (byKey.get(r.itemKey) ?? 0) + r.row.count);
    }
    return [...byKey.entries()].map(([itemKey, count]) => ({ itemKey, count }));
  }, [resolved]);

  const skipped = resolved.filter((r) => !r.itemKey).length;
  const units = valid.reduce((s, r) => s + r.count, 0);

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
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Import inventory</h2>
            <p className="mt-0.5 font-mono text-[11px] text-text-faint">
              one item per line — counts anywhere, names forgiving of typos
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

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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
              title="Discard the current inventory and start from these rows"
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
