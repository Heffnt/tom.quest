// The intent page's own reading of what the two queries return: the filters,
// the grouping and the one date each line shows for the list, and for the
// agent's view, which of its lines are lines of the list.

import { nyCalendarDayKey } from "@/convex/ttsShared";
import {
  evidenceKey,
  MODEL_OF_TOM_PAGES,
  parseBullets,
  voiceOf,
  type IntentKind,
  type IntentLine,
  type IntentVoice,
} from "@/convex/intentParse";

export type { IntentKind, IntentLine, IntentVoice };

/** The four kinds, in the order the page draws them: what he wants to be true,
 *  then the rules that stand, then what he has settled, then what he said about
 *  a run's output. */
export const KINDS: IntentKind[] = ["direction", "standing-rule", "ruling", "label"];

export const VOICES: IntentVoice[] = ["his", "inferred", "unattributed"];

export type Filters = {
  kind: IntentKind | "all";
  voice: IntentVoice | "all";
  source: string | "all";
};

export const NO_FILTERS: Filters = { kind: "all", voice: "all", source: "all" };

export function filterLines(lines: IntentLine[], filters: Filters): IntentLine[] {
  return lines.filter((line) =>
    (filters.kind === "all" || line.kind === filters.kind)
    && (filters.voice === "all" || line.voice === filters.voice)
    && (filters.source === "all" || line.source === filters.source));
}

/**
 * The lines by kind, each group keeping the order it arrived in — the query
 * sorts newest first and undated last, and a group must not re-sort it or the
 * newest change stops being at the top of its group.
 */
export function groupByKind(lines: IntentLine[]): { kind: IntentKind; lines: IntentLine[] }[] {
  return KINDS
    .map((kind) => ({ kind, lines: lines.filter((line) => line.kind === kind) }))
    .filter((group) => group.lines.length > 0);
}

/** Every source present, in the order the page offers them as a filter. */
export function sourcesOf(lines: IntentLine[]): string[] {
  return [...new Set(lines.map((line) => line.source))].sort();
}

/**
 * The one date a line shows.
 *
 * A LINE WRITTEN IN A FILE SHOWS THE DATE THE FILE SPELLS, verbatim, because
 * that date is a date and not an instant: reading `2026-08-20` as UTC midnight
 * and printing it back in New York would move every one of them to the 19th.
 * A row of the record carries a real instant instead, and that one is printed
 * in his own day boundary.
 */
export function dateLabel(line: IntentLine): string {
  if (line.dateText !== null) return line.dateText;
  if (line.at === null) return "undated";
  return nyCalendarDayKey(line.at);
}

/** How many of the shown lines are his own words, for the header's count. */
export function countVoices(lines: IntentLine[]): Record<IntentVoice, number> {
  const counts: Record<IntentVoice, number> = { his: 0, inferred: 0, unattributed: 0 };
  for (const line of lines) counts[line.voice] += 1;
  return counts;
}

/** `his` is the only voice that gets the accent: the page is read to find
 *  drift from what HE said, so his own lines must be findable at a glance. */
export const VOICE_CLASS: Record<IntentVoice, string> = {
  his: "text-accent",
  inferred: "text-text-muted",
  unattributed: "text-text-faint",
};

// ── The agent's view ─────────────────────────────────────────────────────────

/** A run of the agent's text: plain lines, or one bullet of a model-of-tom
 *  page whose lines the list holds, with every line it wraps onto. */
type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "bullet"; text: string; source: string; key: string };

/** The `── <path> ──` line the prelude and a joined skill body put over each
 *  file they carry. */
const FILE_HEADER = /^── (\S+) ──$/;

const PAGE_KIND = new Map<string, IntentKind>(MODEL_OF_TOM_PAGES.map((page) => [page.path, page.kind]));

/**
 * The agent's text cut into plain runs and bullets. A bullet counts only
 * inside a `── model-of-tom/{agent-rules,intent,priorities}.md ──` file, and
 * is found by the same parseBullets the list's query uses over that file, so
 * its key is the key its line in the list carries. The text is kept verbatim:
 * joining the parts' texts with newlines gives the input back.
 */
