// Tests for the skill router (worker/jobs/skill-router.mjs).
//
// What is pinned here is THE ROUTING TABLE — which skills a run is granted for
// a caller, a subject and a working directory — plus the one correction the
// move made: the `categories:` brackets, which context-relevance.mjs left in
// the terms, so that the first and last category of every area page matched
// nothing.
//
// THE EIGHT AREA PAGES ARE READ FROM THE VAULT WHEN THE VAULT IS THERE, and
// from the inline fixture below when it is not, so the same assertions run on
// the laptop and in CI. The fixture carries the real `categories:` lines; if
// Tom edits one, the vault run is what says so.

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  areaTermsFor,
  CONTEXT_CALLERS,
  CONTEXT_CALLER_NAMES,
  callerRules,
  INTENT_CALLERS,
  NO_BODY,
  REPO_AREA_CAP,
  routeSkills,
  WEEK_CALLERS,
} from "./skill-router.mjs";

// ── The area pages ───────────────────────────────────────────────────────────

const VAULT_AREAS = "C:/Users/heffn/Desktop/WikiTom-uae/model-of-tom/areas";

/** The `categories:` line of each of the eight pages, as they stand. */
const FIXTURE_CATEGORIES = {
  admin: "[admin, email, chores, paperwork, errands, university, canvas, outlook]",
  "agent-systems": "[agent-systems, tts, tom.quest, wikitom, agents, code, lifeos, vqc]",
  climbing: "[climbing, team, exec, practice]",
  "health-and-food": "[health, food, cooking, groceries, ankle, meals, dental]",
  "mental-health": "[mental-health, therapy, adhd, sleep, rest, weed, meds]",
  money: "[money, spend, budget, billing, reimbursement, credentials, subscriptions]",
  research: "[research, paper, cmt, complexmultitrigger, overleaf, campaign, phd, lab, thesis, coursework]",
  social: "[social, dnd, cube, mtg, magic, family, friends]",
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

function vaultPages() {
  if (!existsSync(VAULT_AREAS)) return null;
  const files = readdirSync(VAULT_AREAS).filter((file) => file.endsWith(".md"));
  if (files.length === 0) return null;
  return files.map((file) => ({
    path: `model-of-tom/areas/${file}`,
    body: readFileSync(`${VAULT_AREAS}/${file}`, "utf8"),
  }));
}

const PAGES = vaultPages() ?? Object.entries(FIXTURE_CATEGORIES).map(([name, cats]) => fixturePage(name, cats));
const PAGE_SOURCE = vaultPages() === null ? "the inline fixture" : VAULT_AREAS;

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO = "tom.quest";
const REPO_DIR = "C:/Users/heffn/Desktop/tom.quest";

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

describe("write goes when the run's output reaches Tom", () => {
  it("grants write to every declared caller, and only by reachesTom", () => {
    for (const caller of CONTEXT_CALLER_NAMES) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted.includes("write"), caller).toBe(CONTEXT_CALLERS[caller].reachesTom);
    }
  });

  it("has no declared caller today whose output does not reach him", () => {
    // The fact the test above rests on, asserted rather than assumed: if a row
    // is ever added with reachesTom false, that test starts exercising both
    // sides of the gate on its own.
    expect(CONTEXT_CALLER_NAMES.filter((name) => !CONTEXT_CALLERS[name].reachesTom)).toEqual([]);
  });

  it("grants nothing at all to a synthetic caller that does not reach him", () => {
    // CONTEXT_CALLERS is frozen and every row in it reaches Tom, so the only
    // way to exercise the other side of the gate is to hand callerRules a row
    // it can find without the table being edited. The lookup is a property
    // read, so a row on the prototype answers it; it is removed in `finally`,
    // and nothing outside this test sees it.
    const name = "synthetic-non-reaching-caller";
    Object.prototype[name] = Object.freeze({ reachesTom: false, judges: false, captures: false });
    try {
      expect(callerRules(name).reachesTom).toBe(false);
      const { granted, refused, repoRulesSource } = routeSkills({
        subject: { kind: "none" },
        caller: name,
        pages: PAGES,
      });
      expect(granted).toEqual([]);
      expect(refused).toEqual([]);
      expect(repoRulesSource).toBe(null);
    } finally {
      delete Object.prototype[name];
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
        { id: "t1", batchId: "b1", category: "research" },
        { id: "t2", batchId: "b1", category: "paper" },
        { id: "t3", batchId: "b1", category: "admin" },
        { id: "t4", batchId: "b1", category: "email" },
        { id: "t5", batchId: "b1", category: "climbing" },
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
    // research and admin have two members each, climbing one; the tie between
    // the two goes to the name.
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

  it("routes a batch whose repos are [tom.quest] to know-agent-systems", () => {
    expect(areaSkills(routeBatch({ repos: [REPO] }).granted)).toEqual(["know-agent-systems"]);
  });

  it("routes a todo's codeRepo ComplexMultiTrigger to know-research", () => {
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ codeRepo: "ComplexMultiTrigger" }),
    });
    expect(areaSkills(granted)).toEqual(["know-research"]);
  });

  it("routes a batch member's codeRepo too, when the batch declares no repos", () => {
    expect(areaSkills(routeBatch({}, [{ codeRepo: "ComplexMultiTrigger" }]).granted)).toEqual(["know-research"]);
  });

  it("routes WikiTom to know-agent-systems, case and all", () => {
    expect(areaSkills(routeBatch({ repos: ["WikiTom"] }).granted)).toEqual(["know-agent-systems"]);
  });

  it("routes a repo: subject by its own name", () => {
    const { granted } = routeSkills({
      subject: { kind: "repo", repo: "ComplexMultiTrigger", paths: ["cmt/engine/x.py"] },
      caller: "cli",
      pages: PAGES,
    });
    expect(areaSkills(granted)).toEqual(["know-research"]);
  });

  it("gives a repository no area when no page's categories name it", () => {
    expect(areaSkills(routeBatch({ repos: ["Byobu"] }).granted)).toEqual([]);
    expect(areaSkills(routeBatch({ repos: [] }).granted)).toEqual([]);
    const { granted } = routeSkills({
      subject: { kind: "repo", repo: "Byobu", paths: ["x.py"] },
      caller: "cli",
      pages: PAGES,
    });
    expect(areaSkills(granted)).toEqual([]);
    expect(granted).toContain("repo-Byobu");
  });

  it("takes ONE area from the repositories however many they name", () => {
    expect(REPO_AREA_CAP).toBe(1);
    // tom.quest and WikiTom both name agent-systems; ComplexMultiTrigger and
    // Overleaf both name research. Two repositories for research, one for
    // agent-systems, so research wins and it is the only one taken.
    const three = routeBatch({ repos: [REPO, "ComplexMultiTrigger", "Overleaf"] });
    expect(areaSkills(three.granted)).toEqual(["know-research"]);
    // And the same list in another order is the same answer.
    const shuffled = routeBatch({ repos: ["Overleaf", REPO, "ComplexMultiTrigger"] });
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
      record: todoRecord({ category: "climbing", repos: [REPO] }),
    });
    expect(areaSkills(granted)).toEqual(["know-agent-systems", "know-climbing"]);
  });

  it("still grants the area to a run standing INSIDE the checkout", () => {
    // The phase-6 rule holds: no repo-<name> skill, because the rules are on
    // disk at the commit the run is working on. The area page is not.
    const { granted, repoRulesSource } = routeSkills({
      subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: `${REPO_DIR}/convex`,
      repoDirs: { [REPO]: REPO_DIR },
    });
    expect(repoRulesSource).toBe("native");
    expect(granted).not.toContain(`repo-${REPO}`);
    expect(areaSkills(granted)).toEqual(["know-agent-systems"]);
  });

  it("grants the area to a todo whose brief names no path at all", () => {
    // The repository row below wants evidence the run will touch files; this
    // row wants none.
    const { granted } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "cli",
      pages: PAGES,
      record: todoRecord({ repos: [REPO], brief: "Think about it." }),
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

  it("grants know-week to time-notes and planner, and to nobody else", () => {
    expect([...WEEK_CALLERS]).toEqual(["time-notes", "planner"]);
    for (const caller of CONTEXT_CALLER_NAMES) {
      const { granted } = routeSkills({ subject: { kind: "none" }, caller, pages: PAGES });
      expect(granted.includes("know-week"), caller).toBe(WEEK_CALLERS.includes(caller));
    }
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
    expect(granted).toContain(`repo-${REPO}`);
    expect(repoRulesSource).toBe(null);
  });

  it("grants repo-<name> when there is no cwd and no repoDirs at all", () => {
    const { granted, repoRulesSource } = routeSkills({
      subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: null,
    });
    expect(granted).toContain(`repo-${REPO}`);
    expect(repoRulesSource).toBe(null);
  });

  it("grants nothing and reports native when the cwd is inside", () => {
    const { granted, repoRulesSource } = routeRepo(`${REPO_DIR}/convex`);
    expect(granted).not.toContain(`repo-${REPO}`);
    expect(repoRulesSource).toBe("native");
  });

  it("matches the cwd case-insensitively and through backslashes", () => {
    expect(routeRepo("c:\\users\\heffn\\desktop\\TOM.QUEST\\convex\\").repoRulesSource).toBe("native");
    expect(routeRepo(REPO_DIR.toUpperCase()).repoRulesSource).toBe("native");
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    expect(routeRepo(`${REPO_DIR}-old/convex`).repoRulesSource).toBe(null);
    expect(routeRepo(`${REPO_DIR}-old/convex`).granted).toContain(`repo-${REPO}`);
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
    expect(granted).toContain(`repo-${REPO}`);
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
  it("moves repo-tom.quest into refused with the one sentence", () => {
    const published = ["write", "know-intent", "know-week", "know-agent-systems"];
    const { granted } = routeRepo("C:/Users/heffn/Desktop/WikiTom");
    expect(granted).toContain(`repo-${REPO}`);
    const withCatalog = routeSkills({
      subject: { kind: "repo", repo: REPO, paths: ["convex/x.ts"] },
      caller: "cli",
      pages: PAGES,
      cwd: "C:/Users/heffn/Desktop/WikiTom",
      repoDirs: { [REPO]: REPO_DIR },
      published,
    });
    expect(withCatalog.refused).toEqual([{ name: `repo-${REPO}`, why: NO_BODY }]);
    expect(withCatalog.refused[0].why).toBe("no published body at this commit");
    expect(withCatalog.granted).not.toContain(`repo-${REPO}`);
    // know-agent-systems is the repository's own area, and the catalog carries
    // it: the missing body costs this run the repository's rules, not the page
    // of his life the work belongs to.
    expect(withCatalog.granted).toEqual(["write", "know-agent-systems"]);
  });

  it("grants everything the router wants when published is null", () => {
    const open = routeCategory("research", "opener");
    const same = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "opener",
      pages: PAGES,
      record: todoRecord({ category: "research" }),
      published: null,
    });
    expect(same.granted).toEqual(open.granted);
    expect(same.refused).toEqual([]);
  });

  it("reads a published set spelled with the tom- directory prefix", () => {
    const { granted, refused } = routeSkills({
      subject: { kind: "todo", todoId: "t1" },
      caller: "opener",
      pages: PAGES,
      record: todoRecord({ category: "research" }),
      published: new Set(["tom-write", "tom-know-research"]),
    });
    expect(granted).toEqual(["write", "know-research"]);
    expect(refused).toEqual([{ name: "know-intent", why: NO_BODY }]);
  });
});

