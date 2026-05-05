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

function truncateMessage(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string, token: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(token), cache: "no-store" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    throw new Error(message);
  }
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (contentType.includes("application/json")) {
      let payload: { error?: unknown } | null = null;
      try {
        payload = JSON.parse(text) as { error?: unknown };
      } catch {
        payload = null;
      }
      if (typeof payload?.error === "string") {
        throw new Error(truncateMessage(payload.error));
      }
    }
    throw new Error(truncateMessage(text || `Request failed: ${res.status}`));
  }
  try {
    return (await res.json()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON response";
    throw new Error(message);
  }
}

export function useTuring<T>(path: string, options?: UseTuringOptions): UseTuringResult<T> {
  const { token } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(!hasLoaded.current);
    try {
      const payload = await fetchJson<T>("/api/turing" + path, token);
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
  }, [load, options?.refreshInterval]);

  return {
    data,
    error,
    loading,
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
    const url = "/api/turing" + path;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders(token) };
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const text = await res.text();
        let message = truncateMessage(text || `Request failed: ${res.status}`);
        if (contentType.includes("application/json")) {
          try {
            const payload = JSON.parse(text) as { error?: unknown };
            if (typeof payload.error === "string") {
              message = truncateMessage(payload.error);
            }
          } catch {
            // Fall back to the response text.
          }
        }
        throw new Error(message);
      }
      const payload = (await res.json()) as TResponse;
      return payload;
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
