import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { currentDayKey, extractTimedEntries, parseMarkdownSections, pathExists, resolveWorkspacePath } from "@/app/api/jarvis/_utils";
import { requireTom } from "@/app/lib/convex-server";

function shiftDay(dayKey: string, delta: number) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;
  const { searchParams } = new URL(request.url);
  const center = searchParams.get("center") || currentDayKey();
  const days = Math.max(1, Math.min(9, Number(searchParams.get("days") || "5")));
  const half = Math.floor(days / 2);
  const results: Array<Record<string, unknown>> = [];

  for (let offset = -half; offset <= half; offset += 1) {
    const dayKey = shiftDay(center, offset);
    const relativePath = `memory/${dayKey}.md`;
    const absolutePath = resolveWorkspacePath(relativePath);
    let raw = "";
    if (await pathExists(absolutePath)) {
      raw = await fs.readFile(absolutePath, "utf8");
    }
    const parsed = parseMarkdownSections(raw);
    const activityLines = parsed.sections["Activities"] || [];
    const mealsLines = parsed.sections["Meals"] || [];
    const socialLines = parsed.sections["Social"] || [];
    results.push({
      date: dayKey,
      title: parsed.title || dayKey,
      path: relativePath,
      exists: Boolean(raw),
      timedActivities: extractTimedEntries(activityLines),
      timedMeals: extractTimedEntries(mealsLines),
      timedSocial: extractTimedEntries(socialLines),
      sections: {
        activities: activityLines,
        meals: mealsLines,
        mood: parsed.sections["Mood / Feeling"] || [],
        social: socialLines,
        substances: parsed.sections["Substances"] || [],
      },
    });
  }

  return NextResponse.json({ center, days: results });
}
