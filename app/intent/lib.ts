// The intent page's own reading of what the query returns: the filters, the
// grouping, and the one date each line shows.

import { nyCalendarDayKey } from "@/convex/ttsShared";
import type { IntentKind, IntentLine, IntentVoice } from "@/convex/intentParse";

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
