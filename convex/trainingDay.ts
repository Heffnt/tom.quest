export type TrainingCell = { column: string; text: string };
export type TrainingIdea = { label: string; text: string };
export type TrainingDay = {
  cells: TrainingCell[];
  notes: string[];
  ideas: TrainingIdea[];
};

const WEEKDAYS = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue"],
  ["wednesday", "wed"],
  ["thursday", "thu"],
  ["friday", "fri"],
  ["saturday", "sat"],
] as const;

// These words describe a slot broadly rather than distinguishing one session
// from another. A one-word label can match only when its word is not here;
// labels with more than one main word must all be present in the slot.
const IDEA_STOP_WORDS = new Set<string>([
  "a", "an", "and", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "then", "to", "with",
  "afternoon", "evening", "full", "morning", "rest", "session", "sessions", "training", "workout", "workouts",
  "exercise", "exercises",
  ...WEEKDAYS.flat(),
]);

type Heading = { level: number; text: string };
type MarkdownTable = {
  start: number;
  end: number;
  sectionStart: number;
  sectionEnd: number;
  header: string[];
  rows: string[][];
};

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\\([^\s])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function heading(line: string): Heading | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (match === null) return null;
  return { level: match[1].length, text: stripMarkdown(match[2]) };
}

function tableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells = trimmed.split("|");
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  if (cells.length < 2) return null;
  return cells.map((cell) => stripMarkdown(cell));
}

function isDivider(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAt(lines: string[], start: number, end: number, sectionStart = 0, sectionEnd = end): MarkdownTable | null {
  const rawHeader = tableRow(lines[start] ?? "");
  const divider = tableRow(lines[start + 1] ?? "");
  if (rawHeader === null || divider === null || rawHeader.length !== divider.length || !isDivider(divider)) return null;

  const rows: string[][] = [];
  let cursor = start + 2;
  while (cursor < end) {
    const row = tableRow(lines[cursor]);
    if (row === null || row.length !== rawHeader.length) break;
    rows.push(row);
    cursor += 1;
  }
  return { start, end: cursor, sectionStart, sectionEnd, header: rawHeader, rows };
}

function weekday(value: string): string | null {
  const normalized = stripMarkdown(value).toLowerCase().replace(/[^a-z]/g, "");
  return WEEKDAYS.find(([full, short]) => normalized === full || normalized === short)?.[0] ?? null;
}

function weekdayPattern(day: string): RegExp {
  const words = WEEKDAYS.find(([full]) => full === day);
  if (words === undefined) return /$^/;
  return new RegExp(`\\b(?:${words[0]}|${words[1]})\\b`, "i");
}

function namesWeekday(value: string, day: string): boolean {
  return weekdayPattern(day).test(stripMarkdown(value));
}

function sectionAfter(lines: string[], at: number, level: number): number {
  for (let cursor = at + 1; cursor < lines.length; cursor += 1) {
    const candidate = heading(lines[cursor]);
    if (candidate !== null && candidate.level <= level) return cursor;
  }
  return lines.length;
}

function trainingTable(lines: string[], day: string): MarkdownTable | null {
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = heading(lines[index]);
    if (candidate === null || !candidate.text.toLowerCase().startsWith("training week")) continue;
    const end = sectionAfter(lines, index, candidate.level);
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const table = tableAt(lines, cursor, end, index + 1, end);
      if (table !== null) return table;
    }
    return null;
  }

  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const table = tableAt(lines, cursor, lines.length);
    if (
      table !== null
      && table.header[0]?.toLowerCase() === "day"
      && table.rows.some((row) => weekday(row[0] ?? "") !== null)
    ) return table;
  }
  return null;
}

function notesForDay(lines: string[], table: MarkdownTable, day: string): string[] {
  const notes: string[] = [];
  for (let index = table.sectionStart; index < table.sectionEnd; index += 1) {
    if (index >= table.start && index < table.end) continue;
    if (tableRow(lines[index]) !== null) continue;
    if (heading(lines[index]) !== null) continue;
    const text = stripMarkdown(lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, ""));
    if (text !== "" && namesWeekday(text, day)) notes.push(text);
  }
  return notes;
}

function normalizeWords(value: string): string[] {
  return stripMarkdown(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[+&]/g, " and ")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 1 && !IDEA_STOP_WORDS.has(word)) ?? [];
}

function labelMatchesCell(label: string, cells: TrainingCell[]): boolean {
  const labelWords = [...new Set(normalizeWords(label))];
  if (labelWords.length === 0) return false;
  return cells.some((cell) => {
    const words = new Set(normalizeWords(cell.text));
    return labelWords.every((word) => words.has(word));
  });
}

function sessionIdeas(lines: string[], day: string, cells: TrainingCell[]): TrainingIdea[] {
  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = heading(lines[index]);
    if (candidate !== null && candidate.text.toLowerCase().startsWith("session ideas")) {
      start = index + 1;
      end = sectionAfter(lines, index, candidate.level);
      break;
    }
  }
  if (start === -1) return [];

  const ideas: TrainingIdea[] = [];
  for (let index = start; index < end; index += 1) {
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(lines[index]);
    if (bullet === null) continue;
    const source = bullet[1].replace(/\s+\(inferred\)\s*$/i, "");
    const colon = source.indexOf(":");
    if (colon === -1) continue;
    const head = source.slice(0, colon).trim();
    const text = stripMarkdown(source.slice(colon + 1));
    if (head === "" || text === "") continue;

    const parenthetical = /^(.*?)\s*\(([^)]*)\)(?:\s*,.*)?$/.exec(head);
    const label = stripMarkdown(parenthetical?.[1] ?? head);
    if (label === "") continue;
    const namedToday = parenthetical !== null && namesWeekday(parenthetical[2], day);
    if (namedToday || labelMatchesCell(label, cells)) ideas.push({ label, text });
  }
  return ideas;
}

/** Parses today's displayed slot and optional ideas from the current published Markdown. */
export function trainingDay(scheduleMd: string, ideasMd: string, weekdayName: string): TrainingDay | null {
  const day = weekday(weekdayName);
  if (day === null) return null;

  const scheduleLines = scheduleMd.split(/\r?\n/);
  const table = trainingTable(scheduleLines, day);
  if (table === null) return null;
  const row = table.rows.find((candidate) => weekday(candidate[0] ?? "") === day);
  if (row === undefined) return null;

  const cells = table.header.slice(1).flatMap((column, index) => {
    const text = stripMarkdown(row[index + 1] ?? "");
    if (text === "" || /^[\-—–]+$/.test(text)) return [];
    return [{ column: stripMarkdown(column), text }];
  });

  return {
    cells,
    notes: notesForDay(scheduleLines, table, day),
    ideas: sessionIdeas(ideasMd.split(/\r?\n/), day, cells),
  };
}
