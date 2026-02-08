import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, canUserWrite } from "@/app/lib/turing";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const userId = request.headers.get("x-user-id") || undefined;
    // Check if user can write
    if (!await canUserWrite(userId)) {
      return NextResponse.json(
        { detail: "You need to connect your Turing account to allocate GPUs" },
        { status: 403 }
      );
    }
    const res = await fetchTuring("/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, userId);
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { detail: data.detail || "Failed to allocate" },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { detail: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
