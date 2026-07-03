"use client";

// app/boolback/data/source.ts — the data-source layer for /boolback.
//
// ONE fetch: the gzipped snapshot blob, served staleness-tolerant by the
// turing-api cache through the public Next proxy (X-API-Key injected
// server-side; never exposed to the browser):
//
//   GET /api/boolback/blob?dir=…   -> the gzip Bundle (gunzipped client-side)
//
// Freshness comes from bundle.meta.built_at (inside the blob) — there is no
// separate status round-trip. The dir is PINNED to "artifacts" (the one real
// tree); a ?dir= query param overrides it for the rare other root. Snapshots
// are pre-built off-request by an sbatch job (2-hourly cron + admin Refresh),
// so this GET always serves the latest cache instantly — it never blocks on a
// build. An admin (Tom) Refresh additionally submits a rebuild via the
// admin-gated /api/turing POST; a non-admin Refresh just re-fetches.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import type { Bundle } from "../lib/types";
import { asBundle } from "./normalize";

export type SnapshotStatus = "loading" | "ready" | "empty" | "error";

export interface ArtifactSource {
  /** The artifact-tree dir being viewed ("artifacts" unless ?dir= overrides). */
  dir: string;
  /** The loaded bundle (kept during a refresh; null until first load). */
  bundle: Bundle | null;
  status: SnapshotStatus;
  statusDetail: string | null;
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

  const [dir, setDir] = useState("artifacts");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [status, setStatus] = useState<SnapshotStatus>("loading");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);

  const reqId = useRef(0); // guards against stale resolutions across refreshes

  const load = useCallback((d: string) => {
    const mine = ++reqId.current;
    setStatus("loading");
    setStatusDetail(null);
    fetch(`/api/boolback/blob?dir=${encodeURIComponent(d)}`, { cache: "no-store" })
      .then(async (res) => {
        if (mine !== reqId.current) return;
        if (res.status === 404) {
          // No snapshot built for this dir yet (the cron / an admin Refresh will).
          setStatus("empty");
          return;
        }
        if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
        if (!res.body) throw new Error("empty blob response");
        const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(decompressed).text();
        if (mine !== reqId.current) return;
        setBundle(asBundle(JSON.parse(text)));
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (mine !== reqId.current) return;
        setStatus("error");
        setStatusDetail(e instanceof Error ? e.message : "snapshot unavailable");
      });
  }, []);

  // Read the ?dir= override once on mount, then load.
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("dir") || "artifacts";
    setDir(d);
    load(d);
  }, [load]);

  const refresh = useCallback(() => {
    if (canRebuild && token) {
      // Admins additionally submit an sbatch rebuild (the new snapshot appears in
      // a later refresh, once the compute-node job completes ~2min); the latest
      // cache keeps serving meanwhile.
      setRebuildNote("submitting rebuild…");
      fetch(`/api/turing/boolback-snapshot?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { job_id?: string; detail?: string };
          setRebuildNote(
            res.ok
              ? `rebuild submitted${body.job_id ? ` (job ${body.job_id})` : ""} — takes ~2 min`
              : `rebuild failed: ${body.detail ?? res.status}`,
          );
        })
        .catch((e: unknown) => {
          setRebuildNote(`rebuild failed: ${e instanceof Error ? e.message : "error"}`);
        });
    }
    load(dir);
  }, [canRebuild, token, dir, load]);

  return { dir, bundle, status, statusDetail, canRebuild, rebuildNote, refresh };
}
