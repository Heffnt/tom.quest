import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

async function getUserIdFromAuthHeader(request: NextRequest, supabase: ReturnType<typeof createServerSupabaseClient>) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !supabase) return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data.user?.id ?? null;
}

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const userId = await getUserIdFromAuthHeader(request, supabase);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("cube_ratings")
    .select("scryfall_id, include, power, synergy, theme, notes, updated_at")
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ratingsByCardId: Record<string, unknown> = {};
  (data ?? []).forEach((row) => {
    ratingsByCardId[row.scryfall_id] = row;
  });

  return NextResponse.json({ ratings: ratingsByCardId });
}

