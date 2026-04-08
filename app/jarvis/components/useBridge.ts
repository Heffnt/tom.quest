"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/app/components/AuthProvider";

interface BridgeConfig {
  bridgeUrl: string;
  token: string;
  canControl: boolean;
}

export function useBridgeConfig() {
  const { session, loading: authLoading } = useAuth();
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetched = useRef(false);

  useEffect(() => {
    if (authLoading || fetched.current) return;
    fetched.current = true;
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`;
        }
        const res = await fetch("/api/jarvis/config", {
          headers,
        });
        if (!res.ok) {
          setError("Bridge not configured");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setConfig({
          bridgeUrl: data.bridgeUrl,
          token: data.token || "",
          canControl: Boolean(data.canControl),
        });
      } catch {
        setError("Failed to load bridge config");
      } finally {
        setLoading(false);
      }
    })();
  }, [session, authLoading]);

  const bridgeFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!config) throw new Error("Bridge not configured");
      const url = `${config.bridgeUrl}${path}`;
      const method = (init?.method || "GET").toUpperCase();
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> || {}),
      };
      if (config.token && method !== "GET" && method !== "HEAD") {
        headers["X-API-Key"] = config.token;
      }
      return fetch(url, { ...init, headers });
    },
    [config],
  );

  return { config, error, loading, bridgeFetch };
}
