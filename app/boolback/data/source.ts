"use client";

// app/boolback/data/source.ts
//
// The data-source layer for /boolback. boolback is PUBLIC viewing — no login
// required — so the GET endpoints go through dedicated PUBLIC Next proxies that
// inject the X-API-Key server-side (the key is never exposed to the browser):
//
//   GET /api/boolback/dirs?path=…      -> list child dirs under the pinned CMT root
//   GET /api/boolback/snapshot?dir=…   -> staleness-tolerant envelope
//                                         {status:"ready"|"empty"|"error", meta:{built_at,stale,…}}
//   GET /api/boolback/blob?dir=…       -> the gzip Bundle (gunzipped client-side)
//
// Snapshots are pre-built off-request by an sbatch job (periodic + admin Refresh),
// so GET always serves the LATEST cached snapshot instantly — it never blocks on a
// build. An admin (Tom) Refresh additionally submits a rebuild via the admin-gated
// /api/turing POST; a non-admin Refresh just re-fetches the latest snapshot.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import type { Bundle } from "../lib/types";
import { asBundle } from "./real";

export interface CmtDirEntry {
  name: string;
  path: string;
}

interface CmtDirsResponse {
  path: string;
  dirs: Array<string | CmtDirEntry> | null;
  error?: string | null;
}

// The upstream /cmt-dirs returns dir NAMES as a string[] (e.g. ["artifacts","tidy"]);
// some shapes may send {name,path}. Normalize both into CmtDirEntry[], pairing each name
// with the response's absolute root path (which the snapshot/blob endpoints accept as the
// dir param), and drop any empty entry so the dropdown never renders a blank row.
function normalizeDirs(resp: CmtDirsResponse): CmtDirEntry[] {
  const parent = (resp.path ?? "").replace(/\/+$/, "");
  return (resp.dirs ?? [])
    .map((d) => {
      if (typeof d === "string") {
        return { name: d, path: parent ? `${parent}/${d}` : d };
      }
      const name = d.name ?? (d.path ? d.path.slice(d.path.lastIndexOf("/") + 1) : "");
      const path = d.path ?? (parent ? `${parent}/${name}` : name);
      return { name, path };
    })
    .filter((e) => e.name);
}

export type SnapshotStatus = "idle" | "loading" | "ready" | "empty" | "error";

