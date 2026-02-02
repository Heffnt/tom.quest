import { NextResponse } from "next/server";
import { createServerSupabaseClient, isTomUser } from "../../../lib/supabase";

// GET - Get device info (for single device) or list all devices (Tom only)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const userId = searchParams.get("userId");
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  // If deviceId is provided, return that single device
  if (deviceId) {
    const { data: device } = await supabase
      .from("devices")
      .select("*")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return NextResponse.json({ device: device || null });
  }

  // List all devices - Tom only
  if (!userId || !isTomUser(userId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: devices, error } = await supabase
    .from("devices")
    .select(`
      *,
      profiles:user_id (username)
    `)
    .order("last_seen", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get unread counts for each device
  const devicesWithUnread = await Promise.all(
    devices.map(async (device) => {
      const { count } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("device_id", device.device_id)
        .eq("from_tom", false);
      
      const { data: lastTomMessage } = await supabase
        .from("messages")
        .select("created_at")
        .eq("device_id", device.device_id)
        .eq("from_tom", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Count messages from visitor after Tom's last reply
      let unread = 0;
      if (lastTomMessage) {
        const { count: unreadCount } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("device_id", device.device_id)
          .eq("from_tom", false)
          .gt("created_at", lastTomMessage.created_at);
        unread = unreadCount || 0;
      } else {
        unread = count || 0;
      }

      return {
        ...device,
        username: device.profiles?.username || null,
        unread,
      };
    })
  );

  return NextResponse.json({ devices: devicesWithUnread });
}

// POST - Register or update a device
export async function POST(request: Request) {
  const { deviceId, deviceName } = await request.json();
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { data: existing } = await supabase
    .from("devices")
    .select("id, total_visits")
    .eq("device_id", deviceId)
    .single();

  if (existing) {
    await supabase
      .from("devices")
      .update({
        last_seen: new Date().toISOString(),
        total_visits: existing.total_visits + 1,
      })
      .eq("device_id", deviceId);
  } else {
    await supabase.from("devices").insert({
      device_id: deviceId,
      device_name: deviceName,
    });
  }

  return NextResponse.json({ success: true });
}
