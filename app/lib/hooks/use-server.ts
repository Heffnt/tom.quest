"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "../auth";

export type ServerKind = "turing" | "jarvis";

export type ServerStatus = {
  connected: boolean;
  fresh: boolean;
  error: string | null;
};

const FRESHNESS_WINDOW_MS = 90_000;

/**
 * Liveness of a backend server, read from the `serverHealth` table that the
 * Convex cron `internal.serverHealth.pollTuring` writes. `kind` is the
 * `serverName` column: the table's union allows "jarvis", but only "turing" is
 * polled today, so "jarvis" reports as never probed rather than as down.
 *
 * This hook deliberately has no `call` and no `subscribe`. It used to expose
 * both, plus a second websocket-backed Jarvis adapter, and nothing in the repo
 * ever reached any of it — the one call site (app/components/debug-panel.tsx)
 * reads `.status` alone. Do not grow the verbs back: HTTP requests to the
 * Turing API go through app/lib/hooks/use-turing.ts, and the Jarvis websocket
 * goes through app/jarvis/components/useGateway.ts.
 */
export function useServer(kind: ServerKind): { status: ServerStatus } {
  const { user, loading } = useAuth();
  const health = useQuery(api.serverHealth.get, user ? { serverName: kind } : "skip");

  const status = useMemo<ServerStatus>(() => {
    if (!user) return { connected: false, fresh: false, error: loading ? null : "Not signed in" };
    if (health === undefined) return { connected: false, fresh: false, error: null };
    if (!health) return { connected: false, fresh: false, error: `${kind} has not been probed yet` };
    const fresh = Date.now() - health.lastChecked < FRESHNESS_WINDOW_MS;
    return {
      connected: health.reachable,
      fresh,
      error: health.reachable ? null : (health.error ?? `${kind} not reachable`),
    };
  }, [health, kind, loading, user]);

  return useMemo(() => ({ status }), [status]);
}
