import { NextResponse, NextRequest } from "next/server";

const TURING_API_URL = process.env.TURING_API_URL || "http://localhost:8000";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const res = await fetch(`${TURING_API_URL}/allocate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TURING_API_KEY ? { "X-API-Key": TURING_API_KEY } : {}),
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
