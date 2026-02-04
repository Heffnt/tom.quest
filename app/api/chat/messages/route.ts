import { NextResponse } from "next/server";
import { createServerSupabaseClient, isTomUser } from "../../../lib/supabase";

// GET - Get messages for a device
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const userId = searchParams.get("userId");

  if (!deviceId) {
    return NextResponse.json({ error: "deviceId required" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { data: messages, error } = await supabase
    .from("messages")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const readTimestamp = new Date().toISOString();
  if (userId && isTomUser(userId)) {
    await supabase
      .from("devices")
      .update({ tom_last_read_at: readTimestamp })
      .eq("device_id", deviceId);
  } else {
    await supabase
      .from("devices")
      .update({ user_last_read_at: readTimestamp })
      .eq("device_id", deviceId);
  }

  return NextResponse.json({ messages });
}

// POST - Send a message
export async function POST(request: Request) {
  const { deviceId, content, fromTom, userId } = await request.json();

  if (!deviceId || !content) {
    return NextResponse.json({ error: "deviceId and content required" }, { status: 400 });
  }

  // If fromTom is true, verify the user is Tom
  if (fromTom && (!userId || !isTomUser(userId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({
      device_id: deviceId,
      content,
      from_tom: fromTom || false,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (fromTom) {
    await supabase
      .from("devices")
      .update({ tom_last_read_at: new Date().toISOString() })
      .eq("device_id", deviceId);
  }

  return NextResponse.json({ message: data });
}
