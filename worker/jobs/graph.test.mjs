// Tests for the pure graph (worker/jobs/graph.mjs) and its hash
// (worker/jobs/graph-hash.mjs).
//
// EVERYTHING HERE RUNS ON FIXTURE TEXT. The builder is a function of already-read
// pages, so a fixture is a string and nothing else — no vault, no snapshot, no
// disk, no network. That is the whole point of keeping this half pure, and a test
// that read Tom's real model-of-tom would start failing the next time he edited a
// line.
//
// What is pinned: the hash against node:crypto, the node and edge shapes a page
// becomes, the two-record rule, and the four real bugs the round caught — the
// `\r?` in the heading regex, the page order of a line, `pageKey` telling two
// repositories' `AGENTS.md` apart, and the `categories:` brackets.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hash8, ruleId, sha256Hex } from "./graph-hash.mjs";
import {
  CITATION_KINDS,
  DEFINES_CAP,
  EDGE_KINDS,
  GRAPH_NODES_CAP,
  NODE_KINDS,
  RENDER_ORDER,
  SEED_WEIGHTS,
  areaId,
  buildGraph,
  byRenderOrder,
  evidenceId,
  givenNodes,
  headingId,
  lineId,
  pageId,
  pageKey,
  recordId,
  renderPlaced,
  renderSkillBody,
  repoId,
  seedsFor,
  skillId,
  sourceId,
  subgraphOf,
  termId,
  walk,
} from "./graph.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BRIEF_PATH = "model-of-tom/agent-rules.md";

/**
 * A page shaped like the map: a level-1 heading, a PROSE paragraph as its first
 * content line, a level-2 heading with two bullets, and a level-3 heading under
 * that. The prose line is deliberately first — `agent-rules.md` opens with one,
 * and a builder that made nodes only of bullets would silently drop it.
 */
const BRIEF_LINES = [
  /* 0 */ "# Brief",
  /* 1 */ "",
  /* 2 */ "Prose opens the page, and it is not a bullet.",
  /* 3 */ "",
  /* 4 */ "## Map",
  /* 5 */ "",
  /* 6 */ "- tom.quest is the site.",
  /* 7 */ "- WikiTom is the vault.",
  /* 8 */ "",
  /* 9 */ "### Repos",
  /* 10 */ "",
  /* 11 */ "- CMT is his research code.",
  /* 12 */ "",
];
const BRIEF = BRIEF_LINES.join("\n");

function briefGraph(extra = {}) {
  return buildGraph({ pages: [{ path: BRIEF_PATH, body: BRIEF }], ...extra });
}

function idsOf(graph, kind) {
  return graph.nodes.filter((row) => row.kind === kind).map((row) => row.id);
}

function edgesFrom(graph, from) {
  return graph.edges.filter((row) => row.from === from);
}

function memberEdge(graph, from) {
  return graph.edges.find((row) => row.kind === "member-of" && row.from === from);
}

/** A graph object built by hand, for the walk's own rules. `walk` reads only
 * `nodes` and `edges`, so a four-node fixture with equal-size nodes makes the
 * admission order observable without a page in the way. */
function handGraph(nodes, edges) {
  return {
    nodeKinds: [...NODE_KINDS],
    edgeKinds: [...EDGE_KINDS],
    nodes: nodes.map(([kind, id, text]) => ({
      kind,
      id,
      title: null,
      text,
      path: null,
      heading: null,
      order: null,
      ref: null,
      version: null,
    })),
    edges: edges.map(([kind, from, to, weight]) => ({ kind, from, to, weight, evidence: "fixture" })),
  };
}

/** Ten bytes of text each, so every node in a hand graph costs the same eleven
 * bytes and a budget is a node count. */
const TEN = "0123456789";

const TIE_NODES = [
  ["page", "page:seed", TEN],
  ["line", "line:aaa", TEN],
  ["heading", "heading:bbb", TEN],
  ["line", "line:zzz", TEN],
];
const TIE_EDGES = [
  ["member-of", "line:aaa", "page:seed", 900],
  ["member-of", "heading:bbb", "page:seed", 900],
  ["member-of", "line:zzz", "page:seed", 900],
];

