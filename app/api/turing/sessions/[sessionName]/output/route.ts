import { NextRequest, NextResponse } from "next/server";
import { fetchTuring, getHeaders } from "@/app/lib/turing";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionName: string }> }
) {
  try {
    const userId = request.headers.get("x-user-id") || undefined;
    const { sessionName } = await params;
    const { searchParams } = new URL(request.url);
    const lines = searchParams.get("lines") || "500";
    const res = await fetchTuring(
      `/sessions/${encodeURIComponent(sessionName)}/output?lines=${encodeURIComponent(lines)}`,
      {
        headers: getHeaders(),
        cache: "no-store",
      },
      userId
    );
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return NextResponse.json(
        { error: data?.detail || "Failed to fetch session output" },
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
