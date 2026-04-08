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
  const bridgeUrl = process.env.JARVIS_BRIDGE_URL;
  const token = process.env.JARVIS_BRIDGE_TOKEN;
  if (!bridgeUrl) {
    return NextResponse.json({ error: "Bridge not configured" }, { status: 503 });
  }
  const canControl = isTomUser(userId || undefined);
  return NextResponse.json({
    bridgeUrl,
    token: canControl ? token || "" : "",
    canControl,
  });
}
