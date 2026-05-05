import { api } from "@/convex/_generated/api";
import { bearerToken, convexClient } from "./convex-server";

const CACHE_TTL_MS = 60_000;

let cachedUrl: string | null = null;
let cachedKey: string | null = null;
let cacheTime = 0;

async function loadTuringConnection(token: string): Promise<{ url: string; key: string }> {
  const now = Date.now();
  if (cachedUrl && now - cacheTime < CACHE_TTL_MS) {
    return { url: cachedUrl, key: cachedKey ?? "" };
  }
  const client = convexClient();
  client.setAuth(token);
  const data = await client.query(api.turing.tunnelForViewer, {});
  cachedUrl = data.url;
  cachedKey = data.key;
  cacheTime = now;
  return { url: cachedUrl!, key: cachedKey ?? "" };
}

export async function getTunnelUrl(request: Request): Promise<{ url: string; key: string }> {
  const token = bearerToken(request);
  if (!token) throw new Error("Authentication required");
  const { url, key } = await loadTuringConnection(token);
  return { url, key };
}

export async function proxyToTuring(request: Request, path: string, init?: RequestInit): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return new Response("Authentication required", { status: 401 });
  const { url, key } = await loadTuringConnection(token);
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (key) headers["X-API-Key"] = key;
  return fetch(base + normalized, { ...init, headers });
}
