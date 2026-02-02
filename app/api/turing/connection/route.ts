import { NextResponse, NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

// GET - Get user's Turing connection
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { data, error } = await supabase
    .from("turing_connections")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error && error.code !== "PGRST116") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ connection: data || null });
}

// POST - Create or update Turing connection
export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { tunnelUrl } = await request.json();
  if (!tunnelUrl) {
    return NextResponse.json({ error: "tunnelUrl required" }, { status: 400 });
  }
  // Validate URL format
  if (!tunnelUrl.startsWith("http://") && !tunnelUrl.startsWith("https://")) {
    return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
  }
  // Verify the connection works by hitting the health endpoint
  try {
    const healthUrl = tunnelUrl.endsWith("/") ? `${tunnelUrl}health` : `${tunnelUrl}/health`;
    const res = await fetch(healthUrl, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Backend returned ${res.status}. Make sure your tom-quest-api is running.` },
        { status: 400 }
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Could not connect to backend: ${e instanceof Error ? e.message : "Unknown error"}` },
      { status: 400 }
    );
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  // Check if connection exists
  const { data: existing } = await supabase
    .from("turing_connections")
    .select("id")
    .eq("user_id", userId)
    .single();
  if (existing) {
    // Update existing
    const { error } = await supabase
      .from("turing_connections")
      .update({
        tunnel_url: tunnelUrl,
        last_verified: new Date().toISOString(),
      })
      .eq("user_id", userId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    // Insert new
    const { error } = await supabase.from("turing_connections").insert({
      user_id: userId,
      tunnel_url: tunnelUrl,
      last_verified: new Date().toISOString(),
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ success: true });
}

// DELETE - Remove Turing connection
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { error } = await supabase
    .from("turing_connections")
    .delete()
    .eq("user_id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
