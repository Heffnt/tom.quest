"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import { useAuth } from "../auth";
import { debug } from "../debug";

interface UseTuringOptions {
  refreshInterval?: number;
}

interface UseTuringResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

interface UseTuringMutationResult<TBody, TResponse> {
  trigger: (body: TBody) => Promise<TResponse | null>;
  loading: boolean;
  error: string | null;
}

const turingLog = debug.scoped("turing");
const TURING_SUCCESS_DEDUPE_MS = 120_000;
const turingStateSnapshot: Record<string, unknown> = {
  lastPath: "none",
  lastStatus: null,
  lastError: null,
};

debug.registerState("turing", () => turingStateSnapshot);

function updateTuringState(path: string, status: number | null, error: string | null) {
  turingStateSnapshot.lastPath = path;
  turingStateSnapshot.lastStatus = status;
  turingStateSnapshot.lastError = error;
}

function truncateMessage(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function buildFetcher(userId: string | undefined) {
  return async (url: string) => {
    const done = turingLog.req(`GET ${url}`, undefined, {
      dedupeSuccessForMs: TURING_SUCCESS_DEDUPE_MS,
      defer: true,
    });
    const headers: Record<string, string> = {};
    if (userId) headers["x-user-id"] = userId;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      updateTuringState(url, null, message);
      done.error(message);
      throw error instanceof Error ? error : new Error(message);
    }
    if (!res.ok) {
      const text = await res.text();
      const message = truncateMessage(text || `Request failed: ${res.status}`);
      updateTuringState(url, res.status, message);
      done.error(message, { status: res.status });
      throw new Error(message);
    }
    try {
      const data = await res.json();
      updateTuringState(url, res.status, null);
      done({ status: res.status });
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON response";
      updateTuringState(url, res.status, message);
      done.error("invalid JSON response", { status: res.status, error: truncateMessage(message) });
      throw error instanceof Error ? error : new Error(message);
    }
  };
}

export function useTuring<T>(path: string, options?: UseTuringOptions): UseTuringResult<T> {
  const { user } = useAuth();
  const swr = useSWR<T>(
    "/api/turing" + path,
    buildFetcher(user?.id),
    options?.refreshInterval
      ? { refreshInterval: options.refreshInterval * 1000 }
      : undefined,
  );
  return {
    data: swr.data ?? null,
    error: swr.error ? (swr.error instanceof Error ? swr.error.message : String(swr.error)) : null,
    loading: swr.isLoading,
    refresh: () => { void swr.mutate(); },
  };
}

export function useTuringMutation<TBody, TResponse>(
  path: string,
  method: "POST" | "DELETE" = "POST",
): UseTuringMutationResult<TBody, TResponse> {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = useCallback(async (body: TBody): Promise<TResponse | null> => {
    setLoading(true);
    setError(null);
    const url = "/api/turing" + path;
    const done = turingLog.req(`${method} ${url}`, undefined, { defer: true });
    let loggedError = false;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (user?.id) headers["x-user-id"] = user.id;
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        const message = truncateMessage(text || `Request failed: ${res.status}`);
        updateTuringState(url, res.status, message);
        done.error(message, { status: res.status });
        loggedError = true;
        throw new Error(message);
      }
      const payload = (await res.json()) as TResponse;
      updateTuringState(url, res.status, null);
      done({ status: res.status });
      return payload;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      if (!loggedError) {
        updateTuringState(url, null, message);
        done.error(message);
      }
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [user, path, method]);

  return { trigger, loading, error };
}
