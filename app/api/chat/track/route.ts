import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "../../../lib/supabase";

// POST - Log a page visit
export async function POST(request: Request) {
  const { deviceId, path, duration } = await request.json();

  if (!deviceId || !path) {
    return NextResponse.json({ error: "deviceId and path required" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  // If duration is provided, update an existing visit
  if (duration !== undefined) {
    const { error } = await supabase
      .from("page_visits")
      .update({ duration_seconds: duration })
      .eq("device_id", deviceId)
      .eq("path", path)
      .is("duration_seconds", null)
      .order("entered_at", { ascending: false })
      .limit(1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    // Create new page visit
    const { error } = await supabase.from("page_visits").insert({
      device_id: deviceId,
      path,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Update device last_seen
  await supabase
    .from("devices")
    .update({ last_seen: new Date().toISOString() })
    .eq("device_id", deviceId);

  return NextResponse.json({ success: true });
}
