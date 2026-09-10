// Tests for the relevance cut (worker/jobs/context-relevance.mjs).
//
// What is pinned here is RULE 9's ordering: which AGENTS.md a run is handed
// when a brief names one path in depth and mentions another in passing. The
// ordering used to be the AGENTS.md file's own depth, which in this repo is 1
// for `app/`, `convex/` and `worker/` alike — so every real tie fell through to
// the alphabet and a brief about `worker/jobs/...` was handed `app/`'s rules.
// The order is the TOKEN's now, and these tests are what says so.

import { describe, expect, it } from "vitest";

import { assembleContextParts, CAPS, SEARCH_QUESTIONS } from "./context-relevance.mjs";

const REPO = "tom.quest";

/** A record holding one todo whose brief is `brief`, in `REPO`. */
function recordWithBrief(brief) {
  return {
    today: "2026-09-10",
    todos: [{ id: "t1", category: "", brief, repos: [REPO], timingClass: "anytime" }],
    batches: [],
    rulings: [],
    sessions: [],
  };
}

/** Rule 9's inputs: a root AGENTS.md and one per named directory. */
function repoRules(bodyBytes) {
  const body = (label) => `${label} rules.${" x".repeat(Math.max(0, bodyBytes))}`;
  return [
    { repo: REPO, path: "AGENTS.md", body: "root rules." },
    { repo: REPO, path: "app/AGENTS.md", body: body("app") },
    { repo: REPO, path: "convex/AGENTS.md", body: body("convex") },
    { repo: REPO, path: "worker/AGENTS.md", body: body("worker") },
  ];
}

function assemble(brief, { bodyBytes = 0 } = {}) {
  return assembleContextParts({
    subject: { kind: "todo", todoId: "t1" },
    caller: "opener",
    pages: [],
    repoRules: repoRules(bodyBytes),
    record: recordWithBrief(brief),
  });
}

// The brief of this very task: one path named in depth, one mentioned in
// passing. `app/page.tsx` sorts first alphabetically and both AGENTS.md files
// sit at depth 1, so the old ordering handed over `app/`'s rules.
const BRIEF = [
  "Fix the repo-rule tie-break in worker/jobs/context-relevance.mjs so the",
  "matching token's depth decides. Nothing about app/page.tsx changes.",
].join("\n");

describe("rule 9 orders AGENTS.md by the matching token, not the file", () => {
  it("puts the deeply-named directory ahead of the passing mention", () => {
    const { manifest } = assemble(BRIEF);
    const agents = manifest.filter((entry) => entry.startsWith(`${REPO}:`));
    expect(agents[0]).toBe(`${REPO}:AGENTS.md`);
    expect(agents[1]).toBe(`${REPO}:worker/AGENTS.md`);
    expect(agents).toContain(`${REPO}:app/AGENTS.md`);
  });

  it("selects worker/AGENTS.md over app/AGENTS.md when only one nested file fits", () => {
    // Bodies sized so the root plus exactly one nested file clears
    // CAPS.agentsBytes and the second does not — the cut has to CHOOSE.
    const { manifest } = assemble(BRIEF, { bodyBytes: Math.floor(CAPS.agentsBytes * 0.3) });
    const agents = manifest.filter((entry) => entry.startsWith(`${REPO}:`));
    expect(agents).toEqual([`${REPO}:AGENTS.md`, `${REPO}:worker/AGENTS.md`]);
  });

  it("breaks a same-depth tie on the number of matching tokens", () => {
    const brief = "app/page.tsx and app/layout.tsx both change; worker/main.mjs is untouched.";
    const { manifest } = assemble(brief, { bodyBytes: Math.floor(CAPS.agentsBytes * 0.3) });
    const agents = manifest.filter((entry) => entry.startsWith(`${REPO}:`));
    expect(agents).toEqual([`${REPO}:AGENTS.md`, `${REPO}:app/AGENTS.md`]);
  });

  it("still falls back to file depth then path when the tokens tie outright", () => {
    const brief = "Touch app/page.tsx and worker/main.mjs, one line each.";
    const { manifest } = assemble(brief);
    const agents = manifest.filter((entry) => entry.startsWith(`${REPO}:`));
    expect(agents).toEqual([`${REPO}:AGENTS.md`, `${REPO}:app/AGENTS.md`, `${REPO}:worker/AGENTS.md`]);
  });
});

describe("the fetchable block's collapsed search line", () => {
  // Enough area pages to blow past FETCHABLE_BUDGET, which is what makes
  // shrinkFetchable replace the per-question lines with the one `--help` line.
  const manyAreas = Array.from({ length: 60 }, (_, i) => ({
    path: `model-of-tom/areas/area-with-a-long-enough-name-${i}.md`,
    body: "# Area\n\nBody.\n",
  }));

  it("names no count, because SEARCH_QUESTIONS grows", () => {
    const { fetchable, shrink } = assembleContextParts({
      subject: { kind: "laptop" },
      caller: "laptop",
      pages: manyAreas,
      repoRules: [],
      record: {},
    });
    expect(shrink.fetchable).toContain("search questions collapsed");
    expect(fetchable).toContain("the read-only search questions");
    // The line said "seven" while SEARCH_QUESTIONS held eight. No number at
    // all is the only form that cannot go stale again.
    expect(fetchable).not.toMatch(/(six|seven|eight|nine|ten|\d+) read-only search questions/);
    expect(SEARCH_QUESTIONS.length).toBeGreaterThan(7);
  });
});
