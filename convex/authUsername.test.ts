import { describe, expect, it } from "vitest";

import { accountEmail, normalizeUsername } from "./authUsername";

describe("normalizeUsername", () => {
  it("folds case", () => {
    expect(normalizeUsername("Tom")).toBe("tom");
    expect(normalizeUsername("TOM")).toBe("tom");
  });

  // THE BUG THIS FILE EXISTS FOR. When the rule lived in four copies, writing
  // one of them as `.replace(/[^a-z0-9]/g, "").toLowerCase()` — strip first,
  // then lowercase — deleted every capital letter instead of folding it, so
  // "Tom" became "om" in that copy and "tom" in the other three. Nothing threw
  // and nothing failed to typecheck: the login simply matched a different
  // account. This asserts the order that makes capitals survive.
  it("lowercases BEFORE stripping, so capitals survive", () => {
    expect(normalizeUsername("Tom")).toBe("tom");
    expect(normalizeUsername("TomQuest")).toBe("tomquest");
    expect(normalizeUsername("ABC123")).toBe("abc123");
  });

  it("strips everything outside a-z and 0-9", () => {
    expect(normalizeUsername("t-o_m.q")).toBe("tomq");
    expect(normalizeUsername("  tom  ")).toBe("tom");
    expect(normalizeUsername("tom@tom.quest")).toBe("tomtomquest");
  });

  it("returns the empty string when nothing survives", () => {
    expect(normalizeUsername("")).toBe("");
    expect(normalizeUsername("!!!")).toBe("");
    expect(normalizeUsername("   ")).toBe("");
  });

  it("is idempotent: normalizing a normalized name changes nothing", () => {
    for (const raw of ["Tom", "t-o_m", "ABC123", "  Quest  "]) {
      expect(normalizeUsername(normalizeUsername(raw))).toBe(
        normalizeUsername(raw),
      );
    }
  });
});

describe("accountEmail", () => {
  it("builds the address the users table's email index holds", () => {
    expect(accountEmail("Tom")).toBe("tom@tom.quest");
    expect(accountEmail("t-o_m")).toBe("tom@tom.quest");
  });

  it("refuses to build an address with an empty local part", () => {
    expect(accountEmail("!!!")).toBeNull();
    expect(accountEmail("")).toBeNull();
  });

  it("agrees with normalizeUsername on which account a name means", () => {
    for (const raw of ["Tom", "TOM", "t.o.m", " tom "]) {
      expect(accountEmail(raw)).toBe(`${normalizeUsername(raw)}@tom.quest`);
    }
  });
});