export function segmentBullets(text: string): AgentPart[] {
  const lines = text.split("\n");
  const bullets = new Map<number, { last: number; source: string; key: string }>();
  const headers = lines.flatMap((line, index) => {
    const match = FILE_HEADER.exec(line);
    return match === null ? [] : [{ index, path: match[1] }];
  });
  headers.forEach((header, n) => {
    if (!PAGE_KIND.has(header.path)) return;
    const start = header.index + 1;
    const end = headers[n + 1]?.index ?? lines.length;
    for (const bullet of parseBullets(lines.slice(start, end).join("\n"))) {
      const first = start + bullet.line - 1;
      let last = first;
      while (last + 1 < end && /^\s+\S/.test(lines[last + 1])) last += 1;
      bullets.set(first, { last, source: header.path, key: evidenceKey(bullet.text) });
    }
  });

  const parts: AgentPart[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length > 0) parts.push({ kind: "text", text: plain.join("\n") });
    plain = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const bullet = bullets.get(index);
    if (bullet === undefined) {
      plain.push(lines[index]);
      continue;
    }
    flush();
    parts.push({
      kind: "bullet",
      text: lines.slice(index, bullet.last + 1).join("\n"),
      source: bullet.source,
      key: bullet.key,
    });
    index = bullet.last;
  }
  flush();
  return parts;
}

type AgentRow =
  | { kind: "text"; text: string }
  | { kind: "bullet"; text: string; line: IntentLine };

/**
 * Each bullet joined to its line in the list: same file, same text once its
 * spacing is normalised — the join the list itself makes to the evidence
 * file. A bullet the list does not hold (the prompt and the list read two
 * posts, which can stand at two commits) still opens, as a line with no
 * evidence behind it.
 */
export function joinLines(parts: AgentPart[], lines: IntentLine[]): AgentRow[] {
  const byKey = new Map<string, IntentLine>();
  for (const line of lines) {
    if (PAGE_KIND.has(line.source)) byKey.set(`${line.source}\n${evidenceKey(line.text)}`, line);
  }
  return parts.map((part, index) => {
    if (part.kind === "text") return part;
    const line = byKey.get(`${part.source}\n${part.key}`) ?? {
      id: `${part.source}#unmatched-${index}`,
      // segmentBullets cuts a bullet only out of a page this map names.
      kind: PAGE_KIND.get(part.source)!,
      text: part.key,
      section: "",
      voice: voiceOf(part.key, []),
      source: part.source,
      locator: "unmatched",
      at: null,
      dateText: null,
      evidence: [],
    };
    return { kind: "bullet", text: part.text, line };
  });
}

// ── What the record says beside a line ──────────────────────────────────────
//
// A delegate decision's `restedOn` names what it rested on in the spellings
// its prompt asks for: `ruling:<id>`, a page section `<path>#<Heading>`, an
// evidence entry `<evidence path>:<heading>`. A rule eval item is named
// `rule/ruling-<last 8 of the ruling id>`. Both resolve to lines of the list
// here, in one place, so the page and its tests agree on what "beside" means.

/** The lines one `restedOn` reference names; empty when it names none. */
export function linesRestedOn(ref: string, lines: IntentLine[]): IntentLine[] {
  const trimmed = ref.trim();
  if (trimmed.startsWith("ruling:")) {
    const id = `rulings/${trimmed.slice("ruling:".length)}`;
    return lines.filter((line) => line.id === id);
  }
  const cut = trimmed.search(/[#:]/);
  if (cut === -1) return [];
  const path = trimmed.slice(0, cut).replace("/evidence/", "/");
  const heading = trimmed.slice(cut + 1).trim();
  if (heading === "") return [];
  if (/^\d+$/.test(heading)) return lines.filter((line) => line.id === `${path}#${heading}`);
  const wanted = heading.toLowerCase();
  return lines.filter((line) => line.source === path && line.section.toLowerCase() === wanted);
}

/** The ruling id suffix an eval item names, or null for an item that names no line. */
export function evalItemLineSuffix(name: string): string | null {
  const match = /^rule\/ruling-([a-z0-9]{8})$/.exec(name);
  return match === null ? null : match[1];
}

/** Every eval item that names this line: rule items name a ruling by its id's last 8 characters. */
export function evalItemsForLine<T extends { name: string }>(line: IntentLine, items: T[]): T[] {
  if (line.kind !== "ruling") return [];
  return items.filter((item) => {
    const suffix = evalItemLineSuffix(item.name);
    return suffix !== null && line.id.endsWith(suffix);
  });
}

/** `passed/runs` over the runs read, or null for a line no eval item names. */
export function passRate(items: { passed: number; runs: number }[]): { passed: number; runs: number } | null {
  if (items.length === 0) return null;
  return items.reduce((sum, item) => ({ passed: sum.passed + item.passed, runs: sum.runs + item.runs }), { passed: 0, runs: 0 });
}
