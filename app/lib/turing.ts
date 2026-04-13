import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TOM_USER_ID = process.env.NEXT_PUBLIC_TOM_USER_ID || process.env.TOM_USER_ID || "";
const CACHE_TTL_MS = 60_000;

let cachedUrl: string | null = null;
let cachedKey: string | null = null;
let cacheTime = 0;

function serverClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase server credentials missing");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function loadTomConnection(): Promise<{ url: string; key: string }> {
  const now = Date.now();
  if (cachedUrl && now - cacheTime < CACHE_TTL_MS) {
    return { url: cachedUrl, key: cachedKey ?? "" };
  }
  if (!TOM_USER_ID) throw new Error("Turing backend not connected");
  const { data } = await serverClient()
    .from("turing_connections")
    .select("tunnel_url, connection_key")
    .eq("user_id", TOM_USER_ID)
    .single();
  if (!data) throw new Error("Turing backend not connected");
  cachedUrl = data.tunnel_url;
  cachedKey = data.connection_key;
  cacheTime = now;
  return { url: cachedUrl!, key: cachedKey ?? "" };
}

export async function getTunnelUrl(): Promise<string> {
  const { url } = await loadTomConnection();
  return url;
}

export async function proxyToTuring(path: string, init?: RequestInit): Promise<Response> {
  const { url, key } = await loadTomConnection();
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (key) headers["X-API-Key"] = key;
  return fetch(base + normalized, { ...init, headers });
}

export function isTom(userId: string | undefined): boolean {
  return !!userId && userId === TOM_USER_ID;
}
