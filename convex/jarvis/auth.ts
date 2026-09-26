// auth.ts — the box's key, checked once for every /jarvis/* route.
//
// The key is JARVIS_KEY in the Convex env, read as `JARVIS_KEY ?? TTS_WORKER_KEY`
// until the morning rotation (the 2026-09-26 program: "env JARVIS_KEY (read
// JARVIS_KEY ?? TTS_WORKER_KEY until the morning key rotation)"). The header
// is X-Jarvis-Key; X-TTS-Key is read too until the box has switched, and goes
// with the /tts/ prefix (convex/http.ts, the prefix loop). A route that needs
// a different key (Tom's own ruling door, the sign-off door) keeps its own
// check; this one is for what the box posts as itself.

/** The header the box sends. */
const KEY_HEADER = "X-Jarvis-Key";
/** The previous generation's header; accepted until the box has switched. */
const OLD_KEY_HEADER = "X-TTS-Key";

/** The key the record expects, or undefined when neither variable is set. */
function jarvisKey(): string | undefined {
  return process.env.JARVIS_KEY || process.env.TTS_WORKER_KEY || undefined;
}

// Constant-time string compare: the Convex runtime has no
// crypto.timingSafeEqual. Length is compared first, which leaks only length.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Null when the request carries the key; else the response that refuses it. */
export function jarvisAuth(request: Request): Response | null {
  const expected = jarvisKey();
  if (!expected) return jsonResponse(503, { error: "JARVIS_KEY not configured" });
  const presented = request.headers.get(KEY_HEADER) ?? request.headers.get(OLD_KEY_HEADER) ?? "";
  if (!timingSafeEqual(presented, expected)) return jsonResponse(401, { error: "unauthorized" });
  return null;
}
