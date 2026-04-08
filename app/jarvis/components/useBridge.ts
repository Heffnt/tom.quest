"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/app/components/AuthProvider";

interface BridgeConfig {
  bridgeUrl: string;
  token: string;
}

export function useBridgeConfig() {
  const { isTom, session, loading: authLoading } = useAuth();
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetched = useRef(false);

  useEffect(() => {
    if (authLoading || fetched.current) return;
    if (!isTom || !session) {
      setLoading(false);
      return;
    }
    fetched.current = true;
    (async () => {
      try {
        const res = await fetch("/api/jarvis/config", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) {
          setError(res.status === 401 ? "Not authorized" : "Bridge not configured");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setConfig({ bridgeUrl: data.bridgeUrl, token: data.token });
      } catch {
        setError("Failed to load bridge config");
      } finally {
        setLoading(false);
      }
    })();
  }, [isTom, session, authLoading]);

  const bridgeFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!config) throw new Error("Bridge not configured");
      const url = `${config.bridgeUrl}${path}`;
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> || {}),
      };
      if (config.token) headers["X-API-Key"] = config.token;
      return fetch(url, { ...init, headers });
    },
    [config],
  );

  return { config, error, loading, bridgeFetch };
}
