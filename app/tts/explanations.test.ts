// Every ground-up explanation shipped with the TTS captions is a COMPLETE,
// SELF-CONTAINED HTML DOCUMENT. This test is the CI half of that rule.
//
// The rule itself is WRITING_STANDARD (convex/ttsShared.ts): a ground-up
// explanation renders fullscreen inside a sandboxed iframe with no scripting
// and no network, so a <script>, an inline event handler, an external
// stylesheet, font, image, or URL is not a style slip — it is a hole in the
// page, blank at the moment it is read.
//
// scripts/check-writing-standard.mjs already checks these same rules, but it
// checks the explanations STORED IN PROD CONVEX: it reads them over the
// network with a worker key CI does not hold, so it is a report run on demand,
// never a gate. The constants in app/tts/explanations.ts are the other
// population — written in the source tree, shipped in the bundle — and this
// test is what holds them to the rule, one case per exported document, so a
// new caption added by the migration cannot land unchecked.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as explanations from "./explanations";

const RULES: { id: string; why: string; fails: (s: string) => boolean }[] = [
  {
    id: "no-doctype",
    why: "must open at <!DOCTYPE html>",
    fails: (s) => !s.toLowerCase().startsWith("<!doctype html"),
  },
  {
    id: "no-close-html",
    why: "must close at </html>",
    fails: (s) => !s.toLowerCase().endsWith("</html>"),
  },
  {
    id: "no-h1",
    why: "must carry one <h1> naming the subject",
    fails: (s) => !/<h1[\s>]/i.test(s),
  },
  {
    id: "no-style",
    why: "must carry one inline <style> block",
    fails: (s) => !/<style[\s>]/i.test(s),
  },
  {
    id: "script",
    why: "renders in a sandbox with no scripting — no <script>",
    fails: (s) => /<script[\s>]/i.test(s),
  },
  {
    id: "inline-handler",
    why: "no inline event handlers (onclick=, onload=, …)",
    fails: (s) => /\son[a-z]+\s*=\s*["']/i.test(s),
  },
  {
    id: "external-stylesheet",
    why: "nothing loads from outside — no <link rel=stylesheet>",
    fails: (s) => /<link[^>]+stylesheet/i.test(s),
  },
  {
    id: "css-import",
    why: "nothing loads from outside — no @import",
    fails: (s) => /@import/i.test(s),
  },
  {
    id: "external-url",
    why: "no external font, image, or URL of any kind",
    fails: (s) => /(?:src|href)\s*=\s*["']?https?:/i.test(s),
  },
];

const documents = Object.entries(explanations).filter(
  ([, value]) => typeof value === "string",
) as [string, string][];

describe("caption ground-up explanations", () => {
  it("exports at least one document", () => {
    // A caption migration that empties this file has lost the worked example
    // the rest of it copies.
    expect(documents.length).toBeGreaterThan(0);
  });

  for (const [name, html] of documents) {
    it(`${name} is a complete self-contained HTML document`, () => {
      const s = html.trim();
      const broken = RULES.filter((r) => r.fails(s)).map(
        (r) => `${r.id} — ${r.why}`,
      );
      expect(broken).toEqual([]);
    });

    it(`${name} uses the dark palette the view opens over`, () => {
      // The document opens over the TTS screens; a light document is a flash
      // of white at the moment it is opened. Checking for the background is
      // enough to catch a page written to some other palette wholesale.
      expect(html).toContain("#0a0e17");
    });
  }
});

// ── THE OTHER HALF OF THE MIGRATION ─────────────────────────────────────────
//
// The rule above is about the documents. This one is about the call sites: as
// of 2026-08-31 every caption in app/tts carries a ground-up document, and a
// new caption that forgets one is the regression this catches. It is a source
// scan rather than a render test because there is no single screen that mounts
// all of them, and mounting each surface to count its captions would test the
// surfaces rather than the rule.
//
// `<Info>` is the caption control (./components/info); `<Caption>` is the thin
// wrapper todo-row.tsx puts around it. Both are checked. info.tsx itself is
// skipped — it DEFINES the prop — and so are the tests.

/** Every .tsx under app/tts that is not a test and not the control itself. */
function captionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...captionSources(full));
    } else if (
      name.endsWith(".tsx") &&
      !name.endsWith(".test.tsx") &&
      name !== "info.tsx"
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The text of the opening tag starting at `from`, which is the index of the
 * "<". Ends at the first ">" that is not inside a string or a braced
 * expression — children can contain ">", so the first ">" in the file is not
 * good enough.
 */
function openingTag(src: string, from: number): string {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

describe("every caption in app/tts carries a ground-up explanation", () => {
  const files = captionSources(join(__dirname));

  it("finds the caption call sites at all", () => {
    // A scan that matches nothing would pass every assertion below while
    // checking nothing at all.
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/<(Info|Caption)[\s>]/g)?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(10);
  });

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const short = file.slice(file.indexOf("app/tts"));
    const tags: string[] = [];
    for (let i = src.indexOf("<Info"); i !== -1; i = src.indexOf("<Info", i + 1)) {
      if (/[\s>]/.test(src[i + 5] ?? "")) tags.push(openingTag(src, i));
    }
    for (let i = src.indexOf("<Caption"); i !== -1; i = src.indexOf("<Caption", i + 1)) {
      if (/[\s>]/.test(src[i + 8] ?? "")) tags.push(openingTag(src, i));
    }
    if (tags.length === 0) continue;

    it(`${short} passes explanation= on all ${tags.length}`, () => {
      const missing = tags.filter((t) => !t.includes("explanation="));
      expect(missing).toEqual([]);
    });
  }
});