// ── 1. The hash ──────────────────────────────────────────────────────────────

describe("sha256Hex is node:crypto's answer", () => {
  const CASES = [
    ["the empty string", ""],
    ["abc", "abc"],
    ["55 bytes, one under the padding boundary", "a".repeat(55)],
    ["56 bytes, the boundary itself", "a".repeat(56)],
    ["63 bytes", "a".repeat(63)],
    ["64 bytes, one whole block", "a".repeat(64)],
    ["65 bytes, one byte into the second block", "a".repeat(65)],
    ["1,000 bytes", Array.from({ length: 1000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("")],
    ["an em dash and a middot", "he said — plainly · and once"],
    ["an astral-plane emoji", "a 😀 b 𝄞 c"],
  ];

  for (const [what, input] of CASES) {
    it(`matches node:crypto on ${what}`, () => {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    });
  }

  it("spells hash8 as the first eight hex of the same digest", () => {
    for (const [, input] of CASES) {
      expect(hash8(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8));
    }
  });

  it("keeps simplify.mjs's ruleId spelling: lowercase, bullet stripped, whitespace collapsed, trimmed", () => {
    // A rule's id in a blast-radius row and a node's id in the graph have to be
    // the same eight characters. This re-spells the normalization the way
    // simplify.mjs did, over node:crypto, and asserts the moved copy agrees.
    const historical = (line) =>
      createHash("sha256")
        .update(
          String(line)
            .toLowerCase()
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
            .replace(/\s+/g, " ")
            .trim(),
          "utf8",
        )
        .digest("hex")
        .slice(0, 8);
    for (const line of [
      "- Commit with a full message before every stop.",
      "* A star bullet.",
      "+ A plus bullet.",
      "1. A numbered bullet.",
      "2) A parenthesised bullet.",
      "   Indented   prose   with   runs   of   space.  ",
      "MiXeD CaSe",
      "",
    ]) {
      expect(ruleId(line), line).toBe(historical(line));
    }
  });

  it("gives a bulleted line and its unbulleted text one id", () => {
    // This is what lets an evidence entry name a bullet without repeating the
    // dash, and what makes one line in two spellings one node.
    expect(ruleId("- Ship the graph this week.")).toBe(ruleId("Ship the graph this week."));
  });
});

// ── 2, 3. A page's nodes ─────────────────────────────────────────────────────

describe("a synthesis page becomes page, heading and line nodes", () => {
  const graph = briefGraph();

  it("mints one page node and a heading node per heading", () => {
    expect(idsOf(graph, "page")).toEqual([pageId(BRIEF_PATH)]);
    expect(idsOf(graph, "heading").sort()).toEqual(
      [
        headingId(BRIEF_PATH, "Brief"),
        headingId(BRIEF_PATH, "Map"),
        headingId(BRIEF_PATH, "Repos"),
      ].sort(),
    );
  });

  it("nests headings by level: the top heading hangs off the page, the rest off the heading above", () => {
    expect(memberEdge(graph, headingId(BRIEF_PATH, "Brief")).to).toBe(pageId(BRIEF_PATH));
    expect(memberEdge(graph, headingId(BRIEF_PATH, "Map")).to).toBe(headingId(BRIEF_PATH, "Brief"));
    expect(memberEdge(graph, headingId(BRIEF_PATH, "Repos")).to).toBe(headingId(BRIEF_PATH, "Map"));
  });

  it("hangs each line off the heading above it", () => {
    expect(memberEdge(graph, lineId(BRIEF_LINES[2])).to).toBe(headingId(BRIEF_PATH, "Brief"));
    expect(memberEdge(graph, lineId(BRIEF_LINES[6])).to).toBe(headingId(BRIEF_PATH, "Map"));
    expect(memberEdge(graph, lineId(BRIEF_LINES[7])).to).toBe(headingId(BRIEF_PATH, "Map"));
    expect(memberEdge(graph, lineId(BRIEF_LINES[11])).to).toBe(headingId(BRIEF_PATH, "Repos"));
  });

  it("numbers a line by its index in the PAGE, not by its index in its heading", () => {
    // This is what lets a whole page reconstruct: `- CMT is his research code.`
    // is the first line under `### Repos` and the twelfth line of the page, and
    // the graph records the twelfth.
    const cmt = graph.nodes.find((row) => row.id === lineId(BRIEF_LINES[11]));
    expect(cmt.order).toBe(11);
    expect(memberEdge(graph, cmt.id).at).toBe(`${BRIEF_PATH}:11`);
    expect(graph.nodes.find((row) => row.id === lineId(BRIEF_LINES[6])).order).toBe(6);
  });

  it("makes a node of every non-blank line, the opening prose paragraph included", () => {
    const texts = graph.nodes.filter((row) => row.kind === "line").map((row) => row.text).sort();
    expect(texts).toEqual([BRIEF_LINES[11], BRIEF_LINES[6], BRIEF_LINES[7], BRIEF_LINES[2]].sort());
    expect(texts).toContain("Prose opens the page, and it is not a bullet.");
  });

  it("makes no node of a blank line", () => {
    expect(graph.nodes.filter((row) => row.text === "")).toEqual([]);
    expect(graph.counts.byNodeKind.line).toBe(4);
  });
});

// ── 4. One line, two places ──────────────────────────────────────────────────

describe("two byte-identical bullets in two files", () => {
  const SHARED = "- One sentence, written once, standing in two files.";
  const graph = buildGraph({
    pages: [
      { path: "model-of-tom/intent.md", body: ["## Directions", "", SHARED, ""].join("\n") },
      { path: "model-of-tom/priorities.md", body: ["# Priorities", "", "## First", "", SHARED, ""].join("\n") },
    ],
  });

  it("are ONE node", () => {
    expect(graph.nodes.filter((row) => row.id === lineId(SHARED))).toHaveLength(1);
  });

  it("carry one member-of edge each, and each edge's `at` names its own page and order", () => {
    const edges = edgesFrom(graph, lineId(SHARED)).filter((row) => row.kind === "member-of");
    expect(edges.map((row) => row.at).sort()).toEqual(
      ["model-of-tom/intent.md:2", "model-of-tom/priorities.md:4"].sort(),
    );
    expect(edges.map((row) => row.to).sort()).toEqual(
      [headingId("model-of-tom/intent.md", "Directions"), headingId("model-of-tom/priorities.md", "First")].sort(),
    );
  });
});

// ── 5. Two texts at one id ───────────────────────────────────────────────────

describe("two different texts that hash alike", () => {
  it("are reported as a collision rather than silently merged", () => {
    const graph = buildGraph({
      pages: [{ path: "model-of-tom/intent.md", body: "Alpha is one line.\n\nBeta is another.\n" }],
      hash: () => "deadbeef",
    });
    expect(graph.collisions).toHaveLength(1);
    expect(graph.collisions[0].id).toBe("line:deadbeef");
    expect(graph.collisions[0].first.normalized).toBe("alpha is one line.");
    expect(graph.collisions[0].second.normalized).toBe("beta is another.");
    expect(graph.collisions[0].second.path).toBe("model-of-tom/intent.md");
  });

  it("says nothing when two spellings normalize alike, because that is one line", () => {
    const graph = buildGraph({
      pages: [{ path: "model-of-tom/intent.md", body: "- Ship it.\n\nShip   it.\n" }],
    });
    expect(graph.collisions).toEqual([]);
  });
});

// ── 6. An area page's categories ─────────────────────────────────────────────

describe("an area page's `categories:` line", () => {
  const AREA_PATH = "model-of-tom/areas/admin.md";
  const graph = buildGraph({
    pages: [
      {
        path: AREA_PATH,
        body: "---\nupdated: 2026-09-10\ncategories: [alpha, middle, omega]\n---\n\n## Current state\n\n- Clear.\n",
      },
    ],
  });
  const applies = graph.edges.filter((row) => row.kind === "applies-to" && row.from === areaId("admin"));

  it("becomes an applies-to edge per term, brackets stripped, FIRST and LAST present", () => {
    // The regression skill-router.mjs documents: splitting on commas alone left
    // `[alpha` and `omega]`, so the first and last category of every area page
    // matched nothing.
    expect(applies.map((row) => row.to).sort()).toEqual(
      [termId("admin"), termId("alpha"), termId("middle"), termId("omega")].sort(),
    );
    expect(applies.map((row) => row.to)).toContain(termId("alpha"));
    expect(applies.map((row) => row.to)).toContain(termId("omega"));
  });

  it("never mints a bracketed term", () => {
    expect(idsOf(graph, "term")).not.toContain("term:[alpha");
    expect(idsOf(graph, "term")).not.toContain("term:omega]");
  });

  it("names the page's own frontmatter as the evidence", () => {
    expect(new Set(applies.map((row) => row.evidence))).toEqual(new Set([`${AREA_PATH}:categories`]));
  });
});

// ── 7. The evidence chain ────────────────────────────────────────────────────

const INTENT_PATH = "model-of-tom/intent.md";
const INTENT_BODY = ["# Intent", "", "## Directions", "", "- Ship the graph this week.", ""].join("\n");
const ORPHAN = "A sentence that no page of the vault carries.";
const EVIDENCE_PATH = "model-of-tom/evidence/intent.md";
const EVIDENCE_BODY = [
  "- line: Ship the graph this week.",
  "  said: 2026-09-12",
  "  read: sessions/2026-09-12.md",
  `- line: ${ORPHAN}`,
  "  said: 2026-09-11",
  "",
].join("\n");

function evidenceGraph() {
  return buildGraph({
    pages: [{ path: INTENT_PATH, body: INTENT_BODY }],
    evidence: [{ path: EVIDENCE_PATH, body: EVIDENCE_BODY }],
  });
}

describe("an evidence file becomes evidence and source nodes", () => {
  const graph = evidenceGraph();
  const entry = evidenceId("Ship the graph this week.");

  it("mints an evidence node per entry and a source node per field", () => {
    expect(idsOf(graph, "evidence").sort()).toEqual([entry, evidenceId(ORPHAN)].sort());
    expect(idsOf(graph, "source").sort()).toEqual(
      [sourceId("said", "2026-09-12"), sourceId("read", "sessions/2026-09-12.md"), sourceId("said", "2026-09-11")].sort(),
    );
  });

  it("joins the entry to the line it names, and each source to its entry", () => {
    expect(edgesFrom(graph, entry).filter((row) => row.kind === "evidences").map((row) => row.to)).toEqual([
      lineId("- Ship the graph this week."),
    ]);
    expect(edgesFrom(graph, sourceId("said", "2026-09-12"))[0]).toMatchObject({ kind: "evidences", to: entry });
  });

  it("writes NO edge for an entry whose text matches no line and no rule", () => {
    // The graph never invents a link. scripts/graph.mjs's G4 is what reports
    // this one for a synthesis file; here the only assertion is the absence.
    expect(edgesFrom(graph, evidenceId(ORPHAN)).filter((row) => row.kind === "evidences")).toEqual([]);
    expect(graph.nodes.some((row) => row.id === evidenceId(ORPHAN))).toBe(true);
  });
});

// ── 8, 10. Purity and the two versions ───────────────────────────────────────

describe("buildGraph is a pure function of its input", () => {
  it("serializes byte-identically on two calls with the same input", () => {
    const input = () => ({
      pages: [{ path: BRIEF_PATH, body: BRIEF }, { path: INTENT_PATH, body: INTENT_BODY }],
      evidence: [{ path: EVIDENCE_PATH, body: EVIDENCE_BODY }],
      vocabulary: { terms: [{ term: "graph" }, { term: "site" }] },
      record: { todos: [{ id: "t1", status: "active", category: "admin" }] },
    });
    expect(JSON.stringify(buildGraph(input()))).toBe(JSON.stringify(buildGraph(input())));
  });
});

describe("the two versions move at their own rates", () => {
  const base = { pages: [{ path: BRIEF_PATH, body: BRIEF }] };

  it("keeps `version` across two builds of the same text", () => {
    expect(buildGraph(base).version).toBe(buildGraph(base).version);
    expect(buildGraph(base).version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("moves `version` when one bullet changes by one character", () => {
    const edited = BRIEF.replace("- CMT is his research code.", "- CMT is his research codes.");
    expect(buildGraph({ pages: [{ path: BRIEF_PATH, body: edited }] }).version).not.toBe(buildGraph(base).version);
  });

  it("moves `recordVersion` and NOT `version` when a todo is captured", () => {
    // A run records `version` to say which definitions and rules it ran under;
    // that must not change because a todo arrived overnight.
    const before = buildGraph({ ...base, record: { todos: [] } });
    const after = buildGraph({ ...base, record: { todos: [{ id: "t1", status: "active" }] } });
    expect(after.version).toBe(before.version);
    expect(after.recordVersion).not.toBe(before.recordVersion);
    expect(after.nodes.some((row) => row.id === recordId("todo", "t1"))).toBe(true);
  });
});

// ── 9. Line endings ──────────────────────────────────────────────────────────

describe("a CRLF page and an LF page", () => {
  const CRLF_PATH = "model-of-tom/ground.md";
  const LINES = ["# Head", "", "- A bullet line.", ""];
  const lf = buildGraph({ pages: [{ path: CRLF_PATH, body: LINES.join("\n") }] });
  const crlf = buildGraph({ pages: [{ path: CRLF_PATH, body: LINES.join("\r\n") }] });

  it("mint the SAME node ids, because ruleId collapses whitespace", () => {
    expect(crlf.nodes.map((row) => row.id).sort()).toEqual(lf.nodes.map((row) => row.id).sort());
  });

  it("keep, on each node, the bytes that occurrence actually had", () => {
    const text = (graph) => graph.nodes.find((row) => row.kind === "line").text;
    expect(text(lf)).toBe("- A bullet line.");
    expect(text(crlf)).toBe("- A bullet line.\r");
  });

  it("both read `# Head` as a heading", () => {
    // The trailing `\r?` in the heading regex. Without it a CRLF page's sixteen
    // headings all read as ordinary lines and the page flattens into one list.
    expect(idsOf(crlf, "heading")).toEqual([headingId(CRLF_PATH, "Head")]);
    expect(idsOf(crlf, "heading")).toEqual(idsOf(lf, "heading"));
    expect(crlf.nodes.some((row) => row.kind === "line" && row.text.startsWith("# Head"))).toBe(false);
  });
});

// ── 11–16. The walk ──────────────────────────────────────────────────────────

describe("the walk admits in cost order", () => {
  const graph = handGraph(TIE_NODES, TIE_EDGES);
  const result = walk(graph, [{ id: "page:seed", weight: SEED_WEIGHTS.task }], 33);

  it("orders by cost, then by kind rank, then by id", () => {
    // All three neighbours cost the same; `heading` outranks `line` in
    // RENDER_ORDER, and two lines at one cost go by id.
    expect(Object.keys(result.costs)).toEqual(["page:seed", "heading:bbb", "line:aaa", "line:zzz"]);
    expect(result.costs).toEqual({ "page:seed": 0, "heading:bbb": 100, "line:aaa": 100, "line:zzz": 100 });
  });

  it("takes the cheapest prefix the budget affords", () => {
    expect(new Set(result.nodes.map((row) => row.id))).toEqual(new Set(["page:seed", "heading:bbb", "line:aaa"]));
    expect(result.frontier.map((row) => row.id)).toEqual(["line:zzz"]);
    expect(result.bytes).toBe(33);
  });

  it("yields the same node order on two calls with the same input", () => {
    const again = walk(handGraph(TIE_NODES, TIE_EDGES), [{ id: "page:seed", weight: SEED_WEIGHTS.task }], 33);
    expect(again.nodes.map((row) => row.id)).toEqual(result.nodes.map((row) => row.id));
    expect(Object.keys(again.costs)).toEqual(Object.keys(result.costs));
  });
});

describe("the walk renders in RENDER_ORDER, not in cost order", () => {
  const graph = briefGraph({ skills: [{ name: "know-brief", sourcePaths: [BRIEF_PATH] }] });
  const result = walk(graph, [{ id: pageId(BRIEF_PATH), weight: SEED_WEIGHTS.task }], 100_000, null, {
    kinds: ["heading", "line"],
    maxHops: 6,
  });

  it("puts every heading before every line, then goes by page and by order", () => {
    expect(result.nodes.map((row) => row.id)).toEqual(result.nodes.slice().sort(byRenderOrder).map((row) => row.id));
    expect(result.nodes.map((row) => row.kind)).toEqual(["heading", "heading", "heading", "line", "line", "line", "line"]);
    expect(result.nodes.map((row) => row.order)).toEqual([0, 4, 9, 2, 6, 7, 11]);
  });

  it("is NOT the cost order, which interleaves the two kinds", () => {
    const reached = Object.keys(result.costs).filter((id) => RENDER_ORDER.includes(id.split(":")[0]));
    expect(reached.filter((id) => id.startsWith("heading:") || id.startsWith("line:"))).not.toEqual(
      result.nodes.map((row) => row.id),
    );
  });

  it("renders a whole page byte-identically to the page body", () => {
    expect(renderPlaced(subgraphOf(graph, skillId("know-brief")))).toBe(BRIEF.trim());
  });
});

describe("exclude", () => {
  it("removes one node and leaves the rest of its page admitted", () => {
    const graph = briefGraph();
    const dropped = lineId(BRIEF_LINES[6]);
    const result = walk(graph, [{ id: pageId(BRIEF_PATH), weight: SEED_WEIGHTS.task }], 100_000, null, {
      maxHops: 6,
      exclude: new Set([dropped]),
    });
    const ids = result.nodes.map((row) => row.id);
    expect(ids).not.toContain(dropped);
    expect(result.frontier.map((row) => row.id)).not.toContain(dropped);
    for (const index of [2, 7, 11]) expect(ids).toContain(lineId(BRIEF_LINES[index]));
  });
});

describe("the frontier", () => {
  it("holds every reached node that was not admitted, exactly once", () => {
    const graph = briefGraph();
    const result = walk(graph, [{ id: pageId(BRIEF_PATH), weight: SEED_WEIGHTS.task }], 60, null, { maxHops: 6 });
    const admitted = result.nodes.map((row) => row.id);
    const frontier = result.frontier.map((row) => row.id);
    expect(frontier.length).toBeGreaterThan(0);
    expect(new Set(frontier).size).toBe(frontier.length);
    expect([...admitted, ...frontier].sort()).toEqual(Object.keys(result.costs).sort());
  });
});

describe("the walk is bounded", () => {
  it("reaches nothing past maxHops", () => {
    const graph = handGraph(TIE_NODES, TIE_EDGES);
    expect(Object.keys(walk(graph, ["page:seed"], 10_000, null, { maxHops: 0 }).costs)).toEqual(["page:seed"]);
    expect(Object.keys(walk(graph, ["page:seed"], 10_000, null, { maxHops: 1 }).costs)).toHaveLength(4);
  });

  it("stops at maxVisit", () => {
    const result = walk(handGraph(TIE_NODES, TIE_EDGES), ["page:seed"], 10_000, null, { maxVisit: 2 });
    expect(result.visited).toBe(2);
    expect(Object.keys(result.costs)).toHaveLength(2);
  });

  it("terminates on a graph with a cycle", () => {
    const cycle = handGraph(
      [["line", "line:a", TEN], ["line", "line:b", TEN], ["line", "line:c", TEN]],
      [
        ["member-of", "line:a", "line:b", 900],
        ["member-of", "line:b", "line:c", 900],
        ["member-of", "line:c", "line:a", 900],
      ],
    );
    const result = walk(cycle, ["line:a"], 10_000, null, { maxHops: 50 });
    expect(result.visited).toBe(3);
    expect(result.nodes.map((row) => row.id)).toEqual(["line:a", "line:b", "line:c"]);
  });
});

describe("THE TWO-RECORD RULE", () => {
  const graph = evidenceGraph();
  const entry = evidenceId("Ship the graph this week.");
  const said = sourceId("said", "2026-09-12");
  const seedOnPage = [{ id: pageId(INTENT_PATH), weight: SEED_WEIGHTS.task }];

  it("never admits an evidence or source node on a walk seeded on a subject, however large the budget", () => {
    // A rule in `walk`, not a weight: a budget is a byte count, not a cost
    // ceiling, so a large enough budget would otherwise put a date and a
    // quotation into a run's prompt.
    const result = walk(graph, seedOnPage, 10_000_000, null, { maxHops: 20 });
    expect(result.nodes.filter((row) => CITATION_KINDS.has(row.kind))).toEqual([]);
    expect(result.frontier.map((row) => row.id)).toEqual(expect.arrayContaining([entry, said]));
  });

  it("admits the entry a walk is SEEDED on, and still not its sources", () => {
    const result = walk(graph, [{ id: entry, weight: SEED_WEIGHTS.task }], 10_000_000, null, { maxHops: 20 });
    expect(result.nodes.map((row) => row.id)).toContain(entry);
    expect(result.nodes.map((row) => row.id)).not.toContain(said);
  });

  it("admits both when the caller asks for citations by name", () => {
    const result = walk(graph, seedOnPage, 10_000_000, null, { maxHops: 20, citations: true });
    expect(result.nodes.map((row) => row.id)).toEqual(expect.arrayContaining([entry, said]));
  });
});

// ── 17, 18. What a prompt carried, and what a run seeds ──────────────────────

describe("givenNodes", () => {
  const pages = [{ path: BRIEF_PATH, body: BRIEF }];

  it("returns the prefix page's line and heading node ids, plus a node per granted skill", () => {
    const ids = givenNodes({ pages, prefixPaths: [BRIEF_PATH], granted: ["write", "know-intent"] });
    for (const index of [2, 6, 7, 11]) expect(ids).toContain(lineId(BRIEF_LINES[index]));
    for (const title of ["Brief", "Map", "Repos"]) expect(ids).toContain(headingId(BRIEF_PATH, title));
    expect(ids).toContain(pageId(BRIEF_PATH));
    expect(ids).toContain(skillId("write"));
    expect(ids).toContain(skillId("know-intent"));
  });

  it("resolves a `tom-` prefixed grant to the same id as the bare name", () => {
    const bare = givenNodes({ pages: [], granted: ["know-research"] });
    expect(givenNodes({ pages: [], granted: ["tom-know-research"] })).toEqual(bare);
    expect(bare).toEqual([skillId("know-research")]);
  });

  it("de-duplicates", () => {
    const twice = [{ path: INTENT_PATH, body: "- Ship it.\n\n- Ship it.\n" }];
    const ids = givenNodes({ pages: twice, prefixPaths: [INTENT_PATH, INTENT_PATH] });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([pageId(INTENT_PATH), lineId("- Ship it.")]);
  });

  it("truncates to exactly GRAPH_NODES_CAP, visibly", () => {
    const many = Array.from({ length: 300 }, (_, index) => `- Line number ${index}.`).join("\n");
    const ids = givenNodes({
      pages: [{ path: INTENT_PATH, body: many }],
      prefixPaths: [INTENT_PATH],
      granted: ["write"],
    });
    expect(ids).toHaveLength(GRAPH_NODES_CAP);
  });
});

describe("seedsFor", () => {
  it("makes the subject the highest-weight seed for each of todo, batch, area and repo", () => {
    for (const [subject, id] of [
      [{ kind: "todo", todoId: "t1" }, recordId("todo", "t1")],
      [{ kind: "batch", batchId: "b1" }, recordId("batch", "b1")],
      [{ kind: "area", area: "research" }, areaId("research")],
      [{ kind: "repo", repo: "tom.quest" }, repoId("tom.quest")],
    ]) {
      const seeds = seedsFor({ subject, repo: "tom.quest", terms: ["graph"] });
      expect(seeds[0], JSON.stringify(subject)).toEqual({ id, weight: SEED_WEIGHTS.task });
      expect(seeds.every((seed) => seed.weight <= seeds[0].weight)).toBe(true);
    }
  });

  it("seeds NOTHING for laptop and for none", () => {
    // The retired rule 12 unchanged: with no subject nothing is admitted and the
    // whole index is the frontier.
    expect(seedsFor({ subject: { kind: "laptop" } })).toEqual([]);
    expect(seedsFor({ subject: { kind: "none" } })).toEqual([]);
    expect(seedsFor({})).toEqual([]);
  });
});

// ── 19. Two repositories, two AGENTS.md ──────────────────────────────────────

describe("pageKey keeps two repositories' AGENTS.md apart", () => {
  const QUEST = "# tom.quest\n\n## Rules\n\n- Commit with a full message.\n";
  const CMT = "# ComplexMultiTrigger\n\n## Rules\n\n- A live campaign ships its fix unapproved.\n";
  const graph = buildGraph({
    repoRules: [
      { repo: "tom.quest", path: "AGENTS.md", body: QUEST },
      { repo: "ComplexMultiTrigger", path: "AGENTS.md", body: CMT },
    ],
    skills: [
      { name: "repo-tom.quest", origin: "tom.quest", sourcePaths: ["AGENTS.md"] },
      { name: "repo-ComplexMultiTrigger", origin: "ComplexMultiTrigger", sourcePaths: ["AGENTS.md"] },
    ],
  });

  it("mints two distinct page nodes", () => {
    expect(idsOf(graph, "page").sort()).toEqual(
      [pageId(pageKey("tom.quest", "AGENTS.md")), pageId(pageKey("ComplexMultiTrigger", "AGENTS.md"))].sort(),
    );
  });

  it("renders each skill only its OWN repository's rules", () => {
    // A page id built from the path alone named both repositories' root rules
    // with one string, and then one repository's rules rendered as the other's.
    expect(renderSkillBody(graph, { name: "repo-tom.quest", sourcePaths: ["AGENTS.md"], group: "repo", origin: "tom.quest" })).toBe(QUEST.trim());
    expect(renderSkillBody(graph, { name: "repo-ComplexMultiTrigger", sourcePaths: ["AGENTS.md"], group: "repo", origin: "ComplexMultiTrigger" })).toBe(CMT.trim());
  });

  it("keeps each repository's rules out of the other's subgraph", () => {
    const quest = renderSkillBody(graph, { name: "repo-tom.quest", sourcePaths: ["AGENTS.md"], group: "repo", origin: "tom.quest" });
    expect(quest).not.toContain("live campaign");
    expect(quest).not.toContain("ComplexMultiTrigger");
  });
});

// ── 20. The defines cap ──────────────────────────────────────────────────────

describe("a term that matches more nodes than DEFINES_CAP", () => {
  const COUNT = DEFINES_CAP + 6;
  const graph = buildGraph({
    pages: [
      {
        path: INTENT_PATH,
        body: Array.from({ length: COUNT }, (_, index) => `- The widget numbered ${index} holds.`).join("\n"),
      },
    ],
    vocabulary: { terms: [{ term: "widget", definition: "a thing" }] },
  });

  it("keeps exactly DEFINES_CAP defines edges", () => {
    expect(edgesFrom(graph, termId("widget")).filter((row) => row.kind === "defines")).toHaveLength(DEFINES_CAP);
  });

  it("reports the term and the count in graph.notes", () => {
    // A short common word makes `near term:run` a dump rather than an answer;
    // the cap keeps the file small and the note keeps the cut visible.
    expect(graph.notes).toContain(`term "widget" matches ${COUNT} nodes — capped at ${DEFINES_CAP}`);
  });

  it("says nothing when the term is under the cap", () => {
    const small = buildGraph({
      pages: [{ path: INTENT_PATH, body: "- One widget only.\n" }],
      vocabulary: { terms: [{ term: "widget" }] },
    });
    expect(small.notes).toEqual([]);
    expect(edgesFrom(small, termId("widget")).filter((row) => row.kind === "defines")).toHaveLength(1);
  });
});
