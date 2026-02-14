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

function parseOptionalScore(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > 5) return undefined;
  return value;
}

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const userId = await getUserIdFromAuthHeader(request, supabase);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const scryfallId = typeof body.scryfall_id === "string" ? body.scryfall_id.trim() : "";
  if (!scryfallId) {
    return NextResponse.json({ error: "scryfall_id is required" }, { status: 400 });
  }

  if (typeof body.include !== "boolean") {
    return NextResponse.json({ error: "include is required" }, { status: 400 });
  }

  const power = parseOptionalScore(body.power);
  const synergy = parseOptionalScore(body.synergy);
  const theme = parseOptionalScore(body.theme);
  if (power === undefined || synergy === undefined || theme === undefined) {
    return NextResponse.json({ error: "Scores must be 1-5 or null" }, { status: 400 });
  }

  const notesRaw = typeof body.notes === "string" ? body.notes.trim() : "";
  const notes = notesRaw ? notesRaw.slice(0, 5000) : null;

  const updatedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("cube_ratings")
    .upsert(
      {
        user_id: userId,
        scryfall_id: scryfallId,
        include: body.include,
        power,
        synergy,
        theme,
        notes,
        updated_at: updatedAt,
      },
      { onConflict: "user_id,scryfall_id" },
    )
    .select("*")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rating: data });
}