// ── The bracket fix ──────────────────────────────────────────────────────────

describe("the categories: brackets are not part of a term", () => {
  const pages = [fixturePage("admin", "[admin, email]")];

  it("yields admin and email, and never [admin", () => {
    const [entry] = areaTermsFor(pages);
    expect(entry.terms).toEqual(["admin", "email"]);
    expect(entry.terms).not.toContain("[admin");
    expect(entry.terms).not.toContain("email]");
    expect(entry.source).toBe("categories");
  });

  it("routes the last bracketed category, which the old term list could not match", () => {
    const route = (category) =>
      routeSkills({
        subject: { kind: "todo", todoId: "t1" },
        caller: "cli",
        pages,
        record: todoRecord({ category }),
      }).granted;
    expect(route("email")).toContain("know-admin");
    expect(route("admin")).toContain("know-admin");
  });

  it("falls back to the page name and title when there is no categories line", () => {
    const [entry] = areaTermsFor([fixturePage("climbing", undefined)]);
    expect(entry.source).toBe("name-and-title");
    expect(entry.terms).toEqual(["climbing"]);
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
        batches: [{ id: "b1", repos: [REPO] }],
        todos: [
          { id: "t1", batchId: "b1", category: "research", brief: "worker/jobs/y.mjs" },
          { id: "t2", batchId: "b1", category: "admin" },
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
      `repo-${REPO}`,
    ]);
  });
});