interface SnapshotEnvelope {
  status: "ready" | "empty" | "error";
  schema_version?: number;
  meta?: {
    built_at?: number;
    stale?: boolean;
    tree_mtime_key?: number;
    cache_mtime_key?: number;
  };
  blobPath?: string;
  detail?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Fetch + gunzip + validate the latest Bundle for a dir (public binary proxy). */
async function loadBlob(dir: string): Promise<Bundle> {
  const res = await fetch(`/api/boolback/blob?dir=${encodeURIComponent(dir)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `failed to fetch blob: ${res.status}`);
  }
  if (!res.body) throw new Error("empty blob response");
  const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return asBundle(JSON.parse(text));
}

export interface ArtifactSource {
  /** Picker: child dirs under the CMT root. */
  dirs: CmtDirEntry[];
  dirsLoading: boolean;
  dirsError: string | null;
  reloadDirs: () => void;
  /** Currently selected artifact-tree root dir (null => none chosen yet). */
  selectedDir: string | null;
  selectDir: (dir: string | null) => void;
  /** The loaded bundle for the selected dir (null until ready). */
  bundle: Bundle | null;
  status: SnapshotStatus;
  statusDetail: string | null;
  /** True when the served snapshot predates the tree's current state. */
  stale: boolean;
  /** When the served snapshot was built (epoch seconds), or null. */
  builtAt: number | null;
  /** Whether this viewer can trigger an on-demand rebuild (admin/Tom). */
  canRebuild: boolean;
  /** Note from the last rebuild submission (job id / error), or null. */
  rebuildNote: string | null;
  /** Re-fetch the latest snapshot; admins also submit a rebuild sbatch. */
  refresh: () => void;
}

export function useArtifactSource(): ArtifactSource {
  const { isAdmin, isTom, token } = useAuth();
  const canRebuild = isAdmin || isTom;

  const [dirs, setDirs] = useState<CmtDirEntry[]>([]);
  const [dirsLoading, setDirsLoading] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [status, setStatus] = useState<SnapshotStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);

  const reqId = useRef(0); // guards against stale resolutions across dir switches
  const didAutoSelect = useRef(false); // one-shot default selection after dirs load

  // ---- picker (public) --------------------------------------------------
  const reloadDirs = useCallback(() => {
    setDirsLoading(true);
    setDirsError(null);
    getJson<CmtDirsResponse>("/api/boolback/dirs")
      .then((r) => setDirs(normalizeDirs(r)))
      .catch((e: unknown) =>
        setDirsError(e instanceof Error ? e.message : "failed to list dirs"),
      )
      .finally(() => setDirsLoading(false));
  }, []);

  useEffect(() => {
    reloadDirs();
  }, [reloadDirs]);

  // ---- load the latest snapshot for a dir (public) ----------------------
  const loadStatus = useCallback((dir: string, mine: number) => {
    setStatus("loading");
    setStatusDetail(null);

    // Freshness envelope — NON-gating. The status endpoint globs done.json over the
    // whole (~700GB) artifact tree and can exceed the proxy timeout, so we never make
    // the bundle wait on it; it only annotates stale/builtAt when (if) it arrives. The
    // blob below is the source of truth for "do we have data".
    const statusP = getJson<SnapshotEnvelope>(
      `/api/boolback/snapshot?dir=${encodeURIComponent(dir)}`,
    );
    statusP
      .then((env) => {
        if (mine !== reqId.current) return;
        if (env.status === "ready") {
          setStale(Boolean(env.meta?.stale));
          setBuiltAt(env.meta?.built_at ?? null);
        }
      })
      .catch(() => undefined); // a slow/failed status never breaks rendering

    // The actual snapshot. Fast (never walks the big tree); rendered as soon as it
    // resolves, in parallel with — not gated behind — the status envelope above.
    loadBlob(dir)
      .then((b) => {
        if (mine !== reqId.current) return;
        setBundle(b);
        setStatus("ready");
      })
      .catch(async () => {
        if (mine !== reqId.current) return;
        // No usable blob — distinguish "no snapshot yet" (empty) from a real error,
        // consulting the status envelope if it resolved.
        const env = await statusP.catch(() => undefined);
        if (mine !== reqId.current) return;
        if (env?.status === "empty") {
          setStatus("empty");
          setStatusDetail(null);
        } else {
          setStatus("error");
          setStatusDetail(env?.detail ?? "snapshot unavailable");
        }
      });
  }, []);

  const selectDir = useCallback(
    (dir: string | null) => {
      const mine = ++reqId.current;
      setSelectedDir(dir);
      setBundle(null);
      setStatusDetail(null);
      setStale(false);
      setBuiltAt(null);
      setRebuildNote(null);
      if (!dir) {
        setStatus("idle");
        return;
      }
      loadStatus(dir, mine);
    },
    [loadStatus],
  );

  // Default the picker to the "artifacts" tree once dirs load (else the first dir), so
  // the page shows data without a manual pick. Pure name match — NOT a /snapshot probe
  // (the only populated dir's status can time out; see loadStatus). Fires once and never
  // overrides an explicit selection.
  useEffect(() => {
    if (didAutoSelect.current) return;
    if (selectedDir !== null) {
      didAutoSelect.current = true;
      return;
    }
    if (dirs.length === 0) return;
    const preferred = dirs.find((d) => d.name === "artifacts") ?? dirs[0];
    didAutoSelect.current = true;
    selectDir(preferred.path);
  }, [dirs, selectedDir, selectDir]);

  const refresh = useCallback(() => {
    const dir = selectedDir;
    if (!dir) return;
    const mine = ++reqId.current;
    // Admins additionally submit an sbatch rebuild (the new snapshot appears in a
    // later refresh, once the compute-node job completes); the latest cache keeps
    // serving meanwhile. Non-admins just re-fetch the latest snapshot.
    if (canRebuild && token) {
      setRebuildNote("submitting rebuild…");
      fetch(`/api/turing/boolback-snapshot?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { job_id?: string; detail?: string };
          if (mine !== reqId.current) return;
          setRebuildNote(
            res.ok
              ? `rebuild submitted${body.job_id ? ` (job ${body.job_id})` : ""}`
              : `rebuild failed: ${body.detail ?? res.status}`,
          );
        })
        .catch((e: unknown) => {
          if (mine !== reqId.current) return;
          setRebuildNote(`rebuild failed: ${e instanceof Error ? e.message : "error"}`);
        });
    }
    loadStatus(dir, mine);
  }, [selectedDir, canRebuild, token, loadStatus]);

  return {
    dirs,
    dirsLoading,
    dirsError,
    reloadDirs,
    selectedDir,
    selectDir,
    bundle,
    status,
    statusDetail,
    stale,
    builtAt,
    canRebuild,
    rebuildNote,
    refresh,
  };
}
