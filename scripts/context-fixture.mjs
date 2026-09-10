// ONE FIXTURE, TWO TESTS. scripts/prelude.test.mjs assembles from a git WikiTom
// in a temp dir; convex/ttsContext.test.ts assembles from a seeded publication
// in convex-test. Both read the pages, the record and the EXPECTED STRINGS from
// here, so the CLI's composition and the Convex one cannot drift the way the
// prelude and its callers could before.
//
// Every expectation below is written out by hand rather than computed from the
// assembler: an expectation derived from the code under test asserts only that
// the code is itself.

const area = (name, title, categories, state) =>
  `---\nupdated: 2026-09-09\n${categories === null ? "" : `categories: ${categories}\n`}---\n\n# ${title}\n\n## Current state\n\n- ${state}\n`;

/** The eight required area pages, plus the three know pages and the two stable
 * layers. `money` deliberately carries NO `categories:` line — the state every
 * area page in WikiTom is in today — so the fallback and the note it puts on
 * header line 2 are exercised by a real case rather than a hypothetical one. */
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

const OVERSIZE_STATE = Array.from({ length: 40 }, (_, i) => `- Current state line ${i}, long enough to matter.`).join("\n");
const OVERSIZE_HISTORY = Array.from({ length: 315 }, (_, i) => `- History line ${i}, long enough to matter.`).join("\n");

/** The one page big enough to make the expand budget bite (WikiTom's own
 * `mental-health` is the closest real page at 3.3 KB; this one is ~15 KB).
 * GROWN WITH EXPAND_BUDGET at integration — the budget went from 8,192 to
 * 12,288, and a fixture that no longer overflows tests nothing. */
export const OVERSIZE_PAGE = `---\nupdated: 2026-09-09\ncategories: oversize\n---\n\n# Oversize\n\n## Current state\n\n${OVERSIZE_STATE}\n\n## History\n\n${OVERSIZE_HISTORY}\n`;

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
 * Exactly the fields worker/jobs/context-relevance.mjs reads. The Convex side
 * builds this same shape in memory from its own rows; `--record FILE` on the
 * CLI is this object as JSON.
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
      // the index carries the line saying where the rest is.
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
    // other nine assertions stay about the pages they are testing.
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
 * this, so it assembles from the same bytes the CLI reads out of git.
 */
export function contextPublication(commit, { oversize = false } = {}) {
  const areas = [
    ...Object.keys(CONTEXT_PAGES).filter((path) => path.startsWith("model-of-tom/areas/")),
    ...(oversize ? ["model-of-tom/areas/oversize.md"] : []),
  ].sort();
  const bodyOf = (path) => (path === "model-of-tom/areas/oversize.md" ? OVERSIZE_PAGE : CONTEXT_PAGES[path]);
  const layerPaths = {
    operate: ["model-of-tom/agent-rules.md"],
    write: ["model-of-tom/writing.md", "model-of-tom/ground.md"],
    know: ["model-of-tom/intent.md", "model-of-tom/priorities.md", "model-of-tom/schedule.md", ...areas],
  };
  // Area pages lose their frontmatter, every other file is verbatim — the one
  // rule scripts/prelude.mjs renders by.
  const render = (path) => {
    const source = bodyOf(path);
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
    body: bodyOf(path),
    bytes: Buffer.byteLength(bodyOf(path)),
  }));
  return { layers, headers, files };
}

// ── The pieces every expectation is built from ───────────────────────────────
// `- <what> (<size>) — <how>` per line, in the block's fixed order: layers,
// know-page sections, area pages, evidence, repo rules, search questions.

export const KNOW_LAYER_LINE = "- know layer, whole (1.4K) — node scripts/prelude.mjs --wikitom $WIKITOM_DIR --layers know";

export const INTENT_LINES = Object.freeze({
  directions: "- model-of-tom/intent.md § Directions (0.0K) — path",
  protect: "- model-of-tom/intent.md § What to protect (0.0K) — path",
  push: "- model-of-tom/intent.md § What to push toward (0.1K) — path",
  care: "- model-of-tom/intent.md § What he does not care about (0.0K) — path",
});
export const PRIORITIES_LINES = Object.freeze({
  corrections: "- model-of-tom/priorities.md § Rules learned from corrections (0.1K) — path",
  todo: "- model-of-tom/priorities.md § What becomes a todo (0.0K) — path",
});
// § Week is in the index in EVERY case, expanded or not: rule 8 only ever takes
// the bullets for one weekday out of it, and the other days went nowhere.
export const SCHEDULE_LINES = Object.freeze({
  week: "- model-of-tom/schedule.md § Week (0.1K) — path",
  calendars: "- model-of-tom/schedule.md § Calendars (0.0K) — path",
});

