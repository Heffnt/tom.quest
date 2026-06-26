"use client";

import { useEffect, useRef } from "react";
import { useBoolbackStore } from "../state/store";
import { pathToNode } from "../data/fixture";
import type { FixtureBundle } from "../data/fixture";
import type { DataSource } from "../boolback-client";
import type { SnapshotMeta } from "../data/real";
import type { ViewTab } from "../lib/types";

interface CommandBarProps {
  fixture: FixtureBundle;
  source: DataSource;
  onSourceChange: (s: DataSource) => void;
  meta: SnapshotMeta | null;
  sourceError: string | null;
}

const TABS: { id: ViewTab; label: string }[] = [
  { id: "dag", label: "DAG" },
  { id: "table", label: "Table" },
];

const SOURCES: { id: DataSource; label: string }[] = [
  { id: "real", label: "Real" },
  { id: "demo", label: "Demo" },
];

export function CommandBar({ fixture, source, onSourceChange, meta, sourceError }: CommandBarProps) {
  // The bundle is part of the pinned prop contract; breadcrumb data is read
  // from the module-scope pathToNode cache, so the bundle itself is unused here.
  void fixture;

  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const text = useBoolbackStore((s) => s.filters.text);
  const activeTab = useBoolbackStore((s) => s.activeTab);
  const collapseCensus = useBoolbackStore((s) => s.collapseCensus);

  const select = useBoolbackStore((s) => s.select);
  const setText = useBoolbackStore((s) => s.setText);
  const setActiveTab = useBoolbackStore((s) => s.setActiveTab);
  const setCollapseCensus = useBoolbackStore((s) => s.setCollapseCensus);

  const inputRef = useRef<HTMLInputElement>(null);

  // Breadcrumb segments: ancestors root..selected (inclusive). Empty when nothing selected.
  const crumbs = selectedDir ? pathToNode(selectedDir) : [];

  // '/' focuses the search well from anywhere (ignored while typing in a field);
  // Esc clears the text when the input is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true;
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-10 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md flex items-center gap-3 px-3">
      {/* LEFT: breadcrumb of the selected chain */}
      <nav
        aria-label="Selected artifact path"
        className="flex items-center gap-1 min-w-0 shrink overflow-x-auto font-mono text-xs"
      >
        {crumbs.length === 0 ? (
          <span className="text-text-faint select-none whitespace-nowrap">
            no selection
          </span>
        ) : (
          crumbs.map((dir, i) => {
            const isLast = i === crumbs.length - 1;
            const seg = segLabel(dir);
            return (
              <span key={dir} className="flex items-center gap-1 whitespace-nowrap">
                {i > 0 && (
                  <span className="text-text-faint select-none" aria-hidden>
                    /
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => select(dir)}
                  title={dir}
                  aria-current={isLast ? "page" : undefined}
                  className={`rounded px-1 py-0.5 transition-colors hover:text-text hover:bg-surface-alt ${
                    isLast ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {seg}
                </button>
              </span>
            );
          })
        )}
      </nav>

      {/* CENTER: search well (nav-term mono-input idiom) */}
      <div
        className="font-mono flex items-center gap-2 bg-surface border border-border px-3 h-7 flex-1 min-w-0 focus-within:border-accent/80 transition-colors duration-150 rounded-lg"
        onClick={() => inputRef.current?.focus()}
      >
        <span className="text-accent text-sm select-none leading-none" aria-hidden>
          &gt;
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              if (text) {
                setText("");
              } else {
                inputRef.current?.blur();
              }
            }
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="filter truth-table / slug / hash…"
          aria-label="Filter experiments"
          className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint text-sm"
        />
        {text && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setText("");
              inputRef.current?.focus();
            }}
            aria-label="Clear filter"
            className="text-text-faint hover:text-text text-xs leading-none shrink-0 select-none"
          >
            ✕
          </button>
        )}
      </div>

      {/* RIGHT: source toggle + 2-tab segmented control + collapse-census toggle */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Real | Demo source toggle (same idiom as the DAG/Table control) */}
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label="Data source"
            className="flex items-center bg-surface border border-border rounded-lg p-0.5"
          >
            {SOURCES.map((s) => {
              const active = source === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSourceChange(s.id)}
                  className={`font-mono text-xs px-2.5 py-1 rounded-md transition-colors ${
                    active
                      ? "bg-surface-alt text-accent"
                      : "text-text-muted hover:text-text"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          {/* subtle real source / counts label (only when on Real) */}
          {source === "real" && meta && (
            <span
              className="font-mono text-[10px] text-text-faint max-w-[16rem] truncate hidden lg:inline"
              title={`${meta.source} · ${meta.experimentCount} experiments`}
            >
              {meta.source} · {meta.experimentCount.toLocaleString()} exp
            </span>
          )}
          {sourceError && (
            <span className="font-mono text-[10px] text-warning whitespace-nowrap" role="status">
              {sourceError}
            </span>
          )}
        </div>

        <div
          role="tablist"
          aria-label="Center view"
          className="flex items-center bg-surface border border-border rounded-lg p-0.5"
        >
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`font-mono text-xs px-2.5 py-1 rounded-md transition-colors ${
                  active
                    ? "bg-surface-alt text-accent"
                    : "text-text-muted hover:text-text"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={collapseCensus}
            onChange={(e) => setCollapseCensus(e.target.checked)}
            className="accent-accent cursor-pointer"
          />
          <span className="font-mono">census ×34</span>
        </label>
      </div>
    </div>
  );
}

/**
 * Render the human-readable middle of a node's three-zone dirName for the
 * breadcrumb. `pathKey` is a node.path (cumulative "a/b/c" chain), so we take
 * its trailing segment — the node's own dirName — before splitting the three
 * zones. Group dirs (no '+') render whole; "<level>+<slug>+<hash>" shows the
 * slug zone (falling back to the level), keeping the strip compact.
 */
function segLabel(pathKey: string): string {
  const slash = pathKey.lastIndexOf("/");
  const dir = slash >= 0 ? pathKey.slice(slash + 1) : pathKey;
  const parts = dir.split("+");
  if (parts.length < 2) return dir; // group dir (epoch-2, defenses, …)
  if (parts.length >= 3) return parts[1] || parts[0]; // level+slug+hash -> slug
  return parts[0]; // level+hash (empty slug) -> level
}
