import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/convex-server";
import { proxyToTuring } from "@/app/lib/turing";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, ctx: Ctx, method: "GET" | "POST" | "DELETE") {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Admin access required" },
      { status: 403 },
    );
  }
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
    const res = await proxyToTuring(request, upstreamPath, init);
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
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
