import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, getHeaders } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  try {
    const userId = request.headers.get("x-user-id") || undefined;
    const res = await fetchTuring(`/file?path=${encodeURIComponent(path)}`, {
      headers: getHeaders(),
      cache: "no-store",
    }, userId);
    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { error: errorText || "Failed to fetch file" },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
