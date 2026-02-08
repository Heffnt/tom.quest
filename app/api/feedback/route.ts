import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, isTomUser } from "@/app/lib/supabase";

async function getUserIdFromAuthHeader(request: NextRequest, supabase: ReturnType<typeof createServerSupabaseClient>) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !supabase) return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data.user?.id ?? null;
}

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { name, content } = await request.json().catch(() => ({}));
  const trimmedContent = typeof content === "string" ? content.trim() : "";
  if (!trimmedContent) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }
  if (trimmedContent.length > 2000) {
    return NextResponse.json({ error: "Message is too long" }, { status: 400 });
  }

  const userId = await getUserIdFromAuthHeader(request, supabase);
  const cleanedName = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null;

  const { error } = await supabase.from("feedback").insert({
    user_id: userId,
    name: cleanedName,
    content: trimmedContent,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const userId = await getUserIdFromAuthHeader(request, supabase);
  if (!isTomUser(userId || undefined)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = (data ?? [])
    .map((entry) => entry.user_id)
    .filter((entry): entry is string => !!entry);
  const uniqueUserIds = Array.from(new Set(userIds));
  const usernameById = new Map<string, string>();

  if (uniqueUserIds.length > 0) {
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id, username")
      .in("id", uniqueUserIds);
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }
    (profiles ?? []).forEach((profile) => {
      usernameById.set(profile.id, profile.username);
    });
  }

  const enriched = (data ?? []).map((entry) => ({
    ...entry,
    username: entry.user_id ? usernameById.get(entry.user_id) ?? null : null,
  }));

  return NextResponse.json({ feedback: enriched });
}
