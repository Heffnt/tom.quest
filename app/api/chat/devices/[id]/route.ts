import { NextResponse } from "next/server";
import { createServerSupabaseClient, isTomUser } from "../../../../lib/supabase";

// GET - Get detailed device info (Tom only)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId || !isTomUser(userId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  // Get device info
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select(`
      *,
      profiles:user_id (username, id)
    `)
    .eq("device_id", id)
    .single();

  if (deviceError) {
    return NextResponse.json({ error: deviceError.message }, { status: 404 });
  }

  // Get page visits
  const { data: pageVisits } = await supabase
    .from("page_visits")
    .select("*")
    .eq("device_id", id)
    .order("entered_at", { ascending: false })
    .limit(50);

  // Get message count
  const { count: messageCount } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("device_id", id);

  return NextResponse.json({
    device: {
      ...device,
      username: device.profiles?.username || null,
    },
    pageVisits: pageVisits || [],
    messageCount: messageCount || 0,
  });
}
