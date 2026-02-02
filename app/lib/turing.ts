import { createServerSupabaseClient, isTomUser } from "./supabase";

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

// Get Tom's Turing URL from gist
export async function getTomTuringUrl(options: TuringUrlOptions = {}): Promise<string> {
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

// Get user's Turing URL from database
export async function getUserTuringUrl(userId: string): Promise<string | null> {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("turing_connections")
    .select("tunnel_url")
    .eq("user_id", userId)
    .single();
  return data?.tunnel_url || null;
}

// Get the appropriate Turing URL for a user
export async function getTuringUrl(userId?: string, options: TuringUrlOptions = {}): Promise<string> {
  // If user is Tom, use Tom's URL
  if (userId && isTomUser(userId)) {
    return getTomTuringUrl(options);
  }
  // If user has their own connection, use that
  if (userId) {
    const userUrl = await getUserTuringUrl(userId);
    if (userUrl) return userUrl;
  }
  // Default to Tom's URL (for read-only access)
  return getTomTuringUrl(options);
}

// Check if user can write (has own connection or is Tom)
export async function canUserWrite(userId?: string): Promise<boolean> {
  if (!userId) return false;
  if (isTomUser(userId)) return true;
  const userUrl = await getUserTuringUrl(userId);
  return !!userUrl;
}

// Fetch from user's Turing backend or Tom's
export async function fetchTuring(path: string, init?: RequestInit, userId?: string): Promise<Response> {
  const baseUrl = await getTuringUrl(userId);
  try {
    const res = await fetch(buildTuringUrl(baseUrl, path), init);
    if (res.status !== 530) return res;
    // Only retry with refresh for Tom's URL (gist-based)
    if (!userId || isTomUser(userId)) {
      const refreshedUrl = await getTomTuringUrl({ forceRefresh: true });
      return await fetch(buildTuringUrl(refreshedUrl, path), init);
    }
    return res;
  } catch (error) {
    // Only retry with refresh for Tom's URL
    if (!userId || isTomUser(userId)) {
      const refreshedUrl = await getTomTuringUrl({ forceRefresh: true });
      try {
        return await fetch(buildTuringUrl(refreshedUrl, path), init);
      } catch (retryError) {
        const detail = formatFetchError(retryError);
        throw new Error(`Upstream fetch failed: ${detail}`);
      }
    }
    throw new Error(`Upstream fetch failed: ${formatFetchError(error)}`);
  }
}

export function getApiKey(): string {
  return TURING_API_KEY;
}

export function getHeaders(): Record<string, string> {
  return TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {};
}
