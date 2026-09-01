import { createHmac } from "node:crypto";

function readEnv(): { url: string; key: string } {
  const url = process.env.TURING_API_URL;
  const key = process.env.TURING_API_KEY;
  if (!url) throw new Error("TURING_API_URL is not set");
  if (!key) throw new Error("TURING_API_KEY is not set");
  return { url: url.replace(/\/$/, ""), key };
}

export async function forwardToTuringApi(path: string, init?: RequestInit): Promise<Response> {
  const { url, key } = readEnv();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
    "X-API-Key": key,
  };
  return fetch(url + normalized, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
}

// ONE FIELD NAME FOR A FAILED REQUEST, AND IT IS `error`. Every proxy route
// under /api that fronts the Turing API — app/api/turing/[...path] and
// app/api/boolback/{node,file,blob} — answers a failure as {"error": string},
// so a reader never has to guess between two spellings of the same fact.
//
// Upstream states its reason differently: FastAPI's HTTPException serialises
// as {"detail": "..."} (and, for request-validation failures, a list under the
// same key). That body used to be re-wrapped whole, so `error` carried the
// literal string '{"detail":"no such dir"}' and a reader looking for `detail`
// on the OUTER object found nothing. This unwraps it: the reason text arrives
// under the one name, and nothing downstream parses JSON twice.
export function upstreamReason(text: string, status: number): string {
  if (!text.trim()) return `Turing request failed: ${status}`;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown } | null;
    const detail = parsed?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail !== undefined && detail !== null) return JSON.stringify(detail);
  } catch {
    // Not JSON — the body text is itself the reason.
  }
  return text;
}

export type WsCredentials = {
  wsUrl: string;
  token: string;
  expiresAt: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signWsToken(args: {
  userId: string;
  sessionName: string;
  ttlMs: number;
}): WsCredentials {
  const { url, key } = readEnv();
  const expiresAt = Date.now() + args.ttlMs;
  const payload = JSON.stringify({
    uid: args.userId,
    sid: args.sessionName,
    exp: expiresAt,
  });
  const payloadB64 = b64url(Buffer.from(payload, "utf-8"));
  const sig = createHmac("sha256", key).update(payloadB64).digest();
  return {
    wsUrl: url.replace(/^http/, "ws"),
    token: `${payloadB64}.${b64url(sig)}`,
    expiresAt,
  };
}
