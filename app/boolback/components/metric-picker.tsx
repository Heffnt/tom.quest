"use client";

// app/boolback/components/metric-picker.tsx — the chart's X/Y metric select.
//
// A searchable popover replacing the old native <select>: per-method entries
// ("asr_drop@beear") COLLAPSE under their base metric the way facet values
// collapse in the + Filter menu, so fifteen methods × five drop metrics don't
// flatten into an unreadable list. The base row selects the generic metric
// (when one exists — the extra *_drop family is per-method only); its ▸ count
// expands the methods. Searching flattens to direct matches.

import { useMemo, useState } from "react";
import type { MetricSchemaEntry } from "../lib/types";
import { collapseMethodEntries, groupedMetricOptions, type MetricGroupName } from "../lib/metrics";
import { parseMethodMetric } from "../lib/method-metrics";

export function MetricPicker({
  value,
  onChange,
  schema,
  order,
  ariaLabel,
}: {
  value: string;
  onChange: (name: string) => void;
  schema: MetricSchemaEntry[];
  order: MetricGroupName[];
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);

  const { groups, empty } = useMemo(
    () => groupedMetricOptions(schema, order),
    [schema, order],
  );
  const structured = useMemo(
    () => groups.map(([group, entries]) => [group, collapseMethodEntries(entries)] as const),
    [groups],
  );
  const currentLabel = useMemo(
    () => schema.find((e) => e.name === value)?.label ?? value,
    [schema, value],
  );

  const close = () => {
    setOpen(false);
    setQ("");
    setExpanded(null);
    setShowEmpty(false);
  };
  const pick = (name: string) => {
    onChange(name);
    close();
  };

  const query = q.trim().toLowerCase();
  const matches = (e: MetricSchemaEntry) =>
    e.label.toLowerCase().includes(query) || e.name.toLowerCase().includes(query);

  const row = (e: MetricSchemaEntry, label: string, indent = false) => (
    <button
      key={e.name}
      onClick={() => pick(e.name)}
      className={[
        "flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-alt hover:text-accent",
        indent ? "pl-3" : "",
        e.name === value ? "text-accent" : "text-text/90",
      ].join(" ")}
    >
      <span className="truncate">{label}</span>
      {e.name === value && <span className="text-accent">✓</span>}
    </button>
  );

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => (open ? close() : setOpen(true))}
        className="max-w-44 truncate rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text hover:border-accent/40 focus:border-accent/60 focus:outline-none"
        title={currentLabel}
      >
        {currentLabel} <span className="text-text-faint">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface/95 p-2 text-xs shadow-lg backdrop-blur-md">
            <input
              type="text"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") close(); }}
              placeholder="search metrics…"
              className="mb-2 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-faint caret-accent focus:border-accent/80 focus:outline-none"
            />
            <div className="max-h-80 overflow-y-auto">
              {query !== "" ? (
                // Flat direct matches (per-method entries included un-collapsed).
                <>
                  {[...groups, ["no data yet", empty.map((e) => e)] as const].map(([group, entries]) => {
                    const hits = (entries as MetricSchemaEntry[]).filter(matches);
                    if (hits.length === 0) return null;
                    return (
                      <div key={group as string} className="mb-1">
                        <div className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-faint">{group}</div>
                        {hits.map((e) => row(e, e.label))}
                      </div>
                    );
                  })}
                </>
              ) : (
                <>
                  {structured.map(([group, rows]) => (
                    <div key={group} className="mb-1">
                      <div className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-faint">{group}</div>
                      {rows.map((r) => (
                        <div key={r.baseName}>
                          <div className="flex items-center">
                            {r.entry ? (
                              <span className="min-w-0 flex-1">{row(r.entry, r.label)}</span>
                            ) : (
                              <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-text-muted">{r.label}</span>
                            )}
                            {r.children.length > 0 && (
                              <button
                                onClick={() => setExpanded(expanded === r.baseName ? null : r.baseName)}
                                className="shrink-0 rounded px-1.5 py-1 text-text-faint hover:text-accent"
                                title={`${r.children.length} per-method values`}
                              >
                                {expanded === r.baseName ? "▾" : "▸"} {r.children.length}
                              </button>
                            )}
                          </div>
                          {expanded === r.baseName && (
                            <div className="mb-1 ml-2 border-l border-border/60 pl-1">
                              {r.children.map((c) => {
                                const ref = parseMethodMetric(c.name);
                                return row(c, ref?.method ?? c.label, true);
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                  {empty.length > 0 && (
                    <div className="mb-1">
                      <button
                        onClick={() => setShowEmpty(!showEmpty)}
                        className="w-full px-1.5 py-0.5 text-left text-[10px] uppercase tracking-wide text-text-faint hover:text-accent"
                      >
                        {showEmpty ? "▾" : "▸"} no data yet ({empty.length})
                      </button>
                      {showEmpty && empty.map((e) => row(e, e.label))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
