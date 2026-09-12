// ONE FIXTURE, TWO TESTS. convex/ttsContext.test.ts assembles a run's context
// from a seeded publication in convex-test; scripts/prelude.test.mjs reads the
// same repo rules out of a git checkout. Both take their pages, their record
// and their AGENTS.md bodies from here, so the two sides cannot drift.
//
// WHAT IS HERE IS INPUT. The EXPECTED STRINGS this file used to carry — the
// exact `expanded` and `fetchable` blocks for each of the nine cases — went
// with the know-layer expansion that rendered them. A run is granted skill
// NAMES now (worker/jobs/skill-router.mjs) and loads a body itself, and
// convex/ttsContext.test.ts writes every grant block out by hand, because an
// expectation rendered by calling the renderer asserts only that the renderer
// is itself.

const area = (name, title, categories, state) =>
  `---\nupdated: 2026-09-09\n${categories === null ? "" : `categories: ${categories}\n`}---\n\n# ${title}\n\n## Current state\n\n- ${state}\n`;

/** The eight required area pages, plus the three know pages and the two stable
 * layers. `money` deliberately carries NO `categories:` line — the state every
 * area page in WikiTom is in today — so the fallback to the page's own name and
 * title is exercised by a real case rather than a hypothetical one. */
export const CONTEXT_PAGES = Object.freeze({
  "model-of-tom/agent-rules.md": "# Agent rules\n\n## Map\n\n- Layers: operate, write, know.\n\n## Never\n\n- Guess.\n",
  "model-of-tom/writing.md": "# Writing\n\nBe plain.\n",
  "model-of-tom/ground.md": "# Ground\n\nStart here.\n",
  "model-of-tom/intent.md":
    "---\nupdated: 2026-09-09\n---\n\n# Intent\n\n## Directions\n\n- Ship the fleet.\n\n"
    + "## What to protect\n\n- The paper.\n\n"
    + "## What to push toward\n\n- Climbing training three days a week.\n\n"
    + "## What he does not care about\n\n- Fonts.\n",
  "model-of-tom/priorities.md":
    "# Priorities\n\n## Rules learned from corrections\n\n- He rules; agents implement.\n\n"
    + "## What becomes a todo\n\n- Anything with a date.\n",
  "model-of-tom/schedule.md":
    "# Schedule\n\n## Week\n\n- Monday — climbing team practice.\n- Tuesday — lab meeting.\n"
    + "- Wednesday — cube draft.\n\n## Calendars\n\n- Google, and the WPI feed.\n",
  "model-of-tom/areas/admin.md": area("admin", "Admin", "admin, email, chores", "Paperwork waits."),
  "model-of-tom/areas/agent-systems.md": area("agent-systems", "Agent systems", "agent-systems, tts, tom.quest, wikitom, code", "TTS is live."),
  "model-of-tom/areas/climbing.md": area("climbing", "Climbing", "climbing, team, exec", "On the WPI team."),
  "model-of-tom/areas/health-and-food.md": area("health-and-food", "Health and food", "health, food, cooking", "Batch meals."),
  "model-of-tom/areas/mental-health.md": area("mental-health", "Mental health", "mental-health, therapy, adhd", "Weekly therapy."),
  "model-of-tom/areas/money.md": area("money", "Money", null, "Reimbursements owed."),
  "model-of-tom/areas/research.md": area("research", "Research", "research, paper, cmt", "The September campaign."),
  "model-of-tom/areas/social.md": area("social", "Social", "social, cube, family", "Cube drafts."),
});

/** tom.quest's published repo layer, four files at three depths. */
export const CONTEXT_REPO_RULES = Object.freeze([
  { repo: "tom.quest", path: "AGENTS.md", body: "# tom.quest\n\n- Root rule.\n" },
  { repo: "tom.quest", path: "app/AGENTS.md", body: "# app\n\n- App rule.\n" },
  { repo: "tom.quest", path: "convex/AGENTS.md", body: "# convex\n\n- Convex rule.\n" },
  { repo: "tom.quest", path: "worker/AGENTS.md", body: "# worker\n\n- Worker rule.\n" },
]);

/** 2026-09-07 is a Monday and 2026-09-09 a Wednesday — pinned here rather than
 * computed, because a fixture that derives its own weekday cannot catch a
 * weekday bug. */
export const CONTEXT_TODAY = "2026-09-09";
export const MONDAY = "2026-09-07";

export const AREA_NAMES = Object.freeze([
  "admin", "agent-systems", "climbing", "health-and-food", "mental-health", "money", "research", "social",
]);

export const IDS = Object.freeze({
  climb: "t-climb",
  paths: "t-paths",
  nosuch: "t-nosuch",
  oversize: "t-oversize",
  member1: "t-member1",
  member2: "t-member2",
  member3: "t-member3",
  member4: "t-member4",
  batch: "b-batch",
  memberBatch: "b-members",
});

/**
 * The record a run's context is built against: the todos, batches, rulings and
 * session outcomes the Convex side holds as rows and passes in memory.
 */
