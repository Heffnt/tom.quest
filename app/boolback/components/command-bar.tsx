"use client";

// app/boolback/components/command-bar.tsx
//
// Top bar. LEFT: a breadcrumb of the selected chain (derived from selectedDir,
// which is a cumulative "fn=H/ds=H/tr=H" path). RIGHT: the artifact-dir picker +
// Refresh. There is NO Real|Demo source toggle, NO census checkbox, NO global
// text filter (the tree typeahead replaces it), and NO DAG/Table tab switcher
// (the table is the only center view).

import { useBoolbackStore } from "../state/store";
import { DirPicker } from "./dir-picker";
import type { ArtifactSource } from "../data/source";

interface CommandBarProps {
  source: ArtifactSource;
}

export function CommandBar({ source }: CommandBarProps) {
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const select = useBoolbackStore((s) => s.select);

  // Breadcrumb segments: cumulative path prefixes of the selection.
  const crumbs = buildCrumbs(selectedDir);

  return (
    <div className="h-10 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md flex items-center gap-3 px-3">
      {/* LEFT: breadcrumb of the selected chain */}
      <nav
        aria-label="Selected artifact path"
        className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto font-mono text-xs"
      >
        {crumbs.length === 0 ? (
          <span className="text-text-faint select-none whitespace-nowrap">no selection</span>
        ) : (
          crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={c.path} className="flex items-center gap-1 whitespace-nowrap">
                {i > 0 && (
                  <span className="text-text-faint select-none" aria-hidden>/</span>
                )}
                <button
                  type="button"
                  onClick={() => select(c.path)}
                  title={c.path}
                  aria-current={isLast ? "page" : undefined}
                  className={`rounded px-1 py-0.5 transition-colors hover:text-text hover:bg-surface-alt ${
                    isLast ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {c.label}
                </button>
              </span>
            );
          })
        )}
      </nav>

      {/* RIGHT: artifact-dir picker + refresh */}
      <DirPicker source={source} />
    </div>
  );
}

interface Crumb {
  path: string; // cumulative path prefix
  label: string;
}

// Build cumulative crumbs from a "a/b/c" selection path. Each crumb's label is
// the slug zone of its own dirName ("level+slug+hash" -> slug, else level).
function buildCrumbs(selectedDir: string | null): Crumb[] {
  if (!selectedDir) return [];
  const segments = selectedDir.split("/");
  const out: Crumb[] = [];
  let acc = "";
  for (const seg of segments) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    out.push({ path: acc, label: segLabel(seg) });
  }
  return out;
}

// A path segment is the cumulative-tree form "fn=H" / "ds=H" / "tr=H". Show the
// level token plus a short hash tail so the strip stays compact.
function segLabel(seg: string): string {
  const eq = seg.indexOf("=");
  if (eq < 0) return seg;
  const level = seg.slice(0, eq);
  const hash = seg.slice(eq + 1);
  return hash ? `${level}:${hash.slice(0, 8)}` : level;
}
