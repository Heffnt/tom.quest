// Tests for the skill router (worker/jobs/skill-router.mjs).
//
// What is pinned here is THE ROUTING TABLE — which skills a run is granted for
// a caller, a subject and a working directory — plus the one correction the
// move made: the `categories:` brackets, which context-relevance.mjs left in
// the terms, so that the first and last category of every area page matched
// nothing.
//
// The eight area pages below are a deliberately synthetic routing fixture.
// Private area-page vocabulary belongs in WikiTom, not in this public test.

import path from "node:path";

import { describe, expect, it } from "vitest";
import { repoSkillName } from "../../scripts/skills.mjs";

import {
  areaTermsFor,
  CONTEXT_CALLERS,
  CONTEXT_CALLER_NAMES,
  INTENT_CALLERS,
  NO_BODY,
  REPO_AREA_CAP,
  routeSkills as routeSkillsWithCatalog,
  WEEK_CALLERS,
} from "./skill-router.mjs";

// ── The area pages ───────────────────────────────────────────────────────────

/** Synthetic `categories:` lines exercise routing without copying WikiTom. */
const FIXTURE_CATEGORIES = {
  admin: "[alpha, beta-gamma, delta]",
  "agent-systems": "[repo-signal, agent-signal, code-signal]",
  climbing: "[crag-signal, rope-signal, summit-signal]",
  "health-and-food": "[orchid-signal, meadow-signal, river-signal]",
  "mental-health": "[ember-signal, dawn-signal, cloud-signal]",
  money: "[coin-signal, ledger-signal, vault-signal]",
  research: "[lab-signal, study-signal, archive-signal]",
  social: "[circle-signal, gather-signal, bridge-signal]",
};

function fixturePage(name, categories) {
  const front = ["---", "updated: 2026-09-10", "reviewed:", "window_days: 30"];
  if (categories !== undefined) front.push(`categories: ${categories}`);
  front.push("---");
  return {
    path: `model-of-tom/areas/${name}.md`,
    body: `${front.join("\n")}\n\n# ${name}\n\n## Current state\n\nSomething true about ${name}.\n`,
  };
}

const PAGES = Object.entries(FIXTURE_CATEGORIES).map(([name, cats]) => fixturePage(name, cats));
const PAGE_SOURCE = "the synthetic fixture";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO = "tom.quest";
const REPO_DIR = "C:/Users/heffn/Desktop/tom.quest";
const AGENT_REPO_SIGNAL = "repo-signal";
const RESEARCH_REPO_SIGNAL = "lab-signal";

// Every real caller reads its catalog before it routes. The ordinary routing
// cases below model that contract; the publication cases exercise refusal.
const PUBLISHED = [
  "write",
  "know-intent",
  "know-week",
  ...PAGES.map((page) => `know-${path.basename(page.path, ".md")}`),
  repoSkillName(REPO),
  repoSkillName(AGENT_REPO_SIGNAL),
  repoSkillName("Byobu"),
];

function routeSkills(input) {
  return routeSkillsWithCatalog({ ...input, published: input.published ?? PUBLISHED });
}

function todoRecord(todo) {
  return { today: "2026-09-12", todos: [{ id: "t1", ...todo }], batches: [], rulings: [], sessions: [] };
}

/** The router's answer for one todo category, with no repo and no cwd. */
function routeCategory(category, caller = "opener") {
  return routeSkills({
    subject: { kind: "todo", todoId: "t1" },
    caller,
    pages: PAGES,
    record: todoRecord({ category }),
  });
}

/** Only the area skills of a grant list — the fixed know skills are their own
 * rows in the table and their own tests below. */
function areaSkills(granted) {
  return granted.filter((name) => name.startsWith("know-") && name !== "know-intent" && name !== "know-week");
}

// ── write ────────────────────────────────────────────────────────────────────

describe("write", () => {
  it("grants write to every declared caller", () => {
    for (const caller of CONTEXT_CALLER_NAMES) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted, caller).toContain("write");
    }
  });

  it("refuses a caller nobody declared", () => {
    expect(() => routeSkills({ subject: { kind: "none" }, caller: "nobody", pages: PAGES })).toThrow(/unknown caller/);
  });
});

// ── know-<area> ──────────────────────────────────────────────────────────────

