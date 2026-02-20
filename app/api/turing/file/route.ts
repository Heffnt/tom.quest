import { NextResponse, NextRequest } from "next/server";
import { fetchTuring } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  try {
    const userId = request.headers.get("x-user-id") || undefined;
    const res = await fetchTuring(`/file?path=${encodeURIComponent(path)}`, {
      cache: "no-store",
    }, userId);
    const text = await res.text();
    const contentType = res.headers.get("content-type") || "application/json";
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
