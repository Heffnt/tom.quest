import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/convex-server";
import { forwardToTuringApi } from "@/app/lib/turing";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, ctx: Ctx, method: "GET" | "POST" | "DELETE") {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { path } = await ctx.params;
  const search = new URL(request.url).search;
  const upstreamPath = "/" + path.join("/") + search;

  const init: RequestInit = { method, cache: "no-store" };
  if (method !== "GET") {
    const body = await request.text();
    if (body) {
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
