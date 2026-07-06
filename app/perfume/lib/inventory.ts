// Pure inventory operations for the Perfumer (/perfume).
// No React, no Convex — shared by the input panel, the brew stores, and the
// import dialog. All ops are immutable: they return a new Inventory and never
// touch the input.

import type { ImportRow, Inventory, StackSection } from "./brew-types";
import { inventorySectionFor } from "./brew-types";

// The name lookup the parser/formatter needs — callers pass whatever slice of
// the catalog the inventory may hold (ingredients + pures, plus perfumes for
// formatting).
export type CatalogEntry = { key: string; name: string };

// ── count ops ────────────────────────────────────────────────────────────────
// `section` defaults to the key's auto-section (pures vs ingredients).
// Perfume keys look like ingredient keys ("base:<id>"), so callers touching
// the perfumes section MUST pass it explicitly.

export function getCount(
  inv: Inventory,
  itemKey: string,
  section: StackSection = inventorySectionFor(itemKey),
): number {
  return inv[section][itemKey] || 0;
}

export function addCount(
  inv: Inventory,
  itemKey: string,
  n = 1,
  section: StackSection = inventorySectionFor(itemKey),
): Inventory {
  if (n <= 0) return inv;
  return {
    ...inv,
    [section]: { ...inv[section], [itemKey]: (inv[section][itemKey] || 0) + n },
  };
}

// Clamps at zero; a zeroed count is deleted so sections never carry dead keys.
export function removeCount(
  inv: Inventory,
  itemKey: string,
  n = 1,
  section: StackSection = inventorySectionFor(itemKey),
): Inventory {
  if (n <= 0) return inv;
  const have = inv[section][itemKey] || 0;
  const next = { ...inv[section] };
  if (have - n <= 0) delete next[itemKey];
  else next[itemKey] = have - n;
  return { ...inv, [section]: next };
}

// ── import parsing ───────────────────────────────────────────────────────────
// Catalog names contain only letters, apostrophes and spaces, and never
// digits — so any integer on a line can only be a count, and normalization
// may drop punctuation wholesale.

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

// Classic two-row Levenshtein — small strings only (catalog names).
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// Similarity in [0,1]: exact-token overlap averaged with normalized
// whole-string Levenshtein, so both word-level hits ("noble") and near-miss
// spellings ("rose" vs "roses") pull the right candidate up.
function similarity(query: string, name: string): number {
  const qt = query.split(" ");
  const nt = name.split(" ");
  const hits = qt.filter((t) => nt.includes(t)).length;
  const overlap = hits / Math.max(qt.length, nt.length);
  const lev =
    1 - levenshtein(query, name) / Math.max(query.length, name.length);
  return (overlap + lev) / 2;
}

// Guesses below this read as noise, not typos — garbage lines get none.
const GUESS_MIN = 0.45;
const GUESS_MAX = 3;

// Tolerant free-text import. Per line: the first integer is the count
// (default 1); "x"/"×"/":"/","-style separators and quantity markers are
// stripped; the remaining words are matched against catalog names
// case-insensitively. Confident (itemKey set): normalized equality, or every
// query word appearing whole in exactly ONE catalog name ("roses" → Noble
// Roses). Whole words only — "noble rose" is NOT confident for "noble roses",
// it becomes the top-ranked guess. Blank lines are skipped; unmatched lines
// with no plausible guess come back {itemKey: null, guesses: []}.
export function parseInventoryText(
  text: string,
  catalog: CatalogEntry[],
): ImportRow[] {
  const entries = catalog.map((c) => ({
    ...c,
    norm: normalize(c.name),
    tokens: normalize(c.name).split(" "),
  }));
  const rows: ImportRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let count = 1;
    let counted = false;
    const words: string[] = [];
    for (const tok of normalize(line.replace(/×/g, "x")).split(" ")) {
      const qty = tok.match(/^x?(\d+)x?$/);
      if (qty) {
        if (!counted) {
          count = parseInt(qty[1], 10);
          counted = true;
        }
        continue; // quantity tokens never belong to a name
      }
      if (tok === "x") continue; // stray separator ("Noble Roses x 3")
      words.push(tok);
    }
    const query = words.join(" ");
    if (query === "") {
      rows.push({ line, count, itemKey: null, guesses: [] });
      continue;
    }
    const exact = entries.find((e) => e.norm === query);
    const wholeWord = exact
      ? []
      : entries.filter((e) => words.every((w) => e.tokens.includes(w)));
    const confident = exact ?? (wholeWord.length === 1 ? wholeWord[0] : null);
    if (confident) {
      rows.push({ line, count, itemKey: confident.key, guesses: [] });
      continue;
    }
    const guesses = entries
      .map((e) => ({ itemKey: e.key, name: e.name, score: similarity(query, e.norm) }))
      .filter((g) => g.score >= GUESS_MIN)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, GUESS_MAX);
    rows.push({ line, count, itemKey: null, guesses });
  }
  return rows;
}

// ── clipboard export ─────────────────────────────────────────────────────────

// "Name x3" per line: ingredients, then pures, then perfumes, each section
// alphabetical by display name. Output round-trips through
// parseInventoryText (exact name matches). Keys missing from the catalog
// fall back to the raw key rather than vanishing silently.
export function formatInventory(
  inv: Inventory,
  catalog: CatalogEntry[],
): string {
  const nameOf = new Map(catalog.map((c) => [c.key, c.name]));
  const sections: (keyof Inventory)[] = ["ingredients", "pures", "perfumes"];
  const lines: string[] = [];
  for (const section of sections) {
    const rows = Object.entries(inv[section])
      .filter(([, n]) => n > 0)
      .map(([key, n]) => ({ name: nameOf.get(key) ?? key, n }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const r of rows) lines.push(`${r.name} x${r.n}`);
  }
  return lines.join("\n");
}
