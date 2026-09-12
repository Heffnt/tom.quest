import { describe, expect, it } from "vitest";

import {
  BRIEF_RULES,
  MAX_BRIEF_CHARS,
  RULES,
  countSentences,
  failuresFor,
} from "./check-writing-standard.mjs";

/** A minimal document that satisfies every mechanical rule, so a test can add
 *  exactly one thing and see exactly one rule react. */
function doc({ style = "body{color:#e2e8f0}", body = "<p>Prose.</p>" } = {}) {
  return `<!DOCTYPE html><html><head><style>${style}</style></head><body><h1>Subject</h1>${body}</body></html>`;
}

describe("the baseline document", () => {
  it("breaks no rule", () => {
    expect(failuresFor(doc())).toEqual([]);
  });
});

describe("a document may describe the rule it obeys", () => {
  // The case this narrowing exists for. The ground-up explanation of todo
  // ph791scq7np10abq9ge22h7p7s8df3vc lists the rules the form imposes, and
  // before 2026-09-01 the css-import rule matched its own name inside a
  // <code> element and failed the document that was obeying it.
  it("passes when the banned constructs are quoted inside <code>", () => {
    const quoting = doc({
      body:
        "<p>It must contain no <code>&lt;script&gt;</code>; no inline event " +
        "handler such as <code>onclick=&quot;go()&quot;</code>; no external " +
        "stylesheet <code>&lt;link rel=&quot;stylesheet&quot;&gt;</code>; no " +
        "<code>@import</code>; and no <code>href=&quot;https://example.com&quot;" +
        "</code> of any kind.</p>",
    });
    expect(failuresFor(quoting)).toEqual([]);
  });

  it("passes when the same list sits in a <pre> block", () => {
    const quoting = doc({
      body: `<pre>@import url(x.css)\nonclick="go()"\nsrc="https://example.com/a.png"</pre>`,
    });
    expect(failuresFor(quoting)).toEqual([]);
  });
});

describe("the constructs still fail where they are live", () => {
  it("flags @import inside the <style> block", () => {
    expect(failuresFor(doc({ style: "@import url('x.css');body{color:#fff}" }))).toEqual([
      "css-import",
    ]);
  });

  it("flags an inline handler on a real attribute", () => {
    expect(failuresFor(doc({ body: `<p onclick="go()">Prose.</p>` }))).toEqual([
      "inline-handler",
    ]);
  });

  it("flags an inline handler on the <code> element's own start tag", () => {
    // proseView empties a code element's TEXT and keeps its start tag, so the
    // narrowing cannot be used to smuggle an attribute in.
    expect(failuresFor(doc({ body: `<code onclick="go()">@import</code>` }))).toEqual([
      "inline-handler",
    ]);
  });

  it("flags a real external address", () => {
    expect(failuresFor(doc({ body: `<img src="https://example.com/a.png">` }))).toEqual([
      "external-url",
    ]);
  });

  it("flags an UNESCAPED <script> inside <code>, which really runs", () => {
    // The HTML parser does not care that a tag sits inside a <code> element.
    // This is why the script rule reads the whole document and was not
    // narrowed with the others.
    expect(failuresFor(doc({ body: "<code><script>go()</script></code>" }))).toContain(
      "script",
    );
  });

  it("flags an UNESCAPED stylesheet <link> inside <code>, which really loads", () => {
    expect(
      failuresFor(doc({ body: `<code><link rel="stylesheet" href="x.css"></code>` })),
    ).toEqual(["external-stylesheet"]);
  });
});

describe("the structural rules", () => {
  it("flags a document that does not open at <!DOCTYPE html>", () => {
    expect(failuresFor("<html><head><style>a{}</style></head><body><h1>x</h1></body></html>")).toEqual(
      ["no-doctype"],
    );
  });

  it("flags markdown, which breaks all four", () => {
    expect(failuresFor("# Subject\n\nSome prose.")).toEqual([
      "no-doctype",
      "no-close-html",
      "no-h1",
      "no-style",
    ]);
  });
});

describe("stored briefs", () => {
  // Briefs are markdown by construction (convex/schema.ts), and every rule in
  // RULES is a rule of the HTML-document form — none of that shape is
  // demanded of a brief. BRIEF_RULES instead holds the prepare prompt's own
  // mechanical demands (below), so a plain-prose brief that meets them passes
  // even though it is not HTML at all.
  it("applies no HTML-form rule to a markdown brief", () => {
    const brief = "Plain prose in three short sentences. It never opens a tag. It ends here.";
    expect(failuresFor(brief, BRIEF_RULES)).toEqual([]);
  });

  it("would fail every HTML-form rule if RULES were applied to one", () => {
    expect(failuresFor("# A brief\n\nPlain markdown prose.", RULES).length).toBeGreaterThan(0);
  });
});

