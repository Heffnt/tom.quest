import { NextResponse } from "next/server";
import { fetchTuring, getHeaders } from "@/app/lib/turing";

export async function GET() {
  try {
    const res = await fetchTuring("/jobs", {
      headers: getHeaders(),
      cache: "no-store",
    });
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
