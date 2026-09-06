// THE POPOVER IS THE CONTRACT. CLAUDE.md (Tom, 2026-08-29): one info
// mechanism, a tap-to-open popover whose content is what the control does on
// the backend with the exact call in mono; and every action label names its
// exact backend effect. explanations.test.ts holds the popovers themselves to
// the writing standard. This test is the other direction: every mutation the
// TTS screens fire is named, verbatim, by a popover somewhere on them — so a
// new control wired to a mutation nobody explains fails CI, and a popover
// that names a call nothing fires any more is noticed.
//
// A source scan rather than a render, for the same reason as the caption scan
// in explanations.test.ts: no single screen mounts every control, and
// mounting each surface would test the surfaces rather than the rule. The
// verdict surfaces, the newest, are additionally rendered in
// verdict-buttons.test.tsx, which checks a popover sits beside each button.
//
// What counts as fired: `useMutation(api.<module>.<function>)` in any .tsx
// under app/tts. What counts as named: the same `<module>.<function>(`
// opening a string literal — the `call=` of an Info, the `call:` of an info
// table, a Caption's children — anywhere under app/tts. Naming is checked
// across the population, not per file, because the batch card's verdicts are
// named in verdict-buttons.tsx and OptionsRow reads the same text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERDICTS } from "../lib";

const ROOT = join(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

const files = sources(ROOT).map((f) => ({
  short: f.slice(f.indexOf("app")).replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

/** Every mutation a screen fires, with the files that fire it. */
const fired = new Map<string, string[]>();
for (const { short, src } of files) {
  for (const m of src.matchAll(/useMutation\(\s*api\.(\w+)\.(\w+)\s*\)/g)) {
    const call = `${m[1]}.${m[2]}`;
    fired.set(call, [...(fired.get(call) ?? []), short]);
  }
}

/** Every call a popover names: `<module>.<function>(` opening a literal. */
const named = new Set<string>();
for (const { src } of files) {
  for (const m of src.matchAll(/["'`]\s*(\w+)\.(\w+)\(/g)) {
    named.add(`${m[1]}.${m[2]}`);
  }
}

describe("every mutation the TTS screens fire is named by a popover", () => {
  it("finds fired mutations and named calls at all", () => {
    // A scan matching nothing would pass the assertion below while checking
    // nothing.
    expect(fired.size).toBeGreaterThan(5);
    expect(named.size).toBeGreaterThan(5);
  });

  for (const [call, where] of [...fired].sort()) {
    it(`${call} (fired by ${where.join(", ")}) has a popover naming it`, () => {
      expect(named.has(call)).toBe(true);
    });
  }

  it("names no verdict the mutation does not accept", () => {
    // The closed set is lib.VERDICTS, the client's iterable of the union
    // convex/ttsRulings.ts accepts — read from there rather than restated, so
    // this test cannot go on allowing a word the mutation stopped taking.
    // "edit" and "defer" were both once labels on this page; neither is a
    // verdict.
    const allowed = new Set<string>(VERDICTS);
    const offered = new Set<string>();
    for (const { src } of files) {
      for (const m of src.matchAll(/verdict:\s*"([^"]+)"/g)) {
        // The verdict row builds its call from a TEMPLATE — `verdict:
        // "${verdict}"` — over lib.VERDICTS, so that form offers the four. A
        // scan that only matched `"(\w+)"` matched none of it, which is how
        // this assertion came to be checking nothing at all.
        if (/^\$\{\w+\}$/.test(m[1])) for (const v of VERDICTS) offered.add(v);
        else offered.add(m[1]);
      }
    }
    // Four at least, or the scan found nothing and asserts nothing.
    expect(offered.size).toBeGreaterThanOrEqual(4);
    expect([...offered].filter((v) => !allowed.has(v))).toEqual([]);
  });
});
