"use client";

// app/boolback/data/source.ts
//
// The live data-source layer for /boolback. It talks to the admin-gated Next
// proxies that front the turing-api:
//
//   GET  /api/turing/cmt-dirs?path=…        -> list child dirs under the pinned
//                                              CMT output root (the picker).
//   GET  /api/turing/boolback-snapshot?dir= -> tri-state envelope
//                                              {status:"ready"|"building"|"error",…}.
//   POST /api/turing/boolback-snapshot?dir= -> kick a rebuild (daemon thread).
//   GET  /api/turing-blob/boolback-snapshot-blob?dir= -> the gzip Bundle blob,
//        streamed through the SEPARATE binary proxy (the JSON catch-all rejects
//        non-application/json), gunzipped client-side exactly like data/real.ts.
//
// The bearer token comes from useAuth(); the proxy enforces requireAdmin. This
// module exposes a single hook, useArtifactSource(), returning the picker list +
// the chosen dir's bundle + a tri-state status + refresh().

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import type { Bundle } from "../lib/types";
import { asBundle } from "./real";

// ---------------------------------------------------------------------------
// Wire types (mirror turing-api responses)
// ---------------------------------------------------------------------------

export interface CmtDirEntry {
  name: string;
  path: string;
}

interface CmtDirsResponse {
  path: string;
  dirs: CmtDirEntry[];
}

export type SnapshotStatus = "idle" | "ready" | "building" | "error";

interface SnapshotEnvelope {
  status: "ready" | "building" | "error";
  schema_version?: number;
  meta?: Bundle["meta"];
  blobPath?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// fetch helpers (bearer-gated, mirror use-turing)
// ---------------------------------------------------------------------------

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch("/api/turing" + path, {
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch("/api/turing" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Fetch + gunzip + validate a Bundle from the binary blob proxy. */
async function loadBlobBundle(blobPath: string, token: string | null): Promise<Bundle> {
  // blobPath is "/boolback-snapshot-blob?dir=…" relative to the turing-api; the
  // SEPARATE binary Next route streams it through unchanged.
  const url = "/api/turing-blob" + blobPath;
  const res = await fetch(url, { headers: authHeaders(token), cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `failed to fetch blob: ${res.status}`);
  }
  if (!res.body) throw new Error("empty blob response");
  const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return asBundle(JSON.parse(text));
}

function dirParam(dir: string): string {
  return `?dir=${encodeURIComponent(dir)}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
  /** Snapshot lifecycle for the selected dir. */
  status: SnapshotStatus;
  statusDetail: string | null;
  /** POST a rebuild + resume polling. */
  refresh: () => void;
}

const POLL_MS = 2500;

export function useArtifactSource(): ArtifactSource {
  const { token } = useAuth();

  const [dirs, setDirs] = useState<CmtDirEntry[]>([]);
  const [dirsLoading, setDirsLoading] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [status, setStatus] = useState<SnapshotStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0); // guards against stale resolutions across dir switches

  const clearPoll = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // ---- picker -----------------------------------------------------------
  const reloadDirs = useCallback(() => {
    setDirsLoading(true);
    setDirsError(null);
    getJson<CmtDirsResponse>("/cmt-dirs", token)
      .then((r) => setDirs(r.dirs ?? []))
      .catch((e: unknown) =>
        setDirsError(e instanceof Error ? e.message : "failed to list dirs"),
      )
      .finally(() => setDirsLoading(false));
  }, [token]);

  useEffect(() => {
    reloadDirs();
  }, [reloadDirs]);

  // ---- snapshot lifecycle for the selected dir --------------------------
  // pollOnce: GET the envelope; ready -> load blob; building -> schedule a
  // re-poll; error -> surface detail. `mine` guards stale dir switches. The
  // recursive re-poll goes through a ref so the callback need not close over
  // itself (which the rules-of-hooks linter forbids).
  const pollRef = useRef<(dir: string, mine: number) => void>(() => {});

  const pollOnce = useCallback(
    (dir: string, mine: number) => {
      getJson<SnapshotEnvelope>("/boolback-snapshot" + dirParam(dir), token)
        .then((env) => {
          if (mine !== reqId.current) return;
          if (env.status === "ready" && env.blobPath) {
            const blobPath = env.blobPath;
            setStatus("building"); // keep spinner until the blob actually loads
            loadBlobBundle(blobPath, token)
              .then((b) => {
                if (mine !== reqId.current) return;
                setBundle(b);
                setStatus("ready");
                setStatusDetail(null);
              })
              .catch((e: unknown) => {
                if (mine !== reqId.current) return;
                setStatus("error");
                setStatusDetail(e instanceof Error ? e.message : "blob load failed");
              });
          } else if (env.status === "building") {
            setStatus("building");
            setStatusDetail(null);
            pollTimer.current = setTimeout(() => pollRef.current(dir, mine), POLL_MS);
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
    },
    [token],
  );

  useEffect(() => {
    pollRef.current = pollOnce;
  }, [pollOnce]);

  const selectDir = useCallback(
    (dir: string | null) => {
      clearPoll();
      const mine = ++reqId.current;
      setSelectedDir(dir);
      setBundle(null);
      setStatusDetail(null);
      if (dir === null) {
        setStatus("idle");
        return;
      }
      setStatus("building");
      pollOnce(dir, mine);
    },
    [clearPoll, pollOnce],
  );

  const refresh = useCallback(() => {
    const dir = selectedDir;
    if (!dir) return;
    clearPoll();
    const mine = ++reqId.current;
    setBundle(null);
    setStatus("building");
    setStatusDetail(null);
    postJson<SnapshotEnvelope>("/boolback-snapshot" + dirParam(dir), token)
      .then(() => {
        if (mine !== reqId.current) return;
        pollOnce(dir, mine);
      })
      .catch((e: unknown) => {
        if (mine !== reqId.current) return;
        setStatus("error");
        setStatusDetail(e instanceof Error ? e.message : "refresh failed");
      });
  }, [selectedDir, clearPoll, pollOnce, token]);

  useEffect(() => () => clearPoll(), [clearPoll]);

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
    refresh,
  };
}
