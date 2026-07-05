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
//
// THE PAGE MUST LOAD EVEN WHEN TURING IS DOWN (the whole cluster goes away
// for days at a time, and this site is iterated on in production). When the
// blob fetch fails, fall back in order:
//   1. the last good blob, cached in this browser (Cache API, one entry per
//      dir URL, written after every successful parse);
//   2. the bundled sample snapshot (dynamic import — only fetched on demand);
//   3. only if BOTH are unavailable, surface the error screen.
// `origin` says which source the current bundle came from so the UI can
// banner anything that is not live data.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import type { Bundle } from "../lib/types";
import { asBundle } from "./normalize";

export type SnapshotStatus = "loading" | "ready" | "empty" | "error";
export type SnapshotOrigin = "live" | "cache" | "sample";

// ----- last-good blob cache (Cache API; survives reloads, per-browser) -----

const BLOB_CACHE = "boolback-blob-v1";

async function gunzipJson(buf: ArrayBuffer): Promise<unknown> {
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as unknown;
}

async function readCachedBlob(url: string): Promise<Bundle | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(BLOB_CACHE);
    const hit = await cache.match(url);
    if (!hit) return null;
    return asBundle(await gunzipJson(await hit.arrayBuffer()));
  } catch {
    return null; // corrupt/stale entry or private-mode restrictions — treat as miss
  }
}

async function writeCachedBlob(url: string, buf: ArrayBuffer): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(BLOB_CACHE);
    await cache.put(
      url,
      new Response(buf, { headers: { "content-type": "application/gzip" } }),
    );
  } catch {
    // quota / private mode — losing the cache only loses the offline fallback
  }
}

async function loadSampleBundle(): Promise<Bundle> {
  const mod = await import("./sample-snapshot.json");
  return asBundle(mod.default);
}

export interface ArtifactSource {
  /** The artifact-tree dir being viewed ("artifacts" unless ?dir= overrides). */
  dir: string;
  /** The loaded bundle (kept during a refresh; null until first load). */
  bundle: Bundle | null;
  /** Where the current bundle came from (live fetch / browser cache / sample). */
  origin: SnapshotOrigin;
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
  const [origin, setOrigin] = useState<SnapshotOrigin>("live");
  const [status, setStatus] = useState<SnapshotStatus>("loading");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);

  const reqId = useRef(0); // guards against stale resolutions across refreshes
  const hasBundle = useRef(false); // lets load() see "already showing data" without re-binding
  hasBundle.current = bundle !== null;

  const load = useCallback((d: string) => {
    const mine = ++reqId.current;
    setStatus("loading");
    setStatusDetail(null);
    const url = `/api/boolback/blob?dir=${encodeURIComponent(d)}`;
    (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (mine !== reqId.current) return;
        if (res.status === 404) {
          // Turing IS reachable — there is genuinely no snapshot for this dir
          // yet (the cron / an admin Refresh will build one). Not a fallback case.
          setStatus("empty");
          return;
        }
        if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const parsed = asBundle(await gunzipJson(buf));
        if (mine !== reqId.current) return;
        setBundle(parsed);
        setOrigin("live");
        setStatus("ready");
        void writeCachedBlob(url, buf); // only after a successful parse
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : "snapshot unavailable";
        // A bundle is already on screen (this was a refresh): keep showing it —
        // never replace real data with a fallback. The status dot goes error.
        if (hasBundle.current) {
          if (mine !== reqId.current) return;
          setStatus("error");
          setStatusDetail(detail);
          return;
        }
        // First load failed: last good cached blob, then the bundled sample.
        const cached = await readCachedBlob(url);
        if (mine !== reqId.current) return;
        if (cached) {
          setBundle(cached);
          setOrigin("cache");
          setStatus("ready");
          setStatusDetail(detail);
          return;
        }
        try {
          const sample = await loadSampleBundle();
          if (mine !== reqId.current) return;
          setBundle(sample);
          setOrigin("sample");
          setStatus("ready");
          setStatusDetail(detail);
        } catch {
          if (mine !== reqId.current) return;
          setStatus("error");
          setStatusDetail(detail);
        }
      }
    })();
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

  return { dir, bundle, origin, status, statusDetail, canRebuild, rebuildNote, refresh };
}
