import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, isTomUser } from "@/app/lib/supabase";

async function getUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const supabase = createServerSupabaseClient();
  if (!supabase) return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  const { data } = await supabase.auth.getUser(token);
  return data.user?.id ?? null;
}

export async function GET(request: NextRequest) {
  const userId = await getUserId(request);
  if (!isTomUser(userId || undefined)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    return NextResponse.json({ error: "Gateway not configured" }, { status: 503 });
  }
  const gatewayToken = process.env.JARVIS_GATEWAY_TOKEN?.trim() || null;
  return NextResponse.json({ gatewayUrl, gatewayToken });
}
