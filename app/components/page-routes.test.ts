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

  it("ranks visible pages by priority when query is empty", () => {
    expect(rankPages("", "guest").map((entry) => entry.slug)).toEqual(["thmm", "clouds", "game", "bio", "help"]);
    expect(rankPages("", "tom")[0]?.slug).toBe("turing");
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
