import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/convex-server";
import { getTunnelUrl } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const { url, key } = await getTunnelUrl(request);
    return NextResponse.json({ url, key });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
