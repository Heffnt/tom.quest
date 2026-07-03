"use client";

// app/boolback/components/artifact-browser.tsx — raw on-disk artifacts, in the
// detail panel. EVERYTHING a run wrote is reachable from here without being
// projected into the snapshot: epoch dirs, inference/scoring nodes, configs,
// done.json, outputs.jsonl / verdicts.jsonl previews.
//
// Backed by two public read-only proxies (jailed server-side to the CMT output
// root): /api/boolback/node lists one dir level; /api/boolback/file previews a
// text file (size-capped; model weights return metadata only). Navigation is
// free within the jail, so walking UP from a training dir to its dataset /
// function configs works too.

import { useCallback, useEffect, useState } from "react";
import type { FilePreview, NodeListing } from "../lib/types";
import { humanSize } from "../lib/format";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new Error(body?.error ?? body?.detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Pretty-print JSON / JSONL content when it parses; raw text otherwise. */
function prettify(name: string, content: string): string {
  try {
    if (name.endsWith(".jsonl")) {
      return content
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!t) return "";
          try {
            return JSON.stringify(JSON.parse(t));
          } catch {
            return line;
          }
        })
        .join("\n");
    }
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function ArtifactBrowser({ root }: { root: string }) {
  const [path, setPath] = useState(root);
  const [listing, setListing] = useState<NodeListing | null>(null);
  const [file, setFile] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPath(root);
    setFile(null);
  }, [root]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<NodeListing>(`/api/boolback/node?path=${encodeURIComponent(path)}`)
      .then((l) => {
        if (!cancelled) setListing(l);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to list dir");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const openFile = useCallback((name: string) => {
    setLoading(true);
    setError(null);
    getJson<FilePreview>(`/api/boolback/file?path=${encodeURIComponent(`${name}`)}`)
      .then(setFile)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "failed to read file"))
      .finally(() => setLoading(false));
  }, []);

  // Breadcrumb over the listing's normalized path (relative to the CMT root).
  const segments = (listing?.path ?? path).split("/").filter(Boolean);

  return (
    <div className="font-mono text-[11px]">
      {/* breadcrumb */}
      <div className="mb-1.5 flex flex-wrap items-center gap-0.5 text-text-faint">
        {segments.map((seg, i) => {
          const target = segments.slice(0, i + 1).join("/");
          const last = i === segments.length - 1;
          return (
            <span key={target} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && <span>/</span>}
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setPath(target);
                }}
                title={target}
                className={`max-w-40 truncate ${last && !file ? "text-text/90" : "hover:text-accent"}`}
              >
                {seg}
              </button>
            </span>
          );
        })}
        {file && (
          <span className="flex items-center gap-0.5">
            <span>/</span>
            <span className="text-text/90">{file.path.split("/").pop()}</span>
          </span>
        )}
      </div>

      {error && <p className="py-1 text-error">{error}</p>}
      {loading && <p className="py-1 text-text-faint">loading…</p>}

      {/* file preview */}
      {!loading && file && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-text-faint">
            <button type="button" onClick={() => setFile(null)} className="hover:text-accent">
              ← back
            </button>
            <span>
              {humanSize(file.size)}
              {file.truncated && " · truncated preview"}
              {file.binary && " · binary — not previewable"}
            </span>
          </div>
          {file.content !== null && (
            <pre className="max-h-80 overflow-auto rounded border border-border/60 bg-surface-alt/40 p-2 text-[10.5px] leading-snug text-text/90 whitespace-pre-wrap break-all">
              {prettify(file.path, file.content)}
            </pre>
          )}
        </div>
      )}

      {/* dir listing */}
      {!loading && !file && listing && (
        <div className="space-y-0.5">
          {listing.dirs.length === 0 && listing.files.length === 0 && (
            <p className="text-text-faint">empty dir.</p>
          )}
          {listing.dirs.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPath(`${listing.path}/${d}`)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
            >
              <span className="text-text-faint">▸</span>
              <span className="truncate">{d}/</span>
            </button>
          ))}
          {listing.files.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => openFile(`${listing.path}/${f.name}`)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-text-muted hover:bg-surface-alt hover:text-accent"
            >
              <span className="w-2.5" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-text-faint">{humanSize(f.size)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
