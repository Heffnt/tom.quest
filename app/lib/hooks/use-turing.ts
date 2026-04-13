"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
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

function buildFetcher(userId: string | undefined) {
  return async (url: string) => {
    const headers: Record<string, string> = {};
    if (userId) headers["x-user-id"] = userId;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Request failed: ${res.status}`);
    }
    return res.json();
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
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (user?.id) headers["x-user-id"] = user.id;
      const res = await fetch("/api/turing" + path, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed: ${res.status}`);
      }
      return (await res.json()) as TResponse;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      return null;
    } finally {
      setLoading(false);
    }
  }, [user, path, method]);

  return { trigger, loading, error };
}
