import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canSeePage, PAGES, rankPages, type Page, type PageRole } from "./page-routes";

const page = (visibility: Page["visibility"]): Page => ({
  slug: visibility,
  title: visibility,
  blurb: visibility,
  priority: 1,
  visibility,
});

describe("page registry", () => {
  const visibilityPages = [
    page("public"),
    page("authenticated"),
    page("admin"),
    page("tom"),
  ];

  it.each([
    ["guest", ["public"]],
    ["user", ["public", "authenticated"]],
    ["admin", ["public", "authenticated", "admin"]],
    ["tom", ["public", "authenticated", "admin", "tom"]],
  ] satisfies Array<[PageRole, Array<Page["visibility"]>]>)(
    "filters pages for %s",
    (role, visible) => {
      expect(visibilityPages.filter((entry) => canSeePage(role, entry)).map((entry) => entry.visibility)).toEqual(visible);
    },
  );

  // `agent` is the role a TTS session's headless browser holds. Its page list
  // IS the definition of what a session may look at, so it is asserted whole
  // and exactly — an extra slug appearing here is a widening nobody asked for.
  describe("the agent role", () => {
    it("sees turing and tts and nothing else", () => {
      expect(
        PAGES.filter((entry) => canSeePage("agent", entry)).map((entry) => entry.slug),
      ).toEqual(["turing", "tts"]);
    });

    // Named individually because each is a specific thing a session must not
    // reach: /canvas spends LLM credits through its agent route, and the other
    // three are Tom's own surfaces.
    it.each(["canvas", "sessions", "forge", "jarvis", "logo"])(
      "does not see /%s",
      (slug) => {
        const entry = PAGES.find((p) => p.slug === slug);
        expect(entry, `no page named ${slug}`).toBeDefined();
        expect(canSeePage("agent", entry!)).toBe(false);
      },
    );

    // It is a SIDE BRANCH, not a rank: it does not inherit "public" or
    // "authenticated" the way every role on the ladder does. That is exactly
    // what keeps /canvas shut, so it is asserted rather than left implied.
    it("does not inherit the ladder's public or authenticated pages", () => {
      expect(canSeePage("agent", page("public"))).toBe(false);
      expect(canSeePage("agent", page("authenticated"))).toBe(false);
      expect(canSeePage("agent", page("admin"))).toBe(false);
      expect(canSeePage("agent", page("tom"))).toBe(false);
    });

    // The flag opens a page for `agent` alone; it must not leak a Tom-only
    // page to a signed-out visitor or an ordinary user.
    it("leaves every other role's answer unchanged when the flag is set", () => {
      const flagged: Page = { ...page("tom"), agentReadable: true };
      expect(canSeePage("guest", flagged)).toBe(false);
      expect(canSeePage("user", flagged)).toBe(false);
      expect(canSeePage("admin", flagged)).toBe(false);
      expect(canSeePage("tom", flagged)).toBe(true);
      expect(canSeePage("agent", flagged)).toBe(true);
    });
  });

  it("ranks visible pages by priority when query is empty", () => {
    expect(rankPages("", "guest").map((entry) => entry.slug)).toEqual(["transformer", "thmm", "clouds", "perfume", "game", "bio", "boolback", "help"]);
    expect(rankPages("", "tom")[0]?.slug).toBe("turing");
  });

  // /turing (and the cluster terminal it links to) is admin-level, not Tom-only.
  // If this entry is ever narrowed to "tom", every non-Tom admin loses the terminal.
  it("keeps /turing visible to a plain admin", () => {
    const turing = PAGES.find((entry) => entry.slug === "turing");
    expect(turing?.visibility).toBe("admin");
    expect(canSeePage("admin", turing!)).toBe(true);
  });

  // The README's Quests table is a MIRROR of this registry, not a second home.
  // It drifted to 8 rows against 15 entries — /canvas, /transformer, /perfume,
  // /sessions, /tts, /forge and /boolback were live and listed nowhere — and two
  // of the 8 rows it did carry described the page differently from the registry
  // (/clouds "point-cloud viewer", /turing "GPU dashboard"). Nothing went red,
  // because nothing read the two together. This is that reader.
  //
  // Slug, order, blurb and visibility are all frozen: the "What" column and
  // `blurb` are the same fact, and the drift above is what a free-text column
  // costs. If the README ever wants richer prose than the registry's one line,
  // that is a deliberate change here, not something a page edit does by accident.
  describe("the README Quests table", () => {
    const README = join(__dirname, "..", "..", "README.md");
    const VISIBILITY_LABEL: Record<Page["visibility"], string> = {
      public: "Public",
      authenticated: "Authenticated",
      admin: "Admin",
      tom: "Tom",
    };

    // Rows of the one table under "## Quests", up to the next h2.
    const rows = (() => {
      const doc = readFileSync(README, "utf8");
      const start = doc.indexOf("\n## Quests\n");
      expect(start, "README.md has no '## Quests' section").toBeGreaterThan(-1);
      const rest = doc.slice(start + 1);
      const end = rest.indexOf("\n## ", 1);
      const section = end === -1 ? rest : rest.slice(0, end);
      return [...section.matchAll(/^\| `\/([a-z0-9-]+)` \| (.+?) \| (.+?) \|$/gm)].map(
        (m) => ({ slug: m[1], what: m[2].trim(), visibility: m[3].trim() }),
      );
    })();

    // Asserted before the comparison so a regex that stopped matching the table
    // fails loudly here instead of passing over an empty list.
    it("parses one row per registry entry", () => {
      expect(rows.length).toBe(PAGES.length);
    });

    it("lists every page, in registry order, with the registry's own words", () => {
      expect(rows).toEqual(
        PAGES.map((page) => ({
          slug: page.slug,
          what: page.blurb,
          visibility: VISIBILITY_LABEL[page.visibility],
        })),
      );
    });
  });

  it("prefers prefix matches before substring matches", () => {
    const pages: Page[] = [
      { slug: "alpha", title: "Alpha", blurb: "", priority: 1, visibility: "public" },
      { slug: "catalog", title: "Catalog", blurb: "", priority: 99, visibility: "public" },
      { slug: "atom", title: "Atom", blurb: "", priority: 2, visibility: "public" },
    ];

    expect(rankPages("a", "guest", pages).map((entry) => entry.slug)).toEqual(["atom", "alpha", "catalog"]);
  });
});
