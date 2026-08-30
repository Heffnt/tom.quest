// REGRESSION. The first version of parseSlug used [^/.]+ for the repo name,
// which reads Heffnt/WikiTom and Heffnt/ComplexMultiTrigger perfectly and then
// refuses Heffnt/tom.quest — the one repo whose name contains a dot, and the
// repo this tool exists to open PRs against. It failed on first real use.
//
// The allowlist check downstream compares against REPO_GITHUB's values, so a
// slug that parses wrong is not a cosmetic bug: it either refuses a legitimate
// PR or, if it parsed too loosely, would accept a repo the daemon may not clone.

import { describe, expect, it } from "vitest";

import { parseSlug } from "./open-pr.mjs";
import { REPO_GITHUB } from "./repos.mjs";

describe("parseSlug", () => {
  it("reads a repo whose name contains a dot", () => {
    expect(parseSlug("https://github.com/Heffnt/tom.quest.git")).toBe(
      "Heffnt/tom.quest",
    );
    expect(parseSlug("https://github.com/Heffnt/tom.quest")).toBe(
      "Heffnt/tom.quest",
    );
  });

  it("reads the credential-bearing url the daemon actually clones with", () => {
    expect(
      parseSlug("https://x-access-token:ghs_secret@github.com/Heffnt/tom.quest.git"),
    ).toBe("Heffnt/tom.quest");
  });

  it("reads https and ssh forms", () => {
    expect(parseSlug("https://github.com/Heffnt/WikiTom.git")).toBe(
      "Heffnt/WikiTom",
    );
    expect(parseSlug("git@github.com:Heffnt/ComplexMultiTrigger.git")).toBe(
      "Heffnt/ComplexMultiTrigger",
    );
  });

  it("tolerates trailing slash and whitespace", () => {
    expect(parseSlug("  https://github.com/Heffnt/tom.quest.git/  \n")).toBe(
      "Heffnt/tom.quest",
    );
  });

  it("returns null for a non-GitHub remote", () => {
    expect(parseSlug("https://gitlab.com/Heffnt/tom.quest.git")).toBeNull();
    expect(parseSlug("/srv/local/bare.git")).toBeNull();
  });

  // The point of the whole exercise: every repo the daemon may clone must
  // round-trip, or tts-open-pr refuses a PR it should have opened.
  it.each(Object.values(REPO_GITHUB))("round-trips %s", (slug) => {
    expect(parseSlug(`https://github.com/${slug}.git`)).toBe(slug);
    expect(parseSlug(`https://x-access-token:tok@github.com/${slug}.git`)).toBe(
      slug,
    );
  });
});