describe(`a todo's category routes to one area skill (pages from ${PAGE_SOURCE})`, () => {
  const terms = areaTermsFor(PAGES);

  it("reads all eight pages and takes their terms from the categories line", () => {
    expect(terms.map((entry) => entry.area)).toEqual([
      "admin",
      "agent-systems",
      "climbing",
      "health-and-food",
      "mental-health",
      "money",
      "research",
      "social",
    ]);
    expect(terms.every((entry) => entry.source === "categories")).toBe(true);
  });

  for (const entry of terms) {
    it(`routes every category of ${entry.area} to know-${entry.area} and to no other area`, () => {
      for (const term of entry.terms) {
        expect(areaSkills(routeCategory(term).granted), `${entry.area}: ${term}`).toEqual([`know-${entry.area}`]);
      }
    });
  }

  it("routes an unmatched category to no area skill", () => {
    expect(areaSkills(routeCategory("nothing-is-in-this-category").granted)).toEqual([]);
    expect(areaSkills(routeCategory("").granted)).toEqual([]);
  });

  it("routes an area: subject to its own skill", () => {
    const { granted } = routeSkills({ subject: { kind: "area", area: "research" }, caller: "cli", pages: PAGES });
    expect(areaSkills(granted)).toEqual(["know-research"]);
  });

  it("refuses an area: subject with no page", () => {
    expect(() => routeSkills({ subject: { kind: "area", area: "gardening" }, caller: "cli", pages: PAGES })).toThrow(
      /no area page named gardening/,
    );
  });
});

describe("a batch takes two area skills", () => {
  it("takes the two the rank picks out of three named areas", () => {
    const record = {
      today: "2026-09-12",
      batches: [{ id: "b1", repos: [] }],
      todos: [
        { id: "t1", batchId: "b1", category: "lab-signal" },
        { id: "t2", batchId: "b1", category: "study-signal" },
        { id: "t3", batchId: "b1", category: "alpha" },
        { id: "t4", batchId: "b1", category: "beta-gamma" },
        { id: "t5", batchId: "b1", category: "crag-signal" },
      ],
      rulings: [],
      sessions: [],
    };
    const { granted } = routeSkills({
      subject: { kind: "batch", batchId: "b1" },
      caller: "batch-context",
      pages: PAGES,
      record,
    });
    // Two fixture areas have two members each, a third has one; the tie goes
    // to the area name.
    expect(areaSkills(granted)).toEqual(["know-admin", "know-research"]);
  });
});

// ── know-<area>, by repository ───────────────────────────────────────────────
//
// THE ROW THE MOVE LEFT UNWIRED. The category row above fires on almost
// nothing — 3 of 1,332 active todos carry a category and no batch carries one —
// while repos and codeRepo stand on 724 of them. These pin the mapping the area
// pages' own `categories:` lines already encode: tom.quest and wikitom are
// terms of agent-systems, complexmultitrigger a term of research.

