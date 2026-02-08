import { NextResponse, NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST - Register/heartbeat from Turing API
export async function POST(request: NextRequest) {
  const { key, url } = await request.json();
  if (!key || typeof key !== "string" || !UUID_REGEX.test(key)) {
    return NextResponse.json({ error: "Invalid key format" }, { status: 400 });
  }
  if (!url || typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const now = new Date().toISOString();
  // Upsert by connection_key
  const { error } = await supabase
    .from("turing_connections")
    .upsert(
      { connection_key: key, tunnel_url: url, last_heartbeat: now },
      { onConflict: "connection_key" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
