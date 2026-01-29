import { NextResponse, NextRequest } from "next/server";

const TURING_API_URL = process.env.TURING_API_URL || "http://localhost:8000";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") || "~";
    const url = new URL(`${TURING_API_URL}/dirs`);
    url.searchParams.set("path", path);
    const res = await fetch(url.toString(), {
      headers: TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {},
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
