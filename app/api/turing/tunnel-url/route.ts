import { NextRequest, NextResponse } from "next/server";
import { getTunnelUrl, isTom } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id") || undefined;
  if (!isTom(userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const url = await getTunnelUrl();
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
