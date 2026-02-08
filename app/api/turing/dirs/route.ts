import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, canUserWrite } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id") || undefined;
  // Check if user can write (dirs is a write operation - browsing their files)
  if (!await canUserWrite(userId)) {
    return NextResponse.json(
      { error: "You need to connect your Turing account to browse directories" },
      { status: 403 }
    );
  }
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") || "~";
    const res = await fetchTuring(`/dirs?path=${encodeURIComponent(path)}`, {
      cache: "no-store",
    }, userId);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to list directory" },
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