export function contextRecord() {
  return {
    today: CONTEXT_TODAY,
    batches: [
      { id: IDS.batch, repos: ["tom.quest"] },
      { id: IDS.memberBatch, repos: [] },
    ],
    todos: [
      { id: IDS.climb, category: "climbing", timingClass: "dated", dueDay: MONDAY },
      {
        id: IDS.paths,
        category: "agent-systems",
        timingClass: "whenever",
        batchId: IDS.batch,
        brief: "Rework `convex/tts.ts` and worker/jobs/x.mjs together.",
      },
      // A brief past SUPPLEMENTAL_CAPS.brief: the prompt carries its head and
      // the line saying where the rest is (worker/jobs/context-relevance.mjs).
      {
        id: IDS.nosuch,
        category: "nosuch",
        timingClass: "whenever",
        brief: `# The brief\n\n${"- a long line of brief, long enough to matter.\n".repeat(200)}`,
      },
      { id: IDS.oversize, category: "oversize", timingClass: "dated", dueDay: MONDAY, batchId: IDS.batch },
      { id: IDS.member1, category: "climbing", timingClass: "whenever", batchId: IDS.memberBatch },
      { id: IDS.member2, category: "climbing", timingClass: "whenever", batchId: IDS.memberBatch },
      { id: IDS.member3, category: "admin", timingClass: "whenever", batchId: IDS.memberBatch },
      { id: IDS.member4, category: "research", timingClass: "whenever", batchId: IDS.memberBatch },
    ],
    // Only the oversize todo and its batch carry rulings and outcomes, so the
    // other assertions stay about the pages they are testing.
    rulings: [
      { todoId: IDS.oversize, verdict: "revise", sentence: "narrow it first", ruledAt: 500, ruledDay: "2026-09-05" },
      { todoId: IDS.oversize, verdict: "session", sentence: "talk it through", ruledAt: 400, ruledDay: "2026-09-04" },
      { batchId: IDS.batch, verdict: "approve", sentence: "ship it", ruledAt: 300, ruledDay: "2026-09-03" },
      { batchId: IDS.batch, verdict: "revise", sentence: "smaller steps", ruledAt: 200, ruledDay: "2026-09-02" },
      { batchId: IDS.batch, verdict: "approve", sentence: "again", ruledAt: 100, ruledDay: "2026-09-01" },
    ],
    sessions: [
      { batchId: IDS.batch, repos: ["tom.quest"], outcome: "completed", outcomeSummary: "the prelude landed", statusChangedAt: 900, endedDay: "2026-09-08" },
      { batchId: IDS.batch, repos: ["tom.quest"], outcome: "errored", outcomeSummary: "the daemon died", statusChangedAt: 800, endedDay: "2026-09-07" },
      { batchId: IDS.batch, repos: ["tom.quest"], outcome: "completed", outcomeSummary: "the search tool landed", statusChangedAt: 700, endedDay: "2026-09-06" },
    ],
  };
}

/** Header line 1 plus the stable layers, rendered the way the prelude renders
 * every file: `── <path> ──` and the body, area frontmatter stripped. */
export function expectedPrefix(commit, { write = true } = {}) {
  const paths = write
    ? ["model-of-tom/agent-rules.md", "model-of-tom/writing.md", "model-of-tom/ground.md"]
    : ["model-of-tom/agent-rules.md"];
  // The body keeps its own trailing newline: the prelude renders each file
  // verbatim and joins the blocks with a blank line.
  const bodies = paths.map((path) => `── ${path} ──\n${CONTEXT_PAGES[path]}`).join("\n\n");
  return `MODEL-OF-TOM FILES (WikiTom commit ${commit}): ${paths.join(", ")}\n\n${bodies}`;
}

/**
 * The fixture as a POSTED PUBLICATION — the three rendered layers, the seven
 * canonical headers and one file row per page. The Convex test seeds exactly
 * this, so it works from the same bytes the CLI reads out of git.
 */
export function contextPublication(commit) {
  const areas = Object.keys(CONTEXT_PAGES).filter((path) => path.startsWith("model-of-tom/areas/")).sort();
  const layerPaths = {
    operate: ["model-of-tom/agent-rules.md"],
    write: ["model-of-tom/writing.md", "model-of-tom/ground.md"],
    know: ["model-of-tom/intent.md", "model-of-tom/priorities.md", "model-of-tom/schedule.md", ...areas],
  };
  // Area pages lose their frontmatter, every other file is verbatim — the one
  // rule scripts/prelude.mjs renders by.
  const render = (path) => {
    const source = CONTEXT_PAGES[path];
    const body = areas.includes(path) ? source.slice(source.indexOf("---", 3) + 4).trim() : source;
    return `── ${path} ──\n${body}`;
  };
  const layers = Object.fromEntries(
    Object.entries(layerPaths).map(([name, paths]) => [name, paths.map(render).join("\n\n")]),
  );
  const selections = [
    ["operate"], ["write"], ["know"], ["operate", "write"],
    ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
  ];
  const headers = selections.map((names) => ({
    layers: [...names],
    header: `MODEL-OF-TOM FILES (WikiTom commit ${commit}): ${names.flatMap((name) => layerPaths[name]).join(", ")}`,
  }));
  const files = Object.values(layerPaths).flat().map((path) => ({
    path,
    body: CONTEXT_PAGES[path],
    bytes: Buffer.byteLength(CONTEXT_PAGES[path]),
  }));
  return { layers, headers, files };
}
