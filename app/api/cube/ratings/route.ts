import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

export async function GET() {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("cube_ratings")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = (data ?? [])
    .map((entry) => entry.user_id)
    .filter((entry): entry is string => typeof entry === "string" && !!entry);
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

  return NextResponse.json({ ratings: enriched });
}

