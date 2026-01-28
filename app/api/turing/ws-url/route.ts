import { NextResponse } from "next/server";

const TURING_API_URL = process.env.TURING_API_URL || "http://localhost:8000";
const TURING_API_KEY = process.env.TURING_API_KEY || "";

export async function GET() {
  const wsUrl = TURING_API_URL.replace(/^http/, "ws");
  return NextResponse.json({
    ws_url: wsUrl,
    api_key: TURING_API_KEY,
  });
}
