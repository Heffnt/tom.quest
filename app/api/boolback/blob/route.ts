import { NextRequest, NextResponse } from "next/server";
import { forwardToTuringApi } from "@/app/lib/turing";

// PUBLIC, read-only binary proxy: streams the latest gzipped boolback snapshot
// through unchanged as application/gzip (the JSON proxy reads res.text() and would
// reject a gzip body). Not admin-gated — boolback is public viewing. EXPLICIT
// single endpoint (not a catch-all).
export async function GET(request: NextRequest) {
  const search = new URL(request.url).search;
  try {
    const res = await forwardToTuringApi("/boolback-snapshot-blob" + search, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Turing request failed: ${res.status}` },
        { status: res.status === 404 ? 404 : 502 },
      );
    }
    return new NextResponse(res.body, {
      status: res.status,
      headers: { "content-type": "application/gzip" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upstream error" }, { status: 502 });
  }
}
