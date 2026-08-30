"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";

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

export type TuringMethod = "GET" | "POST" | "DELETE";

export interface TuringRequestOptions {
  method?: TuringMethod;
  /** Omit entirely to send no request body. `{}` sends an empty JSON object. */
  body?: unknown;
}

function truncateMessage(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Turn a non-OK response from /api/turing into the message the UI shows.
 * The proxy route reports upstream failures as JSON `{ error }`, so that field
 * wins when present; anything else falls back to the raw body. Every path is
 * truncated, because these messages land in narrow dialogs.
 */
async function errorFromResponse(res: Response): Promise<Error> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string") {
        return new Error(truncateMessage(payload.error));
      }
    } catch {
      // Not JSON after all; fall back to the response text.
    }
  }
  return new Error(truncateMessage(text || `Request failed: ${res.status}`));
}

/**
 * The single way this app talks to /api/turing. Every caller — the read hook,
 * the mutation hook, and loops that vary the path per iteration — goes through
 * here, so error parsing and truncation are spelled exactly once. Rejects with
 * an Error whose message is already display-ready.
 */
export async function turingRequest<TResponse>(
  path: string,
  token: string | null,
  options: TuringRequestOptions = {},
): Promise<TResponse> {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = authHeaders(token);
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch("/api/turing" + path, init);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Network error");
  }
  if (!res.ok) throw await errorFromResponse(res);
  try {
    return (await res.json()) as TResponse;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid JSON response");
  }
}

/**
 * `turingRequest` with the signed-in user's token already bound. Use this when
 * the path is not fixed for the lifetime of the component — cancelling a list
 * of jobs, for instance — since a hook cannot be called once per list entry.
 */
export function useTuringRequest(): <TResponse>(
  path: string,
  options?: TuringRequestOptions,
) => Promise<TResponse> {
  const { token } = useAuth();
  return useCallback(
    <TResponse,>(path: string, options?: TuringRequestOptions) =>
      turingRequest<TResponse>(path, token, options),
    [token],
  );
}

/**
 * Fetch a Turing API path through the /api/turing proxy.
 *
 * Pass `null` as the path to skip: the hook issues no request and reports
 * `{ data: null, error: null, loading: false }`. Use this whenever part of the
 * path is still resolving (an id coming from a Convex query, a route param).
 * Never substitute a placeholder segment for a missing id — the API answers 404
 * for it, the proxy rewraps that as a 502, and the caller paints a phantom error.
 */
export function useTuring<T>(path: string | null, options?: UseTuringOptions): UseTuringResult<T> {
  const { token } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const hasLoaded = useRef(false);

  const skipped = path === null;

  const load = useCallback(async () => {
    if (path === null) return;
    setLoading(!hasLoaded.current);
    try {
      const payload = await turingRequest<T>(path, token);
      if (!mounted.current) return;
      setData(payload);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      if (mounted.current) {
        hasLoaded.current = true;
        setLoading(false);
      }
    }
  }, [path, token]);

  useEffect(() => {
    mounted.current = true;
    if (skipped) {
      return () => { mounted.current = false; };
    }
    void load();
    if (!options?.refreshInterval) {
      return () => { mounted.current = false; };
    }
    const interval = window.setInterval(() => {
      void load();
    }, options.refreshInterval * 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [load, skipped, options?.refreshInterval]);

  // While skipped, report the idle state rather than whatever a previous path
  // left behind, so a caller cannot render a stale error for an unasked request.
  return {
    data: skipped ? null : data,
    error: skipped ? null : error,
    loading: skipped ? false : loading,
    refresh: () => { void load(); },
  };
}

export function useTuringMutation<TBody, TResponse>(
  path: string,
  method: "POST" | "DELETE" = "POST",
): UseTuringMutationResult<TBody, TResponse> {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = useCallback(async (body: TBody): Promise<TResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      return await turingRequest<TResponse>(path, token, { method, body });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [token, path, method]);

  return { trigger, loading, error };
}
