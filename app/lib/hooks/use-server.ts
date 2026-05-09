"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOptionalGateway } from "@/app/jarvis/components/useGateway";
import { useAuth } from "../auth";

export type ServerKind = "turing" | "jarvis";

export type ServerStatus = {
  connected: boolean;
  fresh: boolean;
  error: string | null;
};

export type ServerCallParams = Record<string, unknown> & {
  path?: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
};

export type ServerAdapter = {
  kind: ServerKind;
  status: ServerStatus;
  call: <T = unknown>(method: string, params?: ServerCallParams) => Promise<T>;
  subscribe: (event: string, cb: (payload: unknown) => void) => () => void;
};

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function truncateMessage(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}...`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
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
    throw new Error(truncateMessage(text || `Request failed: ${response.status}`));
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

function parseTuringCall(method: string, params?: ServerCallParams) {
  const match = method.match(/^(GET|POST|DELETE)\s+(.+)$/i);
  const httpMethod = params?.method ?? (match?.[1]?.toUpperCase() as ServerCallParams["method"] | undefined) ?? "GET";
  const rawPath = params?.path ?? match?.[2] ?? method;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return { httpMethod, path };
}

function useTuringServer(): ServerAdapter {
  const { token, user, loading } = useAuth();
  const connection = useQuery(api.turing.connectionForViewer, user ? {} : "skip");

  const status = useMemo<ServerStatus>(() => {
    if (!user) return { connected: false, fresh: false, error: loading ? null : "Not signed in" };
    if (connection === undefined) return { connected: false, fresh: false, error: null };
    if (!connection) return { connected: false, fresh: false, error: "Turing backend not connected" };
    return { connected: true, fresh: connection.fresh, error: connection.fresh ? null : "Turing backend is stale" };
  }, [connection, loading, user]);

  const call = useCallback<ServerAdapter["call"]>(async (method, params) => {
    const { httpMethod, path } = parseTuringCall(method, params);
    const body = params?.body;
    const headers = {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...authHeaders(token),
      ...(params?.headers ?? {}),
    };
    const response = await fetch(`/api/turing${path}`, {
      method: httpMethod,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await readJsonResponse(response);
  }, [token]);

  return useMemo<ServerAdapter>(() => ({
    kind: "turing",
    status,
    call,
    subscribe: () => () => {},
  }), [call, status]);
}

function useJarvisServer(): ServerAdapter {
  const gateway = useOptionalGateway();
  const status = useMemo<ServerStatus>(() => ({
    connected: gateway?.connected ?? false,
    fresh: gateway?.connected ?? false,
    error: gateway?.error ?? (gateway ? null : "Jarvis socket unavailable"),
  }), [gateway]);

  const call = useCallback(async <T = unknown>(method: string, params?: ServerCallParams): Promise<T> => {
    if (!gateway) throw new Error("Jarvis socket unavailable");
    return await gateway.call(method, params) as T;
  }, [gateway]);

  const subscribe = useCallback<ServerAdapter["subscribe"]>((event, cb) => {
    return gateway?.subscribe(event, cb) ?? (() => {});
  }, [gateway]);

  return useMemo<ServerAdapter>(() => ({
    kind: "jarvis",
    status,
    call,
    subscribe,
  }), [call, status, subscribe]);
}

export function useServer(kind: ServerKind): ServerAdapter {
  const turing = useTuringServer();
  const jarvis = useJarvisServer();
  return kind === "turing" ? turing : jarvis;
}
