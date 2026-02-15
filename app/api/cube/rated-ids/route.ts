import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const PAGE_SIZE = 1000;
  const ids: string[] = [];
  for (let offset = 0; offset < 1000000; offset += PAGE_SIZE) {
    // PostgREST caps rows; use grouped select + pagination for stable "distinct" ids.
    const { data, error } = await supabase
      .from("cube_ratings")
      .select("scryfall_id, count:scryfall_id")
      .order("scryfall_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const pageIds = (data ?? [])
      .map((row) => row.scryfall_id)
      .filter((id): id is string => typeof id === "string" && !!id);
    ids.push(...pageIds);
    if (pageIds.length < PAGE_SIZE) break;
  }

  return NextResponse.json(
    { ids },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

