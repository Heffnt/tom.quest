const TURING_URL_GIST = process.env.TURING_URL_GIST || "";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

let cachedUrl: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

type TuringUrlOptions = {
  forceRefresh?: boolean;
};

function isValidTuringUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function buildTuringUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function describeCause(cause: unknown): string | null {
  if (!cause) return null;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object") {
    const typed = cause as { code?: unknown; syscall?: unknown; address?: unknown; port?: unknown; message?: unknown };
    const parts = [
      typed.code ? `code=${String(typed.code)}` : null,
      typed.syscall ? `syscall=${String(typed.syscall)}` : null,
      typed.address ? `address=${String(typed.address)}` : null,
      typed.port ? `port=${String(typed.port)}` : null,
      typed.message ? `message=${String(typed.message)}` : null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(cause);
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const causeText = describeCause((error as { cause?: unknown }).cause);
  if (causeText && causeText !== error.message) parts.push(`cause: ${causeText}`);
  return parts.join("; ");
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
      const nextUrl = text.trim();
      if (isValidTuringUrl(nextUrl)) {
        cachedUrl = nextUrl;
        cacheTime = Date.now();
        return cachedUrl;
      }
    }
  } catch {}
  return cachedUrl || "http://localhost:8000";
}

export async function fetchTuring(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = await getTuringUrl();
  try {
    const res = await fetch(buildTuringUrl(baseUrl, path), init);
    if (res.status !== 530) return res;
    const refreshedUrl = await getTuringUrl({ forceRefresh: true });
    return await fetch(buildTuringUrl(refreshedUrl, path), init);
  } catch (error) {
    const refreshedUrl = await getTuringUrl({ forceRefresh: true });
    try {
      return await fetch(buildTuringUrl(refreshedUrl, path), init);
    } catch (retryError) {
      const detail = formatFetchError(retryError);
      const baseLabel = isValidTuringUrl(baseUrl) ? baseUrl : "invalid url";
      const retryLabel = isValidTuringUrl(refreshedUrl) ? refreshedUrl : "invalid url";
      throw new Error(`Upstream fetch failed (${baseLabel} -> ${retryLabel}): ${detail}`);
    }
  }
}

export function getApiKey(): string {
  return TURING_API_KEY;
}

export function getHeaders(): Record<string, string> {
  return TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {};
}
