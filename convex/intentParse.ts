// THE INTENT PARSERS. Tom's intent is written in four kinds of place, and this
// module turns each of them into the same row: one line, its kind, its date,
// where it is written, whether it carries his words, and the evidence behind
// it.
//
// NOTHING HERE HOLDS TEXT. Every function takes a body the record already
// stores — a model-of-tom file, an `AGENTS.md`, `vqc/steering.yaml`, the spec's
// revision notes — and reads the lines out of it at query time. A curated copy
// of his intent would be a second thing to keep in step with the first, and the
// first is the one he edits.
//
// PURE, so convex/intentParse.test.ts can hold the whole grammar and the query
// that uses it (convex/intent.ts) can hold none of it.

/** The four kinds of place his intent lives. */
export type IntentKind = "direction" | "standing-rule" | "ruling" | "label";

/**
 * Whose words the line is.
 *   his          — a line his own words stand behind, or a ruling he gave.
 *   inferred     — marked `(inferred)` on the page, or resting on an inference.
 *   unattributed — a line read off the code or the record, and every
 *                  `AGENTS.md` rule, which has no evidence file at all: written
 *                  by agents, never contradicted by him, and not the same thing
 *                  as an inference about him.
 */
export type IntentVoice = "his" | "inferred" | "unattributed";

/** One entry of a model-of-tom evidence file: `said:`, `paraphrase:`, `read:`
 *  or `rests on:`, each a date, a source and what was said. */
type EvidenceEntry = {
  form: string;
  /** The entry verbatim, the separator dots included. */
  text: string;
  /** The date it opens with, when that date is readable. */
  date: string | null;
};

export type IntentLine = {
  /** Stable across renders and unique in one page load: source plus locator. */
  id: string;
  kind: IntentKind;
  /** The line itself, verbatim, with any `(inferred)` marker left on it. */
  text: string;
  /** The heading it sits under, or "" for a source with no headings. */
  section: string;
  voice: IntentVoice;
  /** The file it is written in, or the table it is a row of. */
  source: string;
  /** `line 14` in that file, or the row's id. */
  locator: string;
  /** Epoch ms of the newest date known for the line, or null when undated. */
  at: number | null;
  /** That date as the source spells it. */
  dateText: string | null;
  evidence: EvidenceEntry[];
};

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * `2026-08-20` and `April 2026`, the two spellings the evidence files use, as
 * epoch ms at UTC midnight. A month alone resolves to its first day, which
 * sorts it before every dated line of that month — an approximate date reads
 * as the start of what it covers rather than as the end of it.
 *
 * UTC, not New York: these are dates written in a file, not instants, and a
 * local-zone reading would move them by a day depending on where the reader is.
 */
export function parseDate(value: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (iso) {
    const at = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(at) ? at : null;
  }
  const month = /^([A-Za-z]+)\s+(\d{4})$/.exec(value.trim());
  if (month) {
    const index = MONTHS[month[1].toLowerCase()];
    if (index === undefined) return null;
    return Date.UTC(Number(month[2]), index, 1);
  }
  return null;
}

/** The date an evidence entry opens with: everything before its first `·`. */
function leadingDate(text: string): string | null {
  const head = text.split("·")[0]?.trim() ?? "";
  return parseDate(head) === null ? null : head;
}

/** A page's bullets are matched to their evidence entries by their text, and a
 *  line rewritten in one file and not the other must not match by accident, so
 *  the key is the whole line with only its spacing normalised. */
function evidenceKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Bullet = { section: string; text: string; line: number };

/**
 * Every top-level bullet of a markdown page, each under the deepest heading
 * above it. A continuation line (indented, or a bare line under a bullet) is
 * folded into the bullet it belongs to, because a wrapped line is one line.
 */
export function parseBullets(body: string): Bullet[] {
  const bullets: Bullet[] = [];
  let section = "";
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      bullets.push({ section, text: bullet[1].trim(), line: i + 1 });
      continue;
    }
    const last = bullets[bullets.length - 1];
    if (last !== undefined && /^\s+\S/.test(raw)) {
      last.text = `${last.text} ${raw.trim()}`;
    }
  }
  return bullets;
}

/**
 * A model-of-tom evidence file: `- line: <the page's bullet>` followed by one
 * or more `  <form>: <date> · <source> · <text>` entries, under the same
 * headings the page uses. Returns the entries by line text, so a page bullet
 * finds its own evidence and a bullet whose wording changed finds none.
 */
