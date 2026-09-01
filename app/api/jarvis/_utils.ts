import path from "node:path";
import { promises as fs } from "node:fs";

import { ttsDayKey } from "@/convex/ttsShared";

export const WORKSPACE_ROOT = "/root/.openclaw/workspace";
export const OPENCLAW_ROOT = "/root/.openclaw";

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

/**
 * The TTS day (5 a.m. America/New_York boundary) the jarvis surfaces default
 * to when a request carries no explicit ?date= / ?center=. The rule has ONE
 * home: convex/ttsShared.ts (ledger ruling tts-shared-time-edge, 2026-08-27,
 * cites C1 — app/ may import it). This used to be a fourth hand-rolled copy
 * built on Intl.DateTimeFormat, the one mechanism ttsShared deliberately
 * avoids so the rule reads identically in Convex, Node and the browser; the
 * two agreed on every instant from 2007 on, so replacing it changed nothing.
 */
export function currentDayKey() {
  return ttsDayKey(Date.now());
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
