import { describe, expect, it } from "vitest";
import { canSee, PAGE_ACCESS, type PageRole, type PageSlug, type PageVisibility } from "@/convex/pageAccess";
import { PAGES, rankPages, type Page } from "./page-routes";

const slugs = Object.keys(PAGE_ACCESS) as PageSlug[];

describe("page registry", () => {
  // The page list and the access table are one set of slugs: a page with no
  // row would have no answer to who may see it, and a row with no page would
  // be an access rule for nothing.
  it("lists exactly the pages the access table has rows for", () => {
    expect(PAGES.map((page) => page.slug).sort()).toEqual([...slugs].sort());
  });

  it.each([
    ["guest", ["public"]],
    ["user", ["public", "authenticated"]],
    ["admin", ["public", "authenticated", "admin"]],
    ["tom", ["public", "authenticated", "admin", "tom"]],
  ] satisfies Array<[PageRole, PageVisibility[]]>)(
    "lets %s see the pages on its rung of the ladder and below",
    (role, visible) => {
      for (const slug of slugs) {
        expect(canSee(role, slug), `${role} on /${slug}`).toBe(
          (visible as string[]).includes(PAGE_ACCESS[slug].visibility),
        );
      }
    },
  );

  // `agent` is the role a TTS session's headless browser holds. Its page list
  // IS the definition of what a session may look at, so it is asserted whole
  // and exactly — an extra slug appearing here is a widening nobody asked for.
  describe("the agent role", () => {
    it("sees turing and jarvis and nothing else", () => {
      expect(
        PAGES.filter((entry) => canSee("agent", entry.slug)).map((entry) => entry.slug),
      ).toEqual(["turing", "jarvis"]);
    });

    // Named individually because each is a specific thing a session must not
    // reach: /canvas spends LLM credits through its agent route, and the other
    // three are Tom's own surfaces.
    it.each(["canvas", "agents", "forge", "logo", "intent", "secrets"] as const)(
      "does not see /%s",
      (slug) => {
        expect(canSee("agent", slug)).toBe(false);
      },
    );

    // It is a SIDE BRANCH, not a rank: it does not inherit "public" or
    // "authenticated" the way every role on the ladder does. That is exactly
    // what keeps /canvas shut, so it is asserted rather than left implied.
    it("does not inherit the ladder's public or authenticated pages", () => {
      for (const slug of slugs) {
        if (PAGE_ACCESS[slug].visibility === "tom" || PAGE_ACCESS[slug].visibility === "admin") continue;
        expect(canSee("agent", slug), `agent on /${slug}`).toBe(false);
      }
    });

    // The flag opens a page for `agent` alone; it must not leak a Tom-only
    // page to a signed-out visitor or an ordinary user.
    it("leaves every other role's answer unchanged when the flag is set", () => {
      expect(PAGE_ACCESS.jarvis).toMatchObject({ visibility: "tom", agentReadable: true });
      expect(canSee("guest", "jarvis")).toBe(false);
      expect(canSee("user", "jarvis")).toBe(false);
      expect(canSee("admin", "jarvis")).toBe(false);
      expect(canSee("tom", "jarvis")).toBe(true);
      expect(canSee("agent", "jarvis")).toBe(true);
    });
  });

  it("ranks visible pages by priority when query is empty", () => {
    expect(rankPages("", "guest").map((entry) => entry.slug)).toEqual(["transformer", "thmm", "clouds", "perfume", "game", "bio", "boolback", "help"]);
    expect(rankPages("", "tom")[0]?.slug).toBe("turing");
  });

  // /turing (and the cluster terminal it links to) is admin-level, not Tom-only.
  // If this entry is ever narrowed to "tom", every non-Tom admin loses the terminal.
  it("keeps /turing visible to a plain admin", () => {
    expect(PAGE_ACCESS.turing.visibility).toBe("admin");
    expect(canSee("admin", "turing")).toBe(true);
  });

  // The two pages of his own record: what he wants to be true, and the words
  // the system says it in. Both are Tom-only and neither is agent-readable —
  // a headless session looking at a page it changed has no business reading
  // his intent.
  it("keeps /intent Tom-only", () => {
    expect(PAGE_ACCESS.intent).toEqual({ visibility: "tom", label: "Intent" });
    expect(canSee("tom", "intent")).toBe(true);
    expect(canSee("admin", "intent")).toBe(false);
    expect(canSee("guest", "intent")).toBe(false);
  });

  it("prefers prefix matches before substring matches", () => {
    const pages: Page[] = [
      { slug: "help", title: "Help", blurb: "", priority: 1 },
      { slug: "thmm", title: "THMM", blurb: "", priority: 99 },
      { slug: "bio", title: "Bio", blurb: "", priority: 3 },
      { slug: "boolback", title: "Boolback", blurb: "", priority: 2 },
    ];

    expect(rankPages("h", "guest", pages).map((entry) => entry.slug)).toEqual(["help", "thmm"]);
    expect(rankPages("b", "guest", pages).map((entry) => entry.slug)).toEqual(["bio", "boolback"]);
  });
});
