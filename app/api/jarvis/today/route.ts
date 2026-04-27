import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { buildMarkdownSections, currentDayKey, parseMarkdownSections, pathExists, requireTom, resolveWorkspacePath } from "@/app/api/jarvis/_utils";

const DEFAULT_SECTION_ORDER = [
  "Sleep",
  "Activities",
  "Meals",
  "Mood / Feeling",
  "Exercise / Body",
  "Social",
  "Substances",
  "Pending / Follow-ups",
  "Notes",
  "Evening Reconstruction",
];

function buildDefaultTitle(dayKey: string) {
  return `${dayKey}`;
}

export async function GET(request: NextRequest) {
  if (!(await requireTom(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const dayKey = searchParams.get("date") || currentDayKey();
  const relativePath = `memory/${dayKey}.md`;
  const absolutePath = resolveWorkspacePath(relativePath);

  let raw = "";
  if (await pathExists(absolutePath)) {
    raw = await fs.readFile(absolutePath, "utf8");
  }
  const parsed = parseMarkdownSections(raw || `# ${buildDefaultTitle(dayKey)}\n`);
  const orderedSections = DEFAULT_SECTION_ORDER.filter((name) => name in parsed.sections);
  for (const section of DEFAULT_SECTION_ORDER) {
    if (!(section in parsed.sections)) {
      parsed.sections[section] = [];
      orderedSections.push(section);
    }
  }
  return NextResponse.json({
    date: dayKey,
    path: relativePath,
    title: parsed.title || buildDefaultTitle(dayKey),
    raw,
    orderedSections,
    sections: Object.fromEntries(orderedSections.map((name) => [name, (parsed.sections[name] || []).join("\n").trim()])),
  });
}

export async function PUT(request: NextRequest) {
  if (!(await requireTom(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as {
    date?: string;
    title?: string;
    orderedSections?: string[];
    sections?: Record<string, string>;
  } | null;
  if (!body?.date || !body.sections) {
    return NextResponse.json({ error: "Missing date or sections" }, { status: 400 });
  }
  const relativePath = `memory/${body.date}.md`;
  const absolutePath = resolveWorkspacePath(relativePath);
  const ordered = (body.orderedSections && body.orderedSections.length > 0)
    ? body.orderedSections
    : DEFAULT_SECTION_ORDER;
  const normalizedSections: Record<string, string[]> = {};
  for (const name of ordered) {
    const rawSection = body.sections[name] ?? "";
    normalizedSections[name] = rawSection.length > 0 ? rawSection.split(/\r?\n/) : [];
  }
  const content = buildMarkdownSections(body.title || buildDefaultTitle(body.date), ordered, normalizedSections);
  await fs.writeFile(absolutePath, content, "utf8");
  return NextResponse.json({ ok: true, path: relativePath, content });
}
