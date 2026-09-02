// DESIGN.md §2 lists the words banned from /perfume code, types, Convex fields
// and player-facing copy — each with the single living word that replaced it —
// and says outright that finding one is a defect. This test is the CI half of
// that rule for the CLIENT half of the app: every TypeScript source file under
// app/perfume is read and matched against the banned words.
//
// The reason it exists: "outputs" survived its own retirement for weeks because
// the Convex side renamed the field to `cauldron` while the store translated it
// straight back at the read boundary (`outputs: brewDoc.cauldron.map(...)`),
// which is invisible to a type checker — both names described the same list, so
// nothing failed. A grep is the only thing that catches a dead word, so the grep
// runs in CI.
//
// Only the unambiguous rows of the §2 table are listed. Three are deliberately
// left out because their letters also spell something living, and a guard that
// cries wolf gets deleted:
//   - "book" is still the frozen presence-surface key (data-pf-surface="book"),
//   - "owners" shares its stem with the living owner/ownership of a brew,
//   - "local" appears in localStorage and in "client-local", both fine.
// Adding a row here is the last step of retiring a word, not the first.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = __dirname;

// Each dead word as a case-insensitive regular expression, paired with the
// living replacement DESIGN.md §2 names for it.
const DEAD_WORDS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /output/i, replacement: "cauldron (perfumes sit on the cauldron)" },
  { pattern: /tuning/i, replacement: "recipe" },
  { pattern: /bottling/i, replacement: "brewing" },
  { pattern: /bottle/i, replacement: "perfume" },
  { pattern: /phial/i, replacement: "perfume" },
  { pattern: /\bbench(es)?\b/i, replacement: "brew" },
  { pattern: /\bpots?\b/i, replacement: "brew / cauldron node" },
  { pattern: /transfer/i, replacement: "gifting" },
  { pattern: /anonId/i, replacement: "(deleted — membership is login-only)" },
  { pattern: /practice mode/i, replacement: "(deleted — no sandbox)" },
];

// This file is skipped: it is the one place under app/perfume that must spell
// the dead words out, and scanning itself would fail every case.
const SELF = "vocabulary.test.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry === SELF) continue;
    if (extname(entry) === ".ts" || extname(entry) === ".tsx") out.push(full);
  }
  return out;
}

describe("DESIGN.md §2 dead words are absent from the /perfume client", () => {
  const files = sourceFiles(ROOT);

  it("finds the client source tree at all", () => {
    // A broken walk would make every case below pass vacuously.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { pattern, replacement } of DEAD_WORDS) {
    it(`no "${pattern.source}" — use ${replacement}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