const AREA_SIZE = {
  admin: "0.0K", "agent-systems": "0.0K", climbing: "0.0K", "health-and-food": "0.0K",
  "mental-health": "0.1K", money: "0.0K", research: "0.1K", social: "0.0K",
};

export const AREA_NAMES = Object.freeze([
  "admin", "agent-systems", "climbing", "health-and-food", "mental-health", "money", "research", "social",
]);

export const areaLine = (name) => `- model-of-tom/areas/${name}.md (${AREA_SIZE[name]}) — tts-search areas ${name}`;

export const EVIDENCE_LINE =
  '- model-of-tom/evidence/ — the per-line evidence for every page above, same filename; grep it, or tts-search evidence "<query>"';

/** A repo rules line: scoped to the path alone when the run works in exactly
 * one repo, and named with its repo when the run is not scoped to one. */
export const rulesLine = (path, { scoped = true } = {}) =>
  `- ${scoped ? path : `tom.quest ${path}`} (0.0K) — path in the checkout`;

export const ALL_RULES_LINES = Object.freeze(
  CONTEXT_REPO_RULES.map((rule) => rulesLine(rule.path, { scoped: false })),
);

export const SEARCH_LINES = Object.freeze([
  '- his rulings, any subject — tts-search rulings "<query>" [--since YYYY-MM-DD]',
  "- session history, any repo — tts-search sessions [--repo NAME] [--query TEXT]",
  '- the event log — tts-search events "<query>"',
  '- todos, any status — tts-search todos "<query>" [--status S]',
  "- an area page and its frontmatter — tts-search areas <name|all>",
  '- WikiTom sources/ and tom-text/ — tts-search sources "<query>"',
  '- archived session transcripts — tts-search archive "<query>" [--since YYYY-MM-DD]',
  "- open repository-rule proposals — tts-search proposals [--repo NAME]",
  "- recorded evals runs — tts-search evals [--limit N]",
]);

export const ALL_KNOW_SECTIONS = Object.freeze([
  INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.push, INTENT_LINES.care,
  PRIORITIES_LINES.corrections, PRIORITIES_LINES.todo,
  SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
]);

export const sep = (label) => `── ${label} ──`;

export const areaBody = (name) => {
  const page = CONTEXT_PAGES[`model-of-tom/areas/${name}.md`];
  return page.slice(page.indexOf("---", 3) + 4).trim();
};

export const sectionBody = (path, heading) => {
  const page = CONTEXT_PAGES[path];
  const from = page.indexOf(`## ${heading}`);
  const rest = page.slice(from + 1);
  const to = rest.indexOf("\n## ");
  return (to === -1 ? page.slice(from) : page.slice(from, from + 1 + to)).trim();
};

const rulesBody = (path) => CONTEXT_REPO_RULES.find((rule) => rule.path === path).body.trim();

/** Header line 3 and its lines. */
export function fetchableBlock(lines) {
  return `MODEL-OF-TOM FETCHABLE (${lines.length} items not in this prompt):\n${lines.join("\n")}`;
}

/** Header line 2 and the blocks under it. */
function expandedBlock(header, blocks) {
  return [header, blocks.map(([label, body]) => `${sep(label)}\n${body}`).join("\n\n")].join("\n\n");
}

