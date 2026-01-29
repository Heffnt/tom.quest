import { NextResponse, NextRequest } from "next/server";
import { getTuringUrl, getHeaders } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  try {
    const baseUrl = await getTuringUrl();
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") || "~";
    const url = new URL(`${baseUrl}/dirs`);
    url.searchParams.set("path", path);
    const res = await fetch(url.toString(), {
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