describe("a subject's repository routes to one area skill", () => {
  const batchRecord = (batch, todos = []) => ({
    today: "2026-09-12",
    batches: [{ id: "b1", ...batch }],
    todos: todos.map((todo, index) => ({ id: `t${index + 1}`, batchId: "b1", ...todo })),
    rulings: [],
    sessions: [],
  });

  const routeBatch = (batch, todos = []) =>
    routeSkills({ subject: { kind: "batch", batchId: "b1" }, caller: "cli", pages: PAGES, record: batchRecord(batch, todos) });

  it("routes a batch whose repos match the agent signal to know-agent-systems", () => {
    expect(areaSkills(routeBatch({ repos: [AGENT_REPO_SIGNAL] }).granted)).toEqual(["know-agent-systems"]);
  });

  it("routes a todo's codeRepo signal to know-research", () => {
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ codeRepo: RESEARCH_REPO_SIGNAL }),
    });
    expect(areaSkills(granted)).toEqual(["know-research"]);
  });

  it("routes a batch member's codeRepo signal too, when the batch declares no repos", () => {
    expect(areaSkills(routeBatch({}, [{ codeRepo: RESEARCH_REPO_SIGNAL }]).granted)).toEqual(["know-research"]);
  });

  it("routes the agent signal to know-agent-systems, case and all", () => {
    expect(areaSkills(routeBatch({ repos: [AGENT_REPO_SIGNAL.toUpperCase()] }).granted)).toEqual(["know-agent-systems"]);
  });

  it("routes a repo: subject by its own name", () => {
    const { granted } = routeSkills({
      subject: { kind: "repo", repo: RESEARCH_REPO_SIGNAL, paths: ["src/x.py"] },
      caller: "cli",
      pages: PAGES,
    });
    expect(areaSkills(granted)).toEqual(["know-research"]);
  });

  it("gives a repository no area when no page's categories name it", () => {
    expect(areaSkills(routeBatch({ repos: ["unmatched-signal"] }).granted)).toEqual([]);
    expect(areaSkills(routeBatch({ repos: [] }).granted)).toEqual([]);
    const { granted } = routeSkills({
      subject: { kind: "repo", repo: "Byobu", paths: ["x.py"] },
      caller: "cli",
      pages: PAGES,
    });
    expect(areaSkills(granted)).toEqual([]);
    expect(granted).toContain(repoSkillName("Byobu"));
  });

  it("takes ONE area from the repositories however many they name", () => {
    expect(REPO_AREA_CAP).toBe(1);
    // Two repository-shaped values name one fixture area and one names
    // another, so the two-member area wins and it is the only one taken.
    const three = routeBatch({ repos: [AGENT_REPO_SIGNAL, RESEARCH_REPO_SIGNAL, "study-signal"] });
    expect(areaSkills(three.granted)).toEqual(["know-research"]);
    // And the same list in another order is the same answer.
    const shuffled = routeBatch({ repos: ["study-signal", AGENT_REPO_SIGNAL, RESEARCH_REPO_SIGNAL] });
    expect(shuffled.granted).toEqual(three.granted);
  });

  it("adds the repository's area to the category's, rather than replacing it", () => {
    // The two rows disagree — the category says climbing, the repository says
    // agent-systems — and a todo takes one of each rather than losing one to
    // the order the rows sit in.
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ category: "crag-signal", repos: [AGENT_REPO_SIGNAL] }),
    });
    expect(areaSkills(granted)).toEqual(["know-agent-systems", "know-climbing"]);
  });

  it("still grants the area to a run standing INSIDE the checkout", () => {
    // The phase-6 rule holds: no repo-<name> skill, because the rules are on
    // disk at the commit the run is working on. The area page is not.
    const { granted, repoRulesSource } = routeSkills({
      subject: { kind: "repo", repo: AGENT_REPO_SIGNAL, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: `${REPO_DIR}/convex`,
      repoDirs: { [AGENT_REPO_SIGNAL]: REPO_DIR },
    });
    expect(repoRulesSource).toBe("native");
    expect(granted).not.toContain(repoSkillName(REPO));
    expect(areaSkills(granted)).toEqual(["know-agent-systems"]);
  });

  it("grants the area to a todo whose brief names no path at all", () => {
    // The repository row below wants evidence the run will touch files; this
    // row wants none.
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ repos: [AGENT_REPO_SIGNAL], brief: "Think about it." }),
    });
    expect(granted.filter((name) => name.startsWith("repo-"))).toEqual([]);
    expect(areaSkills(granted)).toEqual(["know-agent-systems"]);
  });
});

// ── know-intent and know-week ────────────────────────────────────────────────

describe("the fixed know skills", () => {
  it("grants know-intent to every judging caller", () => {
    for (const caller of CONTEXT_CALLER_NAMES.filter((name) => CONTEXT_CALLERS[name].judges)) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted, caller).toContain("know-intent");
    }
    for (const caller of INTENT_CALLERS) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted, caller).toContain("know-intent");
    }
  });

  it("does not grant know-intent to time-notes", () => {
    const { granted } = routeSkills({ subject: { kind: "none" }, caller: "time-notes", pages: PAGES });
    expect(granted).not.toContain("know-intent");
  });

  it("grants capture-context the priorities policy inside know-intent", () => {
    const { granted } = routeSkills({ subject: { kind: "none" }, caller: "capture-context", pages: PAGES });
    expect(granted).toContain("know-intent");
  });

  it("grants know-week to time-notes and planner without a dated subject", () => {
    expect([...WEEK_CALLERS]).toEqual(["time-notes", "planner"]);
    for (const caller of CONTEXT_CALLER_NAMES) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted.includes("know-week"), caller).toBe(WEEK_CALLERS.includes(caller));
    }
  });

  it("grants an opener the schedule for a dated todo, not because of its caller", () => {
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "opener",
      pages: PAGES,
      record: todoRecord({ timingClass: "dated", dueDay: "2026-09-14" }),
    });
    expect(granted).toContain("know-week");
  });
});

