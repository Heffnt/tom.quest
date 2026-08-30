// The daemon's two pure workspace decisions. They live in lib.mjs (not
// session.mjs) precisely so this file can reach them without importing the
// Claude Agent SDK, and they are the half of the multi-repo contract that has
// no Convex test to catch it: convex/claudeSessions.test.ts pins what the
// SERVER writes and says, and these pin what the DAEMON builds from it.

import { describe, expect, it } from "vitest";
import { resolveSessionRepos, sessionWorkdir } from "./lib.mjs";

const BASE = "/var/cache/tts/sessions/abc123";

describe("resolveSessionRepos", () => {
  // witness: return `repos ?? [repo]` without the length check and a server
  // sending `repos: []` for a scratch session would make the daemon try to
  // clone nothing and then stand in a directory it never created.
  it("reads the list when the server sent one", () => {
    expect(resolveSessionRepos("tom.quest", ["tom.quest", "WikiTom"])).toEqual([
      "tom.quest",
      "WikiTom",
    ]);
  });

  // The back-compat path this whole two-field design exists for: a session row
  // written before the ruling, and a daemon running against a server that has
  // not been deployed yet. witness: drop the fallback and every such session
  // gets an empty scratch dir instead of its checkout.
  it("falls back to the single repo when no list arrives", () => {
    expect(resolveSessionRepos("tom.quest", undefined)).toEqual(["tom.quest"]);
    expect(resolveSessionRepos("tom.quest", [])).toEqual(["tom.quest"]);
  });

  // "none" is the ABSENCE of a repo, not a repo. witness: let it through and
  // the daemon looks up REPO_GITHUB["none"], throws, and fails the session —
  // which is exactly what every groundwork mission is.
  it('turns "none" and a missing repo into no repos at all', () => {
    expect(resolveSessionRepos("none", undefined)).toEqual([]);
    expect(resolveSessionRepos(undefined, undefined)).toEqual([]);
    expect(resolveSessionRepos(null, undefined)).toEqual([]);
  });
});

describe("sessionWorkdir", () => {
  it("stands in an empty scratch directory when there is no repo", () => {
    expect(sessionWorkdir(BASE, [])).toBe(`${BASE}/ws`);
  });

  // The shape deliberately left alone by the multi-repo work. witness: return
  // `base` here too and every existing single-repo mission's `pwd` stops being
  // a git repository, while its prompt still says it is a fresh checkout.
  it("stands INSIDE the checkout when there is exactly one repo", () => {
    expect(sessionWorkdir(BASE, [`${BASE}/tom.quest`])).toBe(
      `${BASE}/tom.quest`,
    );
  });

  // witness: return repoDirs[0] here and a session given two repos would open
  // inside the first one, with the second a sibling of its own working
  // directory — reachable only by a "../" path nothing in the prompt mentions.
  it("stands in the PARENT when there is more than one repo", () => {
    expect(
      sessionWorkdir(BASE, [`${BASE}/tom.quest`, `${BASE}/WikiTom`]),
    ).toBe(BASE);
  });
});
