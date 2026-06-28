"use client";

// app/boolback/components/column-group-menu.tsx
//
// Per-group, hover-to-open column dropdowns driven by Bundle.column_groups. One
// trigger button per group (FUNCTION / DATASET / TRAINING / OUTCOME / DEFENSE /
// INTERP / SCAN); hovering opens a checkbox list of that group's columns so the
// user can toggle visibility. The popover does NOT repeat the group name as a
// header (the trigger already says it).
//
// Visibility is the store's visibleCols (internal column ids). Each menu entry
// resolves its bare column_groups name -> internal id via resolveColumn so the
// checkbox state and the table read the same id.

import { useRef, useState } from "react";
import type { Bundle, MetricSchemaEntry } from "../lib/types";
import { resolveColumn, type ColumnDef } from "../lib/columns";

interface ColumnGroupMenuProps {
  bundle: Bundle;
  index: Record<string, MetricSchemaEntry>;
  visibleCols: string[];
  setVisibleCols: (cols: string[]) => void;
}

export function ColumnGroupMenu({
  bundle,
  index,
  visibleCols,
  setVisibleCols,
}: ColumnGroupMenuProps) {
  const visibleSet = new Set(visibleCols);

  const toggle = (def: ColumnDef) => {
    if (visibleSet.has(def.id)) {
      setVisibleCols(visibleCols.filter((c) => c !== def.id));
    } else {
      // Insert in builder order: rebuild visibleCols by walking all defs and
      // keeping any that are either already visible or the just-toggled one.
      const wanted = new Set(visibleCols);
      wanted.add(def.id);
      const ordered: string[] = [];
      for (const grp of bundle.column_groups) {
        for (const colName of grp.columns) {
          const d = resolveColumn(grp.group, colName, index);
          if (wanted.has(d.id)) ordered.push(d.id);
        }
      }
      setVisibleCols(ordered);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {bundle.column_groups.map((grp) => (
        <GroupButton
          key={grp.group}
          group={grp.group}
          defs={grp.columns.map((c) => resolveColumn(grp.group, c, index))}
          visibleSet={visibleSet}
          toggle={toggle}
        />
      ))}
    </div>
  );
}

function GroupButton({
  group,
  defs,
  visibleSet,
  toggle,
}: {
  group: string;
  defs: ColumnDef[];
  visibleSet: Set<string>;
  toggle: (def: ColumnDef) => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  const activeCount = defs.filter((d) => visibleSet.has(d.id)).length;

  return (
    <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={[
          "rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-wide transition-colors",
          activeCount > 0
            ? "border-accent/50 text-text"
            : "border-border text-text-muted hover:text-text hover:border-accent/40",
        ].join(" ")}
      >
        {group}
        {activeCount > 0 && <span className="ml-1 text-accent tabular-nums">{activeCount}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-border bg-surface/95 p-2 text-sm shadow-lg backdrop-blur-md animate-settle">
          {defs.map((def) => (
            <label
              key={def.id}
              className="flex cursor-pointer items-center gap-2 py-0.5 text-text/90 hover:text-accent"
            >
              <input
                type="checkbox"
                checked={visibleSet.has(def.id)}
                onChange={() => toggle(def)}
                className="accent-accent"
              />
              <span className="flex-1 truncate">{def.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
