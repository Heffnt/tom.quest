import { NextRequest, NextResponse } from "next/server";
import { forwardToTuringApi } from "@/app/lib/turing";

// PUBLIC, read-only proxy for the boolback snapshot STATUS (staleness-tolerant
// serve-latest envelope). GET only — rebuilding (POST) stays admin-gated via
// /api/turing, so anonymous callers can view but cannot submit sbatch build jobs.
export async function GET(request: NextRequest) {
  const search = new URL(request.url).search;
  try {
    const res = await forwardToTuringApi("/boolback-snapshot" + search, { method: "GET", cache: "no-store" });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.includes("application/json")) {
      return NextResponse.json(
        { error: text || `Turing request failed: ${res.status}` },
        { status: res.ok ? 502 : res.status },
      );
    }
    return new NextResponse(text, { status: res.status, headers: { "content-type": ct } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upstream error" }, { status: 502 });
  }
}
