import { NextResponse, NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

const HEARTBEAT_STALE_MS = 120_000; // 2 minutes

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

// POST - Link user to a Turing backend by connection key
export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { connectionKey } = await request.json();
  if (!connectionKey || typeof connectionKey !== "string") {
    return NextResponse.json({ error: "connectionKey required" }, { status: 400 });
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  // Find the backend by key
  const { data: backend, error: findError } = await supabase
    .from("turing_connections")
    .select("*")
    .eq("connection_key", connectionKey.trim())
    .single();
  if (findError || !backend) {
    return NextResponse.json({ error: "No backend found with that key. Make sure your API is running." }, { status: 404 });
  }
  // Check heartbeat freshness
  if (!backend.last_heartbeat || Date.now() - new Date(backend.last_heartbeat).getTime() > HEARTBEAT_STALE_MS) {
    return NextResponse.json({ error: "Backend appears offline. Start your API on Turing first." }, { status: 400 });
  }
  // Check if key is already linked to another user
  if (backend.user_id && backend.user_id !== userId) {
    return NextResponse.json({ error: "This key is already linked to another account." }, { status: 409 });
  }
  // Unlink any existing connection for this user
  await supabase
    .from("turing_connections")
    .update({ user_id: null })
    .eq("user_id", userId);
  // Link this user to the backend
  const { error: linkError } = await supabase
    .from("turing_connections")
    .update({ user_id: userId })
    .eq("connection_key", connectionKey.trim());
  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

// DELETE - Unlink user from their Turing backend
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  // Null out user_id instead of deleting (API may still be running)
  const { error } = await supabase
    .from("turing_connections")
    .update({ user_id: null })
    .eq("user_id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
