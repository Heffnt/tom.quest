import { createServerSupabaseClient, isTomUser } from "./supabase";

const TOM_USER_ID = process.env.TOM_USER_ID || "";

// Cache for Tom's connection info
let tomCache: { url: string; key: string } | null = null;
let tomCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

interface ConnectionInfo {
  tunnel_url: string;
  connection_key: string;
}

function buildTuringUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== error.message) {
    parts.push(`cause: ${cause.message}`);
  }
  return parts.join("; ");
}

// Get Tom's connection info from DB
async function getTomConnection(): Promise<ConnectionInfo | null> {
  if (tomCache && Date.now() - tomCacheTime < CACHE_TTL_MS) {
    return { tunnel_url: tomCache.url, connection_key: tomCache.key };
  }
  if (!TOM_USER_ID) return null;
  const supabase = createServerSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("turing_connections")
    .select("tunnel_url, connection_key")
    .eq("user_id", TOM_USER_ID)
    .single();
  if (data) {
    tomCache = { url: data.tunnel_url, key: data.connection_key };
    tomCacheTime = Date.now();
    return data;
  }
  return null;
}

// Get a user's connection info from DB
async function getUserConnection(userId: string): Promise<ConnectionInfo | null> {
  const supabase = createServerSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("turing_connections")
    .select("tunnel_url, connection_key")
    .eq("user_id", userId)
    .single();
  return data || null;
}

// Resolve connection for a user (their own, or Tom's as fallback)
async function resolveConnection(userId?: string): Promise<ConnectionInfo | null> {
  if (userId && isTomUser(userId)) {
    return getTomConnection();
  }
  if (userId) {
    const userConn = await getUserConnection(userId);
    if (userConn) return userConn;
  }
  // Fallback to Tom's connection (read-only for guests)
  return getTomConnection();
}

// Check if user can write (has own connection or is Tom)
export async function canUserWrite(userId?: string): Promise<boolean> {
  if (!userId) return false;
  if (isTomUser(userId)) return true;
  const conn = await getUserConnection(userId);
  return !!conn;
}

// Fetch from user's Turing backend or Tom's
export async function fetchTuring(path: string, init?: RequestInit, userId?: string): Promise<Response> {
  const conn = await resolveConnection(userId);
  if (!conn) {
    throw new Error("No Turing backend available");
  }
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> || {}),
    "X-API-Key": conn.connection_key,
  };
  try {
    const res = await fetch(buildTuringUrl(conn.tunnel_url, path), { ...init, headers });
    // On 530 (Cloudflare error), invalidate Tom's cache and retry
    if (res.status === 530 && (!userId || isTomUser(userId))) {
      tomCache = null;
      tomCacheTime = 0;
      const freshConn = await getTomConnection();
      if (freshConn) {
        headers["X-API-Key"] = freshConn.connection_key;
        return await fetch(buildTuringUrl(freshConn.tunnel_url, path), { ...init, headers });
      }
    }
    return res;
  } catch (error) {
    // On fetch error for Tom, invalidate cache and retry
    if (!userId || isTomUser(userId)) {
      tomCache = null;
      tomCacheTime = 0;
      const freshConn = await getTomConnection();
      if (freshConn) {
        headers["X-API-Key"] = freshConn.connection_key;
        try {
          return await fetch(buildTuringUrl(freshConn.tunnel_url, path), { ...init, headers });
        } catch (retryError) {
          throw new Error(`Upstream fetch failed: ${formatFetchError(retryError)}`);
        }
      }
    }
    throw new Error(`Upstream fetch failed: ${formatFetchError(error)}`);
  }
}
