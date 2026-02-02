const TURING_URL_GIST = process.env.TURING_URL_GIST || "";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

let cachedUrl: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

type TuringUrlOptions = {
  forceRefresh?: boolean;
};

function buildTuringUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export async function getTuringUrl(options: TuringUrlOptions = {}): Promise<string> {
  if (!options.forceRefresh && cachedUrl && Date.now() - cacheTime < CACHE_TTL_MS) {
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

export async function fetchTuring(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = await getTuringUrl();
  try {
    return await fetch(buildTuringUrl(baseUrl, path), init);
  } catch (error) {
    const refreshedUrl = await getTuringUrl({ forceRefresh: true });
    return await fetch(buildTuringUrl(refreshedUrl, path), init);
  }
}

export function getApiKey(): string {
  return TURING_API_KEY;
}

export function getHeaders(): Record<string, string> {
  return TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {};
}
