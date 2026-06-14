import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// Constant-time string compare — the Convex runtime has no crypto.timingSafeEqual. Length is
// not secret (it leaks via the early return), but the per-char comparison must not short-circuit.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type PoolRequest = {
  writer: string;
  gpuType: string;
  desiredCount: number;
  enabled: boolean;
  restart: "always" | "never";
};

// Validate the agent request body. The agent may scale/toggle/restart only — never a command,
// projectDir, or resource limit — so those fields are not even accepted here (spec §7).
function parsePoolRequest(body: unknown): PoolRequest | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.gpuType !== "string" || b.gpuType.length === 0) {
    return { error: "gpuType (non-empty string) required" };
  }
  if (typeof b.desiredCount !== "number" || !Number.isFinite(b.desiredCount)) {
    return { error: "desiredCount (finite number) required" };
  }
  if (typeof b.enabled !== "boolean") {
    return { error: "enabled (boolean) required" };
  }
  if (b.restart !== "always" && b.restart !== "never") {
    return { error: 'restart must be "always" or "never"' };
  }
  const writer =
    typeof b.writer === "string" && b.writer.length > 0 ? b.writer : "agent";
  return {
    writer,
    gpuType: b.gpuType,
    desiredCount: b.desiredCount,
    enabled: b.enabled,
    restart: b.restart,
  };
}

// Agent worker-pool scaling endpoint (spec §7). The narrow, key-authed path an agent uses to
// scale / toggle / set the restart policy of a PRE-APPROVED (admin-authored) pool row. It may
// write only desiredCount / enabled / restart via internal.gpuPool.agentScale, and never
// authors a command — so arbitrary shell as the cluster user over the agent key is impossible
// (that stays a Tom-only capability behind the admin path). The key is POOL_AGENT_KEY, stored
// only in the Convex env and sharing nothing with TURING_API_KEY (the auth-clobber lesson).
const pool = httpAction(async (ctx, request) => {
  const expected = process.env.POOL_AGENT_KEY;
  if (!expected) {
    return jsonResponse(503, { error: "POOL_AGENT_KEY not configured" });
  }
  const presented = request.headers.get("X-Pool-Key") ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const parsed = parsePoolRequest(body);
  if ("error" in parsed) {
    return jsonResponse(400, parsed);
  }
  try {
    const result = await ctx.runMutation(internal.gpuPool.agentScale, parsed);
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    // agentScale refuses (no insert) when no admin-authored row exists for the gpuType —
    // surface that as 404, any other failure as 400. The command is never agent-writable.
    const message = e instanceof Error ? e.message : String(e);
    const status = message.includes("no admin-authored") ? 404 : 400;
    return jsonResponse(status, { error: message });
  }
});

http.route({ path: "/pool", method: "POST", handler: pool });

export default http;