export function parseEvidence(body: string): Map<string, EvidenceEntry[]> {
  const found = new Map<string, EvidenceEntry[]>();
  let current: EvidenceEntry[] | null = null;
  let entry: EvidenceEntry | null = null;
  for (const raw of body.split("\n")) {
    const line = /^[-*]\s+line:\s*(.*)$/.exec(raw);
    if (line) {
      current = [];
      entry = null;
      found.set(evidenceKey(line[1]), current);
      continue;
    }
    if (/^#{1,6}\s+/.test(raw)) {
      current = null;
      entry = null;
      continue;
    }
    const form = /^\s{2,}(said|paraphrase|read|rests on):\s*(.*)$/.exec(raw);
    if (form && current !== null) {
      entry = { form: form[1], text: form[2].trim(), date: leadingDate(form[2]) };
      current.push(entry);
      continue;
    }
    // A wrapped entry: more indented than the form line that opened it.
    if (entry !== null && /^\s{4,}\S/.test(raw)) {
      entry.text = `${entry.text} ${raw.trim()}`;
      entry.date = leadingDate(entry.text);
    }
  }
  return found;
}

/** The newest date any of the entries carries. */
function newestEvidenceDate(entries: EvidenceEntry[]): { at: number | null; text: string | null } {
  let at: number | null = null;
  let text: string | null = null;
  for (const item of entries) {
    if (item.date === null) continue;
    const parsed = parseDate(item.date);
    if (parsed === null) continue;
    if (at === null || parsed > at) {
      at = parsed;
      text = item.date;
    }
  }
  return { at, text };
}

/**
 * WHICH OF THE THREE A LINE IS, decided by the forms of evidence under it —
 * the evidence files already make exactly this distinction, so nothing here
 * judges the line's wording beyond the `(inferred)` marker Tom's own pages use.
 *
 *   said / paraphrase → his: those two forms are entries of his words.
 *   rests on          → inferred: the form means an inference resting on
 *                       something older than his saying it.
 *   read only, or no evidence entry at all → unattributed: a line read off the
 *                       code or the record. It is a fact about the system, and
 *                       calling it an inference about HIM would be a claim the
 *                       evidence file does not make.
 */
function voiceOf(text: string, entries: EvidenceEntry[]): IntentVoice {
  if (/\(inferred\)\s*$/.test(text)) return "inferred";
  if (entries.some((item) => item.form === "said" || item.form === "paraphrase")) return "his";
  if (entries.some((item) => item.form === "rests on")) return "inferred";
  return "unattributed";
}

/**
 * A model-of-tom page and its evidence file, as intent lines. `kind` is the
 * caller's because the same shape carries two kinds: `intent.md` is what he
 * wants to be true (a direction), `priorities.md` and `agent-rules.md` are
 * rules that stand until he changes them.
 */
export function parseModelOfTomPage(args: {
  path: string;
  body: string;
  evidence: string;
  kind: IntentKind;
}): IntentLine[] {
  const entries = parseEvidence(args.evidence);
  return parseBullets(args.body).map((bullet) => {
    const evidence = entries.get(evidenceKey(bullet.text)) ?? [];
    const { at, text: dateText } = newestEvidenceDate(evidence);
    return {
      id: `${args.path}#${bullet.line}`,
      kind: args.kind,
      text: bullet.text,
      section: bullet.section,
      voice: voiceOf(bullet.text, evidence),
      source: args.path,
      locator: `line ${bullet.line}`,
      at,
      dateText,
      evidence,
    };
  });
}

type Block = { fields: Record<string, string>; line: number };

/**
 * The YAML-ish block lists two of his standing-rule files are written as:
 * `vqc/steering.yaml` (id, kind, owner, created, trigger, correction) and the
 * rulings log of `vqc/adoption.md` (id, date, question, ruling, cites). Both
 * wrap long values, with `>-` or without it, and both are read here rather than
 * by a YAML library because Convex holds the file as text and one grammar over
 * two files is one thing to keep right.
 *
 * A key's value is its first line plus every more-indented line under it,
 * joined with single spaces — which is exactly what `>-` means and what a bare
 * wrapped value means too.
 */