// ── repo-<name> ──────────────────────────────────────────────────────────────

function routeRepo(cwd, repoDirs = { [REPO]: REPO_DIR }) {
  return routeSkills({
    subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts"] },
    caller: "cli",
    pages: PAGES,
    cwd,
    repoDirs,
  });
}

describe("repo rules go only to a run standing outside the checkout", () => {
  it("grants repo-<name> when the cwd is elsewhere", () => {
    const { granted, repoRulesSource } = routeRepo("C:/Users/heffn/Desktop/WikiTom");
    expect(granted).toContain(repoSkillName(REPO));
    expect(repoRulesSource).toBe(null);
  });

  it("grants repo-<name> when there is no cwd and no repoDirs at all", () => {
    const { granted, repoRulesSource } = routeSkills({
      subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: null,
    });
    expect(granted).toContain(repoSkillName(REPO));
    expect(repoRulesSource).toBe(null);
  });

  it("grants nothing and reports native when the cwd is inside", () => {
    const { granted, repoRulesSource } = routeRepo(`${REPO_DIR}/convex`);
    expect(granted).not.toContain(repoSkillName(REPO));
    expect(repoRulesSource).toBe("native");
  });

  it("matches the cwd case-insensitively and through backslashes", () => {
    expect(routeRepo("c:\\users\\heffn\\desktop\\TOM.QUEST\\convex\\").repoRulesSource).toBe("native");
    expect(routeRepo(REPO_DIR.toUpperCase()).repoRulesSource).toBe("native");
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    expect(routeRepo(`${REPO_DIR}-old/convex`).repoRulesSource).toBe(null);
    expect(routeRepo(`${REPO_DIR}-old/convex`).granted).toContain(repoSkillName(REPO));
  });

  it("takes a todo's repos and the paths its brief names", () => {
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ category: "code", repos: [REPO], brief: "Change convex/ttsContext.ts, one line." }),
      cwd: "C:/Users/heffn/Desktop/WikiTom",
      repoDirs: { [REPO]: REPO_DIR },
    });
    expect(granted).toContain(repoSkillName(REPO));
  });

  it("grants no repo skill for a todo whose brief names no path", () => {
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ category: "code", repos: [REPO], brief: "Think about it." }),
      cwd: "C:/Users/heffn/Desktop/WikiTom",
      repoDirs: { [REPO]: REPO_DIR },
    });
    expect(granted.filter((name) => name.startsWith("repo-"))).toEqual([]);
  });
});

// ── The publication ──────────────────────────────────────────────────────────

describe("a name the publication does not carry is refused, not fatal", () => {
  it("moves a missing repository-signal body into refused with the one sentence", () => {
    const published = ["write", "know-intent", "know-week", "know-agent-systems"];
    const input = {
      subject: { kind: "repo", repo: AGENT_REPO_SIGNAL, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: "C:/Users/heffn/Desktop/WikiTom",
      repoDirs: { [AGENT_REPO_SIGNAL]: REPO_DIR },
    };
    const { granted } = routeSkills(input);
    expect(granted).toContain(repoSkillName(AGENT_REPO_SIGNAL));
    const withCatalog = routeSkills({
      ...input,
      published,
    });
    expect(withCatalog.refused).toEqual([{ name: repoSkillName(AGENT_REPO_SIGNAL), why: NO_BODY }]);
    expect(withCatalog.refused[0].why).toBe("no published body at this commit");
    expect(withCatalog.granted).not.toContain(repoSkillName(AGENT_REPO_SIGNAL));
    // know-agent-systems is the repository's own area, and the catalog carries
    // it: the missing body costs this run the repository's rules, not the page
    // of his life the work belongs to.
    expect(withCatalog.granted).toEqual(["write", "know-agent-systems"]);
  });

  it("refuses every wanted skill when published is absent", () => {
    const closed = routeSkillsWithCatalog({
      subject: { kind: "todo", todoId: "t1" },
      caller: "opener",
      pages: PAGES,
      record: todoRecord({ category: "lab-signal" }),
      published: null,
    });
    expect(closed.granted).toEqual([]);
    expect(closed.refused.map((entry) => entry.name)).toEqual(["write", "know-intent", "know-research"]);
    expect(closed.refused.every((entry) => entry.why === NO_BODY)).toBe(true);
  });

  it("reads a published set at the bare-name catalog boundary", () => {
    const { granted, refused } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "opener",
      pages: PAGES,
      record: todoRecord({ category: "lab-signal" }),
      published: new Set(["write", "know-research"]),
    });
    expect(granted).toEqual(["write", "know-research"]);
    expect(refused).toEqual([{ name: "know-intent", why: NO_BODY }]);
  });
});

