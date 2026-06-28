"use client";

// app/boolback/components/dir-picker.tsx
//
// The artifact-tree ROOT chooser + Refresh, mounted in the CommandBar. It is
// SEPARATE from the left tree-nav panel: this picks WHICH top-level CMT output
// dir the whole view is built from; the tree panel then navigates WITHIN that
// dir's snapshot.
//
// A hover/click dropdown lists the child dirs under the pinned CMT root
// (public GET /api/boolback/dirs). Selecting one loads the latest snapshot
// (ready / empty / error). Snapshots are pre-built off-request (sbatch), so the
// page never blocks on a build; Refresh re-fetches the latest (admins also submit
// a rebuild). All state is owned by the parent's useArtifactSource() (props).

import { useRef, useState } from "react";
import type { ArtifactSource } from "../data/source";

export interface DirPickerProps {
  source: ArtifactSource;
}

function shortDir(path: string | null): string {
  if (!path) return "choose artifact dir";
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function DirPicker({ source }: DirPickerProps) {
  const {
    dirs, dirsLoading, dirsError, reloadDirs,
    selectedDir, selectDir, status, statusDetail, refresh,
    stale, builtAt, canRebuild, rebuildNote,
  } = source;

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const leave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* picker */}
      <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            if (!open && dirs.length === 0 && !dirsLoading) reloadDirs();
          }}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 h-7 font-mono text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors max-w-[18rem]"
          title={selectedDir ?? "choose an artifact-tree root"}
        >
          <span className="text-accent shrink-0" aria-hidden>◧</span>
          <span className="truncate">{shortDir(selectedDir)}</span>
          <span className="text-text-faint shrink-0" aria-hidden>▾</span>
        </button>

        {open && (
          <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-surface/95 backdrop-blur-md p-2 text-sm shadow-lg animate-settle">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wide text-text-faint font-mono">
                artifact roots
              </span>
              <button
                type="button"
                onClick={reloadDirs}
                className="text-[10px] text-text-muted hover:text-accent font-mono"
              >
                {dirsLoading ? "…" : "reload"}
              </button>
            </div>

            {dirsError && (
              <div className="mb-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                {dirsError}
              </div>
            )}

            <div className="max-h-72 overflow-y-auto">
              {dirsLoading && dirs.length === 0 && (
                <div className="px-1 py-2 text-[11px] text-text-faint">loading dirs…</div>
              )}
              {!dirsLoading && dirs.length === 0 && !dirsError && (
                <div className="px-1 py-2 text-[11px] text-text-faint">no dirs found</div>
              )}
              {dirs.map((d) => {
                const active = d.path === selectedDir;
                return (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => {
                      selectDir(d.path);
                      setOpen(false);
                    }}
                    title={d.path}
                    className={[
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px]",
                      active ? "bg-surface-alt text-accent" : "text-text/90 hover:bg-surface-alt hover:text-accent",
                    ].join(" ")}
                  >
                    <span className="text-text-faint shrink-0" aria-hidden>◧</span>
                    <span className="truncate">{d.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* status + refresh */}
      <StatusPill
        status={status}
        detail={statusDetail}
        stale={stale}
        builtAt={builtAt}
        rebuildNote={rebuildNote}
      />
      <button
        type="button"
        onClick={refresh}
        disabled={!selectedDir || status === "loading"}
        className="rounded-md border border-border bg-surface px-2.5 h-7 font-mono text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title={
          canRebuild
            ? "Re-fetch the latest snapshot and submit a fresh rebuild (sbatch)"
            : "Re-fetch the latest snapshot"
        }
      >
        {status === "loading" ? "…" : "↻ Refresh"}
      </button>
    </div>
  );
}

function ago(builtAt: number | null): string {
  if (!builtAt) return "";
  const mins = Math.max(0, Math.round(Date.now() / 1000 - builtAt) / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const h = mins / 60;
  return h < 24 ? `${h.toFixed(h < 10 ? 1 : 0)}h ago` : `${Math.round(h / 24)}d ago`;
}

function StatusPill({
  status, detail, stale, builtAt, rebuildNote,
}: {
  status: ArtifactSource["status"];
  detail: string | null;
  stale: boolean;
  builtAt: number | null;
  rebuildNote: string | null;
}) {
  if (status === "idle") return null;
  const note = rebuildNote ? (
    <span className="font-mono text-[10px] text-text-faint whitespace-nowrap">· {rebuildNote}</span>
  ) : null;

  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-text-muted whitespace-nowrap">
        <span className="h-2 w-2 rounded-full border border-border border-t-accent animate-spin" aria-hidden />
        loading…
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className={`font-mono text-[10px] ${stale ? "text-warning" : "text-success"}`}>
          {stale ? "◐ stale" : "● ready"}
          {builtAt ? ` · built ${ago(builtAt)}` : ""}
        </span>
        {note}
      </span>
    );
  }
  if (status === "empty") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-mono text-[10px] text-text-muted">○ no snapshot yet</span>
        {note}
      </span>
    );
  }
  // error
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10px] text-warning max-w-[16rem] truncate"
      title={detail ?? "error"}
      role="status"
    >
      ▲ {detail ?? "error"}
    </span>
  );
}

export default DirPicker;
