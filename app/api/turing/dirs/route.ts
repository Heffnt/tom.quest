import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, getHeaders } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") || "~";
    const res = await fetchTuring(`/dirs?path=${encodeURIComponent(path)}`, {
      headers: getHeaders(),
      cache: "no-store",
    });
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
