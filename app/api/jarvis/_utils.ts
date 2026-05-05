import { NextRequest } from "next/server";
import { requireTom as requireTomUser } from "@/app/lib/convex-server";
import path from "node:path";
import { promises as fs } from "node:fs";

export const WORKSPACE_ROOT = "/root/.openclaw/workspace";
export const OPENCLAW_ROOT = "/root/.openclaw";

export async function requireTom(request: NextRequest) {
  try {
    await requireTomUser(request);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkspacePath(relativePath: string) {
  const normalized = relativePath.replace(/^\/+/, "");
  const absolute = path.resolve(WORKSPACE_ROOT, normalized);
  if (!absolute.startsWith(WORKSPACE_ROOT + path.sep) && absolute !== WORKSPACE_ROOT) {
    throw new Error("Path escapes workspace root");
  }
  return absolute;
}

export async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export type ParsedDay = {
  title: string;
  sections: Record<string, string[]>;
  orderedSections: string[];
  raw: string;
};

export function parseMarkdownSections(raw: string): ParsedDay {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const title = lines[0]?.startsWith("# ") ? lines[0].slice(2).trim() : "";
  const sections: Record<string, string[]> = {};
  const orderedSections: string[] = [];
  let current = "Notes";
  sections[current] = [];
  orderedSections.push(current);

  for (const line of lines.slice(title ? 1 : 0)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections[current]) {
        sections[current] = [];
        orderedSections.push(current);
      }
      continue;
    }
    sections[current].push(line);
  }

  return { title, sections, orderedSections, raw: normalized };
}

export function buildMarkdownSections(title: string, orderedSections: string[], sections: Record<string, string[]>) {
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  for (const name of orderedSections) {
    const body = sections[name] ?? [];
    parts.push(`## ${name}`);
    if (body.length === 0) {
      parts.push("");
      continue;
    }
    parts.push(...body);
    if (body[body.length - 1] !== "") {
      parts.push("");
    }
  }
  return parts.join("\n").trimEnd() + "\n";
}

export function currentDayKey(timezone = "America/New_York", dayBoundaryHour = 5) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const y = Number(lookup.year);
  const m = Number(lookup.month);
  const d = Number(lookup.day);
  const h = Number(lookup.hour);
  const localDate = new Date(Date.UTC(y, m - 1, d));
  if (h < dayBoundaryHour) {
    localDate.setUTCDate(localDate.getUTCDate() - 1);
  }
  return localDate.toISOString().slice(0, 10);
}

export function extractTimedEntries(lines: string[]) {
  const entries: Array<{ timeLabel: string | null; minutes: number | null; text: string }> = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("-")) continue;
    const text = line.replace(/^-\s*/, "");
    const match = text.match(/^(?:~)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[—-]\s*(.*)$/i);
    if (!match) {
      entries.push({ timeLabel: null, minutes: null, text });
      continue;
    }
    let hour = Number(match[1]) % 12;
    const minute = Number(match[2] ?? "0");
    const meridiem = match[3].toUpperCase();
    if (meridiem === "PM") hour += 12;
    const minutes = hour * 60 + minute;
    entries.push({
      timeLabel: `${match[1]}:${String(minute).padStart(2, "0")} ${meridiem}`,
      minutes,
      text: match[4],
    });
  }
  return entries;
}
