import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/convex-server";
import { forwardToTuringApi } from "@/app/lib/turing";

// Binary sibling of app/api/turing/[...path]/route.ts. The JSON catch-all reads
// res.text() and rejects any non-application/json body, so it cannot carry the
// gzipped boolback snapshot. This route is admin-gated identically, forwards the
// X-API-Key via forwardToTuringApi, and streams the upstream body through
// UNCHANGED as application/gzip — never reading it into memory as text.

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;

  const { path } = await ctx.params;
  const search = new URL(request.url).search;
  const upstreamPath = "/" + path.join("/") + search;

  try {
    const res = await forwardToTuringApi(upstreamPath, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Turing request failed: ${res.status}` },
        { status: res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502 },
      );
    }
    return new NextResponse(res.body, {
      status: res.status,
      headers: { "content-type": "application/gzip" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upstream error" },
      { status: 502 },
    );
  }
}
