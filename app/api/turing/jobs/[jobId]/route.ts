import { NextResponse, NextRequest } from "next/server";

const TURING_API_URL = process.env.TURING_API_URL || "http://localhost:8000";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const res = await fetch(`${TURING_API_URL}/jobs/${jobId}`, {
      method: "DELETE",
      headers: TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {},
    });
    if (!res.ok) {
      const data = await res.json();
      return NextResponse.json(
        { detail: data.detail || "Failed to cancel job" },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { detail: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
