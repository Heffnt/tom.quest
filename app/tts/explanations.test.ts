// Every ground-up explanation shipped with the TTS captions is a COMPLETE,
// SELF-CONTAINED HTML DOCUMENT. This test is the CI half of that rule.
//
// The rule itself is the writing standard (WikiTom model-of-tom/writing.md): a ground-up
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

// ── THE OTHER HALF: THE CALL SITES ──────────────────────────────────────────
//
// The rule above is about the documents. This one is about where they are
// opened from, and it changed with the lifeos update (phase 7). It used to be
// "every caption carries a document", which was true while a document existed
// for every caption — including three that taught a reader how to read a
// screen. Those three are gone (readiness, the todo's text fields, the intent
// bar): pages never explain themselves, and a "more" control in front of page
// explainer text is still page explainer text. A caption on a control that
// writes one field on one row now carries its two plain sentences and no
// document, which is complete.
//
// What is left to hold is the other direction, and it is the one that rots
// silently: EVERY DOCUMENT IN THE MODULE IS OPENED FROM SOMEWHERE. A document
// no caption names is 10 kB shipped to the browser that no reader can reach,
// and nothing else would notice it. It is a source scan rather than a render
// test because there is no single screen that mounts every caption, and
// mounting each surface to count them would test the surfaces rather than the
// rule.
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

/**
 * What sits between the opening tag starting at `from` and its matching close
 * — "" when the tag closes itself. Same-name nesting is counted, so an Info
 * inside an Info would not end the outer one early.
 */
function childrenOf(
  src: string,
  from: number,
  name: string,
  tag: string,
): string {
  if (tag.trimEnd().endsWith("/>")) return "";
  const open = `<${name}`;
  const close = `</${name}>`;
  const start = from + tag.length;
  let i = start;
  let depth = 1;
  while (i < src.length) {
    const nextOpen = src.indexOf(open, i);
    const nextClose = src.indexOf(close, i);
    if (nextClose === -1) break; // unbalanced source: the whole tail
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + open.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return src.slice(start, nextClose);
    i = nextClose + close.length;
  }
  return src.slice(start);
}

/** Whether children amount to a sentence. A JSX comment is not one, and
 * neither is a lone {" "} — which is why this asks for letters and not for a
 * non-empty string. */
function saysSomething(children: string): boolean {
  return /[A-Za-z]/.test(children.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ""));
}

describe("every document is opened from a caption, and every caption explains", () => {
  const files = captionSources(join(__dirname));
  const sources = files.map((f) => ({
    short: f.slice(f.indexOf("app/tts")).replace(/\\/g, "/"),
    src: readFileSync(f, "utf8"),
  }));

  /** Every `<Info …>` / `<Caption …>` call site on the screens: the opening
   * tag, and what sits between it and its close. */
  type CaptionTag = { name: "Info" | "Caption"; tag: string; children: string };

  const tagsIn = (src: string): CaptionTag[] => {
    const tags: CaptionTag[] = [];
    for (const name of ["Info", "Caption"] as const) {
      const open = `<${name}`;
      for (
        let i = src.indexOf(open);
        i !== -1;
        i = src.indexOf(open, i + 1)
      ) {
        if (!/[\s>]/.test(src[i + open.length] ?? "")) continue;
        const tag = openingTag(src, i);
        tags.push({ name, tag, children: childrenOf(src, i, name, tag) });
      }
    }
    return tags;
  };

  it("finds the caption call sites at all", () => {
    // A scan that matches nothing would pass every assertion below while
    // checking nothing at all.
    const total = sources.reduce((n, f) => n + tagsIn(f.src).length, 0);
    expect(total).toBeGreaterThan(10);
  });

  for (const [name] of documents) {
    it(`${name} is opened from at least one caption`, () => {
      const opened = sources.filter((f) =>
        f.src.includes(`explanation={${name}}`),
      );
      expect(opened.map((f) => f.short).length).toBeGreaterThan(0);
    });
  }

  for (const { short, src } of sources) {
    const tags = tagsIn(src);
    if (tags.length === 0) continue;
    // The plain half is not optional: a popover carrying the bare call tells a
    // reader who already knows the codebase what they knew, and everyone else
    // nothing — which is the tooltip the one info mechanism replaced.
    //
    // WHERE THE PLAIN HALF LIVES differs between the two, so the question does
    // too (review finding). `<Info>` carries it as its CHILDREN, so an Info is
    // bare when it has none — and closing itself is only one way to have none:
    // `<Info call="x"></Info>`, or one holding nothing but whitespace and a
    // {" "}, is the same bare call and used to pass. `<Caption>` is the
    // wrapper todo-row puts around Info, whose children are the CALL and whose
    // plain half is the `explains` prop, so that is what it is asked for.
    it(`${short} explains all ${tags.length} of its captions in plain words`, () => {
      const bare = tags
        .filter((t) =>
          t.name === "Caption"
            ? !t.tag.includes("explains=")
            : !saysSomething(t.children),
        )
        .map((t) => t.tag);
      expect(bare).toEqual([]);
    });
  }
});