// ── The bracket fix ──────────────────────────────────────────────────────────

describe("the categories: brackets are not part of a term", () => {
  const pages = [fixturePage("synthetic-area", "[alpha, beta-gamma]")];

  it("yields the first and last synthetic terms without brackets", () => {
    const [entry] = areaTermsFor(pages);
    expect(entry.terms).toEqual(["synthetic-area", "alpha", "beta-gamma"]);
    expect(entry.terms).not.toContain("[alpha");
    expect(entry.terms).not.toContain("beta-gamma]");
    expect(entry.source).toBe("categories");
  });

  it("routes the last bracketed category, which the old term list could not match", () => {
    const route = (category) =>
      routeSkills({
        subject: { kind: "todo", todoId: "t1" },
        caller: "cli",
        pages,
        record: todoRecord({ category }),
        published: ["write", "know-synthetic-area"],
      }).granted;
    expect(route("beta-gamma")).toContain("know-synthetic-area");
    expect(route("alpha")).toContain("know-synthetic-area");
  });

  it("falls back to the page name and title when there is no categories line", () => {
    const [entry] = areaTermsFor([fixturePage("synthetic-empty-area", undefined)]);
    expect(entry.source).toBe("name-and-title");
    expect(entry.terms).toEqual(["synthetic-empty-area"]);
  });
});

// ── Stability ────────────────────────────────────────────────────────────────

describe("the grant list is stable", () => {
  const input = () => ({
    subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts", "worker/jobs/y.mjs"] },
    caller: "planner",
    pages: PAGES,
    cwd: "C:/Users/heffn/Desktop/WikiTom",
    repoDirs: { [REPO]: REPO_DIR },
  });

  it("is byte-identical across two calls with the same input", () => {
    expect(JSON.stringify(routeSkills(input()))).toBe(JSON.stringify(routeSkills(input())));
  });

  it("orders write, then know-*, then repo-*, alphabetically inside each group", () => {
    const { granted } = routeSkills({
      subject: { kind: "batch", batchId: "b1" },
      caller: "planner",
      pages: PAGES,
      record: {
        today: "2026-09-12",
        batches: [{ id: "b1", repos: [AGENT_REPO_SIGNAL] }],
        todos: [
          { id: "t1", batchId: "b1", category: "lab-signal", brief: "worker/jobs/y.mjs" },
          { id: "t2", batchId: "b1", category: "alpha" },
        ],
        rulings: [],
        sessions: [],
      },
      cwd: "C:/Users/heffn/Desktop/WikiTom",
      repoDirs: { [REPO]: REPO_DIR },
    });
    expect(granted).toEqual([
      "write",
      "know-admin",
      // The repository row's own area, sorted into the know group like any
      // other rather than appended where its row sits in the table.
      "know-agent-systems",
      "know-intent",
      "know-research",
      "know-week",
      repoSkillName(AGENT_REPO_SIGNAL),
    ]);
  });
});

describe("the runner-step caller", () => {
  it("judges, captures nothing, carries his intent, and takes the repository's area and repo skill", () => {
    expect(CONTEXT_CALLERS["runner-step"]).toEqual({ judges: true, captures: false });
    expect(INTENT_CALLERS).toContain("runner-step");
    const research = "---\nupdated: 2026-09-18\ncategories: [study-one, study-two, complexmultitrigger]\n---\n\n# Research\n";
    const routed = routeSkills({
      subject: { kind: "repo", repo: "ComplexMultiTrigger" },
      caller: "runner-step",
      pages: [{ path: "model-of-tom/areas/research.md", body: research }],
      record: {},
      cwd: null,
      repoDirs: {},
      published: ["write", "know-intent", "know-week", "know-research", "repo-complexmultitrigger"],
    });
    expect(routed.granted).toEqual(["write", "know-intent", "know-research", "repo-complexmultitrigger"]);
  });
});
