import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, getHeaders, canUserWrite } from "@/app/lib/turing";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const userId = request.headers.get("x-user-id") || undefined;
  // Check if user can write
  if (!await canUserWrite(userId)) {
    return NextResponse.json(
      { detail: "You need to connect your Turing account to cancel jobs" },
      { status: 403 }
    );
  }
  try {
    const res = await fetchTuring(`/jobs/${jobId}`, {
      method: "DELETE",
      headers: getHeaders(),
    }, userId);
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
