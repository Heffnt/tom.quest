"use client";

// app/boolback/components/command-bar.tsx — the top strip.
//
// Left: page name + the current tree selection (breadcrumb). Middle: the
// at-a-glance tree stats (runs [ⓘ what is a run?] / functions / planted /
// coverage of the optional families). Right: the Table|Chart view switcher
// (store-owned), share-link copy, snapshot freshness ("built 2h ago", from
// the blob's own meta — no status round-trip), and Refresh (admins also
// submit a Turing rebuild).
//
// The artifact dir is PINNED to "artifacts" (a ?dir= query param overrides
// it) — there is no picker.

import { useMemo, useState } from "react";
import type { ArtifactSource } from "../data/source";
import { useBoolbackStore } from "../state/store";
import { relTime, thousands } from "../lib/format";
import { plantedThreshold } from "../lib/types";
import { buildShareUrl } from "../lib/share";
import { copyText } from "../lib/export";
import { RunInfo } from "./run-info";

function Stat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={title}>
      <span className="font-mono text-xs text-text">{value}</span>
      <span className="text-[11px] text-text-muted">{label}</span>
    </span>
  );
}

export function CommandBar({ source }: { source: ArtifactSource }) {
  const bundle = source.bundle;
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const view = useBoolbackStore((s) => s.centerView);
  const setView = useBoolbackStore((s) => s.setCenterView);
  const [copied, setCopied] = useState(false);

  const threshold = plantedThreshold(bundle?.meta);

  const stats = useMemo(() => {
    if (!bundle) return null;
    const rows = bundle.rows;
    let planted = 0, defense = 0, interp = 0, scan = 0, inProgress = 0;
    for (const r of rows) {
      if (r.status.planted) planted++;
      if (r.status.has_defense) defense++;
      if (r.status.has_interp) interp++;
      if (r.status.has_scan) scan++;
      if (r.status.in_progress) inProgress++;
    }
    return {
      runs: rows.length,
      functions: Object.keys(bundle.functions).length,
      planted,
      plantedPct: rows.length ? Math.round((100 * planted) / rows.length) : 0,
      defense, interp, scan, inProgress,
    };
  }, [bundle]);

  const copyLink = async () => {
    const s = useBoolbackStore.getState();
    const url = buildShareUrl({
      filters: s.filters,
      sorts: s.sorts,
      visibleCols: s.visibleCols,
      chart: s.chart,
      view: s.centerView,
    });
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface/60 px-3 overflow-x-auto">
      <span className="font-mono text-sm text-accent shrink-0">boolback</span>
      {selectedDir && (
        <span
          className="hidden lg:inline max-w-56 truncate font-mono text-[11px] text-text-faint"
          title={selectedDir}
        >
          {selectedDir}
        </span>
      )}

      {stats && (
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <Stat value={thousands(stats.runs)} label="runs" />
            <RunInfo plantedThreshold={threshold} />
          </span>
          <Stat value={thousands(stats.functions)} label="functions" />
          <Stat
            value={`${stats.plantedPct}%`}
            label="planted"
            title={`${thousands(stats.planted)} of ${thousands(stats.runs)} runs at plantedness ≥ ${threshold}`}
          />
          <Stat value={thousands(stats.defense)} label="defended" />
          {stats.interp > 0 && <Stat value={thousands(stats.interp)} label="interp" />}
          {stats.scan > 0 && <Stat value={thousands(stats.scan)} label="scanned" />}
          {stats.inProgress > 0 && (
            <Stat value={thousands(stats.inProgress)} label="in progress" />
          )}
        </span>
      )}

      <span className="flex-1" />

      {/* Table | Chart view switcher */}
      <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
        {(["table", "chart"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`px-2.5 py-0.5 transition-colors ${
              view === v ? "bg-accent/15 text-accent" : "bg-surface text-text-muted hover:text-text"
            }`}
          >
            {v === "table" ? "Table" : "Chart"}
          </button>
        ))}
      </div>

      {/* shareable view URL (filters + sorts + columns + chart + view) */}
      <button
        type="button"
        onClick={() => void copyLink()}
        className="shrink-0 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 whitespace-nowrap transition-colors"
        title="Copy a link that reproduces exactly this view (filters, sort, columns, chart)"
      >
        {copied ? "copied ✓" : "⧉ Copy link"}
      </button>

      {bundle && (
        <span
          className="shrink-0 text-[11px] text-text-faint whitespace-nowrap"
          title={`snapshot built ${bundle.meta.built_at} from ${bundle.meta.source_dir}`}
        >
          built {relTime(bundle.meta.built_at)}
        </span>
      )}
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          source.status === "ready"
            ? "bg-success"
            : source.status === "loading"
              ? "bg-warning animate-pulse"
              : "bg-error"
        }`}
        title={`snapshot: ${source.status}`}
      />
      <button
        type="button"
        onClick={source.refresh}
        className="shrink-0 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 whitespace-nowrap transition-colors"
        title={
          source.canRebuild
            ? "Re-fetch the latest snapshot AND submit a rebuild on Turing (~2 min)"
            : "Re-fetch the latest snapshot"
        }
      >
        ↻ Refresh
      </button>
      {source.rebuildNote && (
        <span className="shrink-0 text-[11px] text-text-faint whitespace-nowrap">
          {source.rebuildNote}
        </span>
      )}
    </div>
  );
}