const CLIMBING = ["model-of-tom/areas/climbing.md", areaBody("climbing")];
const ADMIN = ["model-of-tom/areas/admin.md", areaBody("admin")];
const AGENT_SYSTEMS = ["model-of-tom/areas/agent-systems.md", areaBody("agent-systems")];
const PUSH = ["model-of-tom/intent.md § What to push toward", sectionBody("model-of-tom/intent.md", "What to push toward")];
const CORRECTIONS = [
  "model-of-tom/priorities.md § Rules learned from corrections",
  sectionBody("model-of-tom/priorities.md", "Rules learned from corrections"),
];
const MONDAY_BULLET = ["model-of-tom/schedule.md § Week", "- Monday — climbing team practice."];
const BATCH_RULINGS = [
  "his rulings on this subject",
  "2026-09-03 approve: ship it\n2026-09-02 revise: smaller steps\n2026-09-01 approve: again",
];
const BATCH_OUTCOMES = [
  "recent session outcomes",
  "2026-09-08 completed the prelude landed\n2026-09-07 errored the daemon died\n2026-09-06 completed the search tool landed",
];

/**
 * The cases of §12, each as the exact `expanded` and `fetchable` the assembler
 * must produce for BOTH implementations. `expanded: ""` means the case expands
 * nothing and header line 2 is not written at all (rule 12).
 */
