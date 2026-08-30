import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAdminOrAgentRead } from "@/app/lib/convex-server";
import { isAgentTuringRead } from "@/convex/agentSurfaces";
import { forwardToTuringApi } from "@/app/lib/turing";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, ctx: Ctx, method: "GET" | "POST" | "DELETE") {
  const { path } = await ctx.params;
  const search = new URL(request.url).search;
  const bare = "/" + path.join("/");
  const upstreamPath = bare + search;

  // The gate is admin for everything, and one narrow exception for the `agent`
  // role a TTS session's headless browser signs in as. That exception is both
  // method-limited and path-limited, and it needs to be both.
  //
  // Method, because before this role existed one requireAdmin covered GET,
  // POST and DELETE alike: any account that could look at /turing could also
  // allocate GPUs and cancel a running job.
  //
  // Path, because this route is a catch-all onto the whole FastAPI service and
  // plenty of its GETs are not the dashboard — /file and /dirs read the cluster
  // filesystem, /sessions/{name}/output is terminal scrollback. The allowlist
  // in convex/agentSurfaces is the three paths the /turing page itself fetches,
  // so a path added upstream later is shut to `agent` until someone names it.
  const auth =
    method === "GET" && isAgentTuringRead(bare)
      ? await requireAdminOrAgentRead(request, "Turing")
      : await requireAdmin(request);
  if (auth instanceof Response) return auth;

  const init: RequestInit = { method, cache: "no-store" };
  if (method !== "GET") {
    const body = await request.text();
    if (body) {
      // Authoritative guard for the manual allocation path: the "gpupool:" job
      // name prefix is reserved for the Convex pool reconciler, which tracks
      // ownership by parsing this prefix off squeue. The reconciler hits FastAPI
      // directly (bypassing this proxy), so blocking here cannot affect it.
      const targetsAllocate = path[0] === "allocate" || upstreamPath.startsWith("/allocate");
      if (targetsAllocate && method === "POST") {
        // Parse defensively: a non-JSON body is forwarded unchanged, as today.
        try {
          const parsed = JSON.parse(body) as { job_name?: unknown };
          if (typeof parsed.job_name === "string" && parsed.job_name.trim().startsWith("gpupool:")) {
            return NextResponse.json(
              { error: "Job name prefix 'gpupool:' is reserved for the GPU pool reconciler." },
              { status: 400 },
            );
          }
        } catch {
          // Not JSON; fall through and forward verbatim.
        }
      }
      init.body = body;
      const ct = request.headers.get("content-type");
      init.headers = ct ? { "Content-Type": ct } : { "Content-Type": "application/json" };
    }
  }

  try {
    const res = await forwardToTuringApi(upstreamPath, init);
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const looksLikeHtml = /^\s*(?:<!doctype html|<html)/i.test(text);
    if (!res.ok || looksLikeHtml || !contentType.includes("application/json")) {
      const error =
        looksLikeHtml || contentType.includes("text/html")
          ? `Turing API returned ${res.status} (non-JSON body); the API may be down or misconfigured.`
          : text || `Turing request failed: ${res.status}`;
      return NextResponse.json(
        { error },
        { status: res.ok ? 502 : res.status === 401 || res.status === 403 ? res.status : 502 },
      );
    }
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upstream error" },
      { status: 502 }
    );
  }
}

export const GET = (request: NextRequest, ctx: Ctx) => proxy(request, ctx, "GET");
export const POST = (request: NextRequest, ctx: Ctx) => proxy(request, ctx, "POST");
export const DELETE = (request: NextRequest, ctx: Ctx) => proxy(request, ctx, "DELETE");