export function parseBlockList(body: string): Block[] {
  const blocks: Block[] = [];
  let block: Block | null = null;
  let key: string | null = null;
  for (const [index, raw] of body.split("\n").entries()) {
    const opener = /^-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (opener) {
      block = { fields: { [opener[1]]: opener[2].trim() }, line: index + 1 };
      key = opener[1];
      blocks.push(block);
      continue;
    }
    if (block === null) continue;
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      block = null;
      key = null;
      continue;
    }
    const field = /^\s{2}([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (field) {
      key = field[1];
      block.fields[key] = field[2].trim();
      continue;
    }
    if (key !== null && /^\s{3,}\S/.test(raw)) {
      const folded = `${block.fields[key]} ${raw.trim()}`.trim();
      block.fields[key] = folded;
    }
  }
  for (const entry of blocks) {
    for (const name of Object.keys(entry.fields)) {
      // `>-` and `>` open a folded value; the fold has already happened above,
      // so the marker itself is not part of the value.
      entry.fields[name] = entry.fields[name].replace(/^>-?\s*/, "").trim();
    }
  }
  return blocks;
}

/**
 * `vqc/steering.yaml` — a human correction captured at the moment it was given.
 * The correction is the standing rule; the trigger says when it applies, and
 * the owner says whose taste it is, so an entry owned by anyone else is not
 * his intent and is left out.
 */
export function parseSteering(args: { path: string; body: string }): IntentLine[] {
  const lines: IntentLine[] = [];
  for (const block of parseBlockList(args.body)) {
    const { id, kind, owner, created, trigger, correction } = block.fields;
    if (id === undefined || correction === undefined) continue;
    if ((owner ?? "").toLowerCase() !== "tom") continue;
    const at = created === undefined ? null : parseDate(created);
    lines.push({
      id: `${args.path}#${id}`,
      kind: "standing-rule",
      text: correction,
      section: kind === undefined ? "steering" : kind,
      voice: "his",
      source: args.path,
      locator: id,
      at,
      dateText: created ?? null,
      evidence: trigger === undefined
        ? []
        : [{ form: "trigger", text: trigger, date: created ?? null }],
    });
  }
  return lines;
}

/**
 * The rulings log of `vqc/adoption.md`: one settled question per entry, with
 * his ruling on it. The ruling is the line; the question is its evidence.
 */
export function parseAdoptionRulings(args: { path: string; body: string }): IntentLine[] {
  const start = args.body.indexOf("## Rulings log");
  if (start < 0) return [];
  const before = args.body.slice(0, start).split("\n").length - 1;
  const rest = args.body.slice(start);
  const end = rest.indexOf("\n## ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const lines: IntentLine[] = [];
  for (const block of parseBlockList(section)) {
    const { id, date, question, ruling, cites } = block.fields;
    if (id === undefined || ruling === undefined) continue;
    lines.push({
      id: `${args.path}#${id}`,
      kind: "ruling",
      text: ruling,
      section: "Rulings log",
      voice: "his",
      source: args.path,
      locator: `line ${before + block.line}`,
      at: date === undefined ? null : parseDate(date),
      dateText: date ?? null,
      evidence: [
        ...(question === undefined ? [] : [{ form: "question", text: question, date: date ?? null }]),
        ...(cites === undefined ? [] : [{ form: "cites", text: cites, date: null }]),
      ],
    });
  }
  return lines;
}

/**
 * The spec's dated revision notes: `**Revision (2026-09-05, the lifeos
 * update):** …`, each one the rulings of his that the revision applied, in the
 * words the spec recorded them in.
 */
export function parseSpecRevisions(args: { path: string; body: string }): IntentLine[] {
  const lines: IntentLine[] = [];
  const pattern = /^\*\*Revision \(([^,)]+)(?:,\s*([^)]*))?\):?\*\*\s*(.*)$/;
  for (const [index, raw] of args.body.split("\n").entries()) {
    const hit = pattern.exec(raw.trim());
    if (hit === null) continue;
    const date = hit[1].trim();
    const at = parseDate(date);
    if (at === null) continue;
    lines.push({
      id: `${args.path}#${index + 1}`,
      kind: "ruling",
      text: hit[3].trim(),
      section: (hit[2] ?? "").trim() || "Revision",
      voice: "his",
      source: args.path,
      locator: `line ${index + 1}`,
      at,
      dateText: date,
      evidence: [],
    });
  }
  return lines;
}

/**
 * An `AGENTS.md`: every bullet is a rule that binds every run in that tree.
 * They carry no evidence file, so they are `unattributed` — nobody has written
 * down which of his words each one came from, and saying "inferred about him"
 * would claim more than the file does.
 */
export function parseRepoRules(args: { repo: string; path: string; body: string }): IntentLine[] {
  const where = `${args.repo} ${args.path}`;
  return parseBullets(args.body).map((bullet) => ({
    id: `${where}#${bullet.line}`,
    kind: "standing-rule" as const,
    text: bullet.text,
    section: bullet.section,
    voice: "unattributed" as const,
    source: where,
    locator: `line ${bullet.line}`,
    at: null,
    dateText: null,
    evidence: [],
  }));
}
