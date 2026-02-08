import { NextResponse, NextRequest } from "next/server";
import { fetchTuring } from "@/app/lib/turing";

export async function GET(request: NextRequest) {
  try {
    const userId = request.headers.get("x-user-id") || undefined;
    const res = await fetchTuring("/jobs", {
      cache: "no-store",
    }, userId);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch jobs" },
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
