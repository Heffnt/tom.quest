import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { buildMarkdownSections, currentDayKey, parseMarkdownSections, pathExists, resolveWorkspacePath } from "@/app/api/jarvis/_utils";
import { requireTom } from "@/app/lib/convex-server";

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
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;
  const { searchParams } = new URL(request.url);
  const dayKey = searchParams.get("date") || currentDayKey();
  const relativePath = `memory/${dayKey}.md`;
  const absolutePath = resolveWorkspacePath(relativePath);

  let raw = "";
  if (await pathExists(absolutePath)) {
    raw = await fs.readFile(absolutePath, "utf8");
  }
  const parsed = parseMarkdownSections(raw || `# ${buildDefaultTitle(dayKey)}\n`);
  // The ten known sections first, seeded empty when the file lacks them, then
  // every other heading the file actually has, in file order. The second loop
  // is what keeps a hand-added `## Dreams` reachable: without it the tab never
  // saw the section, PUT never sent it back, and the save dropped it.
  const orderedSections: string[] = [];
  for (const section of DEFAULT_SECTION_ORDER) {
    if (!(section in parsed.sections)) parsed.sections[section] = [];
    orderedSections.push(section);
  }
  for (const section of parsed.orderedSections) {
    if (!orderedSections.includes(section)) orderedSections.push(section);
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

/**
 * Residual, deliberately not closed here: the sections the request DOES carry
 * are last-write-wins. A draft the tab loaded minutes ago still overwrites
 * whatever was written into those same sections in between. Closing that needs
 * a precondition on the request — the modification time or a hash of the file
 * the client loaded, rejected when the file on disk has moved on — which is a
 * protocol change to both the route and the tab, not a merge rule.
 */
export async function PUT(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;
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

  // The file on disk is the base, not the request. A save used to rewrite the
  // whole file from what the client sent, so anything the client never loaded
  // — a section written by hand or by Jarvis after the tab loaded — was gone
  // after the next Save, with no error shown.
  let existingRaw = "";
  if (await pathExists(absolutePath)) {
    existingRaw = await fs.readFile(absolutePath, "utf8");
  }
  const existing = parseMarkdownSections(existingRaw);

  const requested = (body.orderedSections && body.orderedSections.length > 0)
    ? body.orderedSections
    : DEFAULT_SECTION_ORDER;

  const mergedOrder: string[] = [...existing.orderedSections];
  const mergedSections: Record<string, string[]> = {};
  for (const name of mergedOrder) {
    mergedSections[name] = existing.sections[name] ?? [];
  }
  for (const name of requested) {
    // A name the request lists but carries no body for is left alone rather
    // than overwritten with an empty section.
    if (!(name in body.sections)) continue;
    if (!mergedOrder.includes(name)) mergedOrder.push(name);
    const rawSection = body.sections[name] ?? "";
    mergedSections[name] = rawSection.length > 0 ? rawSection.split(/\r?\n/) : [];
  }

  const content = buildMarkdownSections(
    body.title || existing.title || buildDefaultTitle(body.date),
    mergedOrder,
    mergedSections,
    existing.preamble,
  );
  await fs.writeFile(absolutePath, content, "utf8");
  return NextResponse.json({ ok: true, path: relativePath, content });
}
