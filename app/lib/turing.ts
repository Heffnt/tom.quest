const TURING_URL_GIST = process.env.TURING_URL_GIST || "";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

let cachedUrl: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

export async function getTuringUrl(): Promise<string> {
  if (cachedUrl && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedUrl;
  }
  if (!TURING_URL_GIST) {
    return "http://localhost:8000";
  }
  try {
    const res = await fetch(TURING_URL_GIST, { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      cachedUrl = text.trim();
      cacheTime = Date.now();
      return cachedUrl;
    }
  } catch {}
  return cachedUrl || "http://localhost:8000";
}

export function getApiKey(): string {
  return TURING_API_KEY;
}

export function getHeaders(): Record<string, string> {
  return TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {};
}
