import { NextRequest, NextResponse } from "next/server";
import { forwardToTuringApi } from "@/app/lib/turing";

// PUBLIC, read-only proxy for the boolback raw-artifact browser: lists one dir
// level (child dirs + files with sizes) inside the artifact tree. The X-API-Key is
// injected server-side and the upstream jails the path to $BOOLEAN_BACKDOOR_OUTPUT.
// EXPLICIT single endpoint, never a catch-all — it cannot reach /allocate or any
// other turing-api surface.
export async function GET(request: NextRequest) {
  const search = new URL(request.url).search;
  try {
    const res = await forwardToTuringApi("/cmt-node" + search, { method: "GET", cache: "no-store" });
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
