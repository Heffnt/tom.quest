import { NextRequest, NextResponse } from "next/server";
import { forwardToTuringApi } from "@/app/lib/turing";

// PUBLIC, read-only proxy for the boolback dir-picker. boolback is public viewing,
// so this is NOT admin-gated (unlike /api/turing). The X-API-Key is injected
// server-side and the upstream confines listing to $BOOLEAN_BACKDOOR_OUTPUT. This
// is an EXPLICIT single endpoint, never a catch-all — so it cannot be used to reach
// /allocate or any other turing-api surface without admin.
export async function GET(request: NextRequest) {
  const search = new URL(request.url).search;
  try {
    const res = await forwardToTuringApi("/cmt-dirs" + search, { method: "GET", cache: "no-store" });
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