export const EXPECTED = Object.freeze({
  // 1 — the laptop hook: the stable prefix and the whole index, nothing expanded.
  laptop: {
    expanded: "",
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE, ...ALL_KNOW_SECTIONS, ...AREA_NAMES.map(areaLine),
      EVIDENCE_LINE, ...ALL_RULES_LINES, ...SEARCH_LINES,
    ]),
  },

  // 2 — one area by name. Climbing leaves the index; the other seven stay.
  areaClimbing: {
    expanded: expandedBlock(
      "MODEL-OF-TOM EXPANDED (for area climbing): model-of-tom/areas/climbing.md 48 B, model-of-tom/intent.md § What to push toward 62 B, model-of-tom/priorities.md § Rules learned from corrections 64 B — 358 B",
      [CLIMBING, PUSH, CORRECTIONS],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.filter((name) => name !== "climbing").map(areaLine),
      EVIDENCE_LINE, ...ALL_RULES_LINES, ...SEARCH_LINES,
    ]),
  },

  // 3 — a dated todo: its area, the intent section its terms hit, the
  // corrections the opener may judge by, and the § Week bullets of its own
  // weekday and no other day.
  todoClimbing: {
    expanded: expandedBlock(
      `MODEL-OF-TOM EXPANDED (for todo ${IDS.climb}, category "climbing"): model-of-tom/areas/climbing.md 48 B, model-of-tom/intent.md § What to push toward 62 B, model-of-tom/priorities.md § Rules learned from corrections 64 B, model-of-tom/schedule.md § Week (Monday) 36 B — 443 B`,
      [CLIMBING, PUSH, CORRECTIONS, MONDAY_BULLET],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.filter((name) => name !== "climbing").map(areaLine),
      EVIDENCE_LINE, ...ALL_RULES_LINES, ...SEARCH_LINES,
    ]),
    manifest: [
      "areas/climbing", "intent#What to push toward",
      "priorities#Rules learned from corrections", "schedule#Week Monday",
    ],
  },

  // 4 — a category no page claims: no area expands, header line 2 SAYS SO, all
  // eight areas stay in the index, and the run is not an error.
  todoNoMatch: {
    expanded: expandedBlock(
      `MODEL-OF-TOM EXPANDED (for todo ${IDS.nosuch}, category "nosuch"; nothing matched category "nosuch"): model-of-tom/priorities.md § Rules learned from corrections 64 B — 139 B`,
      [CORRECTIONS],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.push, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.map(areaLine),
      EVIDENCE_LINE, ...ALL_RULES_LINES, ...SEARCH_LINES,
      "- this todo's full brief, truncated above (9.2K) — tom.quest/tts, or the record",
    ]),
  },

  // 5 — the paths a brief names: the root rules, then the deepest published
  // AGENTS.md over each token, ordered by the depth of the TOKEN that matched
  // it (then the number of matching tokens, then the file's own depth, then
  // path asc). The brief names worker/jobs/x.mjs, a depth-2 token, and
  // convex/tts.ts, a depth-1 one, so worker/ comes first. app/ is named by
  // nothing and stays in the index.
  todoPaths: {
    expanded: expandedBlock(
      `MODEL-OF-TOM EXPANDED (for todo ${IDS.paths}, category "agent-systems"): model-of-tom/areas/agent-systems.md 49 B, model-of-tom/priorities.md § Rules learned from corrections 64 B, AGENTS.md 25 B, worker/AGENTS.md 24 B, convex/AGENTS.md 24 B, 3 rulings 84 B, 3 session outcomes 116 B — 693 B`,
      [
        AGENT_SYSTEMS, CORRECTIONS,
        ["AGENTS.md", rulesBody("AGENTS.md")],
        ["worker/AGENTS.md", rulesBody("worker/AGENTS.md")],
        ["convex/AGENTS.md", rulesBody("convex/AGENTS.md")],
        BATCH_RULINGS, BATCH_OUTCOMES,
      ],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.push, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.filter((name) => name !== "agent-systems").map(areaLine),
      EVIDENCE_LINE, rulesLine("app/AGENTS.md"), ...SEARCH_LINES,
    ]),
  },

  // 6 — a batch: its todos' areas, todo count desc then name asc. Two todos in
  // climbing and one each in admin and research, so research is the third area
  // and goes to the index.
  batchMembers: {
    expanded: expandedBlock(
      `MODEL-OF-TOM EXPANDED (for batch ${IDS.memberBatch}): model-of-tom/areas/climbing.md 48 B, model-of-tom/areas/admin.md 45 B, model-of-tom/intent.md § What to push toward 62 B, model-of-tom/priorities.md § Rules learned from corrections 64 B — 447 B`,
      [CLIMBING, ADMIN, PUSH, CORRECTIONS],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.filter((name) => name !== "climbing" && name !== "admin").map(areaLine),
      EVIDENCE_LINE, ...ALL_RULES_LINES, ...SEARCH_LINES,
    ]),
  },

  // 9 — a repo with no paths: the area whose terms name it, the repo's root
  // rules, its recent outcomes, and nothing todo-shaped.
  repoTomQuest: {
    expanded: expandedBlock(
      "MODEL-OF-TOM EXPANDED (for repo tom.quest): model-of-tom/areas/agent-systems.md 49 B, model-of-tom/priorities.md § Rules learned from corrections 64 B, AGENTS.md 25 B, 3 session outcomes 116 B — 449 B",
      [AGENT_SYSTEMS, CORRECTIONS, ["AGENTS.md", rulesBody("AGENTS.md")], BATCH_OUTCOMES],
    ),
    fetchable: fetchableBlock([
      KNOW_LAYER_LINE,
      INTENT_LINES.directions, INTENT_LINES.protect, INTENT_LINES.push, INTENT_LINES.care,
      PRIORITIES_LINES.todo, SCHEDULE_LINES.week, SCHEDULE_LINES.calendars,
      ...AREA_NAMES.filter((name) => name !== "agent-systems").map(areaLine),
      EVIDENCE_LINE,
      rulesLine("app/AGENTS.md"), rulesLine("convex/AGENTS.md"), rulesLine("worker/AGENTS.md"),
      ...SEARCH_LINES,
    ]),
  },

  // The state every WikiTom area page is in today: no `categories:` line at
  // all. The page still matches on its own name, and header line 2 says which
  // pages fell back and why — a silent fallback would read as a deliberate
  // one-term list.
  areaMoneyFallback: {
    expanded: expandedBlock(
      "MODEL-OF-TOM EXPANDED (for area money; matched on file name and title, no categories: frontmatter on money): model-of-tom/areas/money.md 49 B, model-of-tom/priorities.md § Rules learned from corrections 64 B — 232 B",
      [["model-of-tom/areas/money.md", areaBody("money")], CORRECTIONS],
    ),
  },

  // 7 — the shrink order, in the documented sequence, ending under the budget.
  oversize: {
    shrink: [
      "outcomes to 1",
      "outcomes to 0",
      "rulings to 3",
      "rulings to the todo's own",
      "AGENTS.md to root and the deepest (nothing to drop)",
      "the second area page (nothing to drop)",
      "the second intent section (nothing to drop)",
      "schedule to the earliest day (nothing to drop)",
      "the first area page to its Current state",
    ],
    manifest: [
      "areas/oversize#Current state",
      "priorities#Rules learned from corrections",
      "schedule#Week Monday",
      "rulings:2",
    ],
    /** The whole page, cut down to its Current state, is back in the index. */
    fetchableLine: "- model-of-tom/areas/oversize.md (15.0K) — tts-search areas oversize",
  },
});
