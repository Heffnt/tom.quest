import { NextResponse, NextRequest } from "next/server";
import { fetchTuring, getHeaders } from "@/app/lib/turing";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const res = await fetchTuring("/allocate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getHeaders(),
      },
      body: JSON.stringify(body),
    });
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
