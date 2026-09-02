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
  // The file's OWN heading order, not a reordering of it: returning the
  // default order filtered to what the file has is what let a plain read,
  // handed straight back to PUT, rearrange the day permanently. Headings the
  // file lacks travel separately, so the client can draw a box for each
  // without the file appearing to contain it.
  const orderedSections = parsed.orderedSections;
  const missingSections = DEFAULT_SECTION_ORDER.filter((name) => !(name in parsed.sections));
  return NextResponse.json({
    date: dayKey,
    path: relativePath,
    title: parsed.title || buildDefaultTitle(dayKey),
    raw,
    orderedSections,
    missingSections,
    sections: Object.fromEntries(
      [...orderedSections, ...missingSections].map((name) => [
        name,
        (parsed.sections[name] || []).join("\n").trim(),
      ]),
    ),
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => null)) as {
    date?: string;
    title?: string;
    orderedSections?: string[];
    missingSections?: string[];
    sections?: Record<string, string>;
  } | null;
  if (!body?.date || !body.sections) {
    return NextResponse.json({ error: "Missing date or sections" }, { status: 400 });
  }
  const relativePath = `memory/${body.date}.md`;
  const absolutePath = resolveWorkspacePath(relativePath);
  // The file on disk is the source for everything the payload does not carry:
  // the preamble, the bodies of headings the client did not send, and the
  // order to keep when the client sends none. PUT did not read it before, and
  // that is why a one-section write rewrote the whole day.
  const existingRaw = (await pathExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : "";
  const existing = parseMarkdownSections(existingRaw);
  const hasFile = existingRaw !== "";
  const sent = body.sections;

  // ABSENT and PRESENT-AND-EMPTY stop meaning the same thing: a heading the
  // payload does not mention keeps the body it has on disk; a heading sent as
  // "" is emptied.
  const bodyOf = (name: string): string[] => {
    const value = sent[name];
    if (value === undefined) return existing.sections[name] ?? [];
    return value.length > 0 ? value.split(/\r?\n/) : [];
  };
  const hasContent = (name: string) => bodyOf(name).some((line) => line.trim() !== "");

  // Order, in falling preference: what the client sent; the file's own order
  // (so a client that omits orderedSections cannot reorder the day); and for a
  // day with no file yet, the default order filtered to headings with content.
  const ordered =
    body.orderedSections && body.orderedSections.length > 0
      ? [...body.orderedSections]
      : hasFile
        ? [...existing.orderedSections]
        : DEFAULT_SECTION_ORDER.filter(hasContent);

  // A heading not already in the list joins it at its DEFAULT_SECTION_ORDER
  // slot: before the first heading present whose default slot is later,
  // appended when there is none. A heading outside DEFAULT_SECTION_ORDER never
  // acts as an anchor and is appended.
  const insertAtSlot = (name: string) => {
    const slot = DEFAULT_SECTION_ORDER.indexOf(name);
    const at =
      slot < 0
        ? -1
        : ordered.findIndex((present) => {
            const presentSlot = DEFAULT_SECTION_ORDER.indexOf(present);
            return presentSlot >= 0 && presentSlot > slot;
          });
    if (at < 0) ordered.push(name);
    else ordered.splice(at, 0, name);
  };
  for (const name of [...(body.missingSections ?? []), ...Object.keys(sent)]) {
    if (ordered.includes(name)) continue;
    if (!hasContent(name)) continue;
    insertAtSlot(name);
  }

  const normalizedSections: Record<string, string[]> = {};
  for (const name of ordered) normalizedSections[name] = bodyOf(name);
  const content = buildMarkdownSections(
    body.title || existing.title || buildDefaultTitle(body.date),
    ordered,
    normalizedSections,
    existing.preamble,
  );
  await fs.writeFile(absolutePath, content, "utf8");
  return NextResponse.json({ ok: true, path: relativePath, content });
}
