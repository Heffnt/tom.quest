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
  dirs: CmtDirEntry[];
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

  // ---- picker (public) --------------------------------------------------
  const reloadDirs = useCallback(() => {
    setDirsLoading(true);
    setDirsError(null);
    getJson<CmtDirsResponse>("/api/boolback/dirs")
      .then((r) => setDirs(r.dirs ?? []))
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
    getJson<SnapshotEnvelope>(`/api/boolback/snapshot?dir=${encodeURIComponent(dir)}`)
      .then((env) => {
        if (mine !== reqId.current) return;
        if (env.status === "ready") {
          setStale(Boolean(env.meta?.stale));
          setBuiltAt(env.meta?.built_at ?? null);
          loadBlob(dir)
            .then((b) => {
              if (mine !== reqId.current) return;
              setBundle(b);
              setStatus("ready");
            })
            .catch((e: unknown) => {
              if (mine !== reqId.current) return;
              setStatus("error");
              setStatusDetail(e instanceof Error ? e.message : "blob load failed");
            });
        } else if (env.status === "empty") {
          setStatus("empty");
          setStatusDetail(null);
        } else {
          setStatus("error");
          setStatusDetail(env.detail ?? "snapshot error");
        }
      })
      .catch((e: unknown) => {
        if (mine !== reqId.current) return;
        setStatus("error");
        setStatusDetail(e instanceof Error ? e.message : "snapshot request failed");
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
      if (dir === null) {
        setStatus("idle");
        return;
      }
      loadStatus(dir, mine);
    },
    [loadStatus],
  );

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