describe("BRIEF_RULES — the prepare prompt's own demands, made mechanical", () => {
  const CLEAN_BRIEF =
    "Fix the flaky retry loop in the poller. It drops events under load. " +
    "Ship the patch behind a feature flag.";

  it("is exactly the four rules named in the brief, in that order", () => {
    expect(BRIEF_RULES.length).toBe(4);
    expect(BRIEF_RULES.map((r) => r.id)).toEqual([
      "brief-sentences",
      "brief-ellipsis",
      "brief-markup",
      "brief-length",
    ]);
  });

  it("every rule reads the document view", () => {
    for (const rule of BRIEF_RULES) {
      expect(rule.on).toBe("document");
    }
  });

  it("a clean brief passes all four", () => {
    expect(CLEAN_BRIEF.length).toBeLessThan(MAX_BRIEF_CHARS);
    expect(failuresFor(CLEAN_BRIEF, BRIEF_RULES)).toEqual([]);
  });

  describe("brief-sentences", () => {
    it("fails a brief with too few sentences (one, no terminator)", () => {
      expect(failuresFor("Fix the poller", BRIEF_RULES)).toEqual(["brief-sentences"]);
    });

    it("fails a brief with too many sentences (six)", () => {
      expect(failuresFor("One. Two. Three. Four. Five. Six.", BRIEF_RULES)).toEqual([
        "brief-sentences",
      ]);
    });

    it("fails an empty or whitespace-only brief (zero sentences counted)", () => {
      expect(countSentences("   ")).toBe(0);
      expect(failuresFor("   ", BRIEF_RULES)).toContain("brief-sentences");
    });
  });

  describe("brief-ellipsis", () => {
    it("fails a brief with a literal ... ", () => {
      expect(
        failuresFor(
          "Fix the poller now. It might work eventually... we will see.",
          BRIEF_RULES,
        ),
      ).toEqual(["brief-ellipsis"]);
    });

    it("fails a brief with a unicode … ", () => {
      expect(
        failuresFor("Fix the poller now. It might work eventually… we will see.", BRIEF_RULES),
      ).toEqual(["brief-ellipsis"]);
    });
  });

  describe("brief-markup", () => {
    it("fails a brief opening with a markdown heading", () => {
      expect(
        failuresFor("# Fix the poller\n\nIt drops events. Ship it now.", BRIEF_RULES),
      ).toEqual(["brief-markup"]);
    });

    it("fails a brief carrying a list bullet", () => {
      expect(
        failuresFor("Fix the poller. It drops events under load.\n- ship the patch", BRIEF_RULES),
      ).toEqual(["brief-markup"]);
    });

    it("fails a brief carrying a numbered list item", () => {
      expect(
        failuresFor("Fix the poller. It drops events under load.\n1. ship the patch", BRIEF_RULES),
      ).toEqual(["brief-markup"]);
    });

    it("fails a brief carrying a code fence", () => {
      expect(
        failuresFor("Fix the poller. It drops events under load.\n```\nretry()\n```", BRIEF_RULES),
      ).toEqual(["brief-markup"]);
    });
  });

  describe("brief-length", () => {
    it("fails a brief over MAX_BRIEF_CHARS", () => {
      const long = `Fix the poller. ${"x".repeat(410)} Ship it now.`;
      expect(long.length).toBeGreaterThan(MAX_BRIEF_CHARS);
      expect(failuresFor(long, BRIEF_RULES)).toEqual(["brief-length"]);
    });

    it("passes a brief exactly at MAX_BRIEF_CHARS", () => {
      const prefix = "Fix the poller. ";
      const suffix = " Ship it now.";
      const atLimit = prefix + "x".repeat(MAX_BRIEF_CHARS - prefix.length - suffix.length) + suffix;
      expect(atLimit.length).toBe(MAX_BRIEF_CHARS);
      expect(failuresFor(atLimit, BRIEF_RULES)).toEqual([]);
    });
  });
});

describe("every rule declares which view it reads", () => {
  it("uses only known views", () => {
    for (const rule of RULES) {
      expect(["document", "prose", "style"]).toContain(rule.on);
    }
  });
});
