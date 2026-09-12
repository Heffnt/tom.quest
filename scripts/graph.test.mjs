// Tests for the graph generator (scripts/graph.mjs) — the half that touches a
// disk.
//
// EVERY TEST RUNS AGAINST A FIXTURE CHECKOUT written to a node:os tmpdir: a
// `model-of-tom/` tree, an `AGENTS.md`, and, where the test needs them, a
// `tts/vocabulary.json` and a `tts/snapshot/*.jsonl`. Nothing here reads the real
// WikiTom, the real snapshot or the network, and nothing is written outside the
// tmpdir, which `afterAll` removes.
//
// Each fixture carries its own `.git/HEAD` holding a fixed 40-hex commit, because
// `headCommit` parses `.git` rather than shelling out and a checkout with no
// commit would put `null` into `generatedFrom` — which is exactly what the
// serialization test says must never be written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GRAPH_MAX_BYTES } from "../worker/jobs/graph.mjs";
import {
  GRAPH_PATH,
  RECORD_NODES,
  REJECTS,
  generateGraph,
  main,
  serializeGraph,
  skillBodies,
} from "./graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// ── The fixture checkout ─────────────────────────────────────────────────────

let root;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cli-test-"));
});

afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

const WIKITOM_COMMIT = "a".repeat(40);
const TOM_QUEST_COMMIT = "b".repeat(40);

const AGENT_RULES = [
  "# Agent rules",
  "",
  "## Map",
  "",
  "### Repos",
  "- tom.quest: site, Convex record, box jobs; AGENTS.md at the root.",
  "",
  "### Never",
  "- Invent anything about him.",
  "",
].join("\n");

/** An em dash and a middot, so the UTF-8 assertion has something to prove. */
const PRIORITIES = "# Priorities\n\nResearch first — always — and the record second · never the reverse.\n";

/**
 * The fixture's schema. It declares the base area page's three categories
 * because G7 fires on an `applies-to` edge to a term the vocabulary does not
 * carry, and every fixture with an area page mints three of those — a base
 * vocabulary that left them out would put a G7 block in the report of every
 * other test in this file.
 */
const BASE_VOCABULARY = {
  version: "2026-09-12",
  terms: [
    { term: "admin" },
    { term: "chores" },
    { term: "email" },
    { term: "graph" },
    { term: "record" },
  ],
};

/**
 * One whole checkout on disk. `overrides` replaces a single file's text;
 * `vocabulary: null` and `snapshot: null` leave that file out entirely.
 */
function makeCheckout(name, overrides = {}) {
  const base = path.join(root, name);
  const wikitom = path.join(base, "wikitom");
  const tomQuest = path.join(base, "tom.quest");
  const write = (dir) => (relative, body) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
    return file;
  };
  const w = write(wikitom);
  const q = write(tomQuest);

  w(".git/HEAD", `${WIKITOM_COMMIT}\n`);
  q(".git/HEAD", `${TOM_QUEST_COMMIT}\n`);
  w("model-of-tom/agent-rules.md", overrides.agentRules ?? AGENT_RULES);
  w("model-of-tom/writing.md", overrides.writing ?? "# Writing\n\n## Registers\n\nPlain sentences, no flourish.\n");
  w("model-of-tom/ground.md", overrides.ground ?? "# Ground\n\nWhat he already knows.\n");
  w("model-of-tom/intent.md", overrides.intent ?? "# Intent\n\n## Directions\n\n- Ship the graph this week.\n");
  w("model-of-tom/priorities.md", overrides.priorities ?? PRIORITIES);
  w("model-of-tom/schedule.md", overrides.schedule ?? "# Schedule\n\nTuesday is practice.\n");
  w(
    "model-of-tom/areas/admin.md",
    overrides.area
      ?? "---\nupdated: 2026-09-10\ncategories: [admin, email, chores]\n---\n\n## Current state\n\n- The inbox is clear.\n",
  );
  if (overrides.evidence !== undefined) {
    for (const [relative, body] of Object.entries(overrides.evidence)) w(`model-of-tom/evidence/${relative}`, body);
  }
  const vocabulary = overrides.vocabulary === undefined ? BASE_VOCABULARY : overrides.vocabulary;
  if (vocabulary !== null) w("tts/vocabulary.json", `${JSON.stringify(vocabulary, null, 2)}\n`);

  const snapshot = overrides.snapshot === undefined ? {} : overrides.snapshot;
  if (snapshot !== null) {
    fs.mkdirSync(path.join(wikitom, "tts", "snapshot"), { recursive: true });
    for (const [table, rows] of Object.entries(snapshot)) {
      w(`tts/snapshot/${table}`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
  }

  q("AGENTS.md", overrides.rootRules ?? "# tom.quest\n\n## Rules\n\n- Commit with a full message before every stop.\n");
  q("convex/AGENTS.md", "# convex\n\n- The record is the one home for a per-run fact.\n");

  return {
    wikitom,
    tomQuest,
    write: w,
    graphFile: path.join(wikitom, GRAPH_PATH),
    build: (options = {}) => generateGraph({ wikitom, tomQuest, ...options }),
    run: (argv) => {
      const out = [];
      const err = [];
      const code = main(
        [...argv, "--wikitom", wikitom, "--tom-quest", tomQuest],
        (text) => out.push(String(text)),
        (text) => err.push(String(text)),
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
  };
}

// ── Reading the report ───────────────────────────────────────────────────────

/** The DISAGREEMENT blocks of a printed report, in order. */
function blocksOf(text) {
  const start = text.indexOf("DISAGREEMENT ");
  if (start === -1) return [];
  return text
    .slice(start)
    .split("\n\n")
    .filter((block) => block.startsWith("DISAGREEMENT "));
}

function codesOf(text) {
  return blocksOf(text).map((block) => block.slice("DISAGREEMENT ".length, "DISAGREEMENT ".length + 2));
}

/**
 * The printed shape, asserted rather than eyeballed: a `DISAGREEMENT <code>
 * <subject>` line, then indented label rows (a label padded to five, then the
 * text; a wrapped line is indented eight), then a `  fix   ` row last.
 */
function expectBlockShape(block, code) {
  const lines = block.split("\n");
  expect(lines[0]).toMatch(new RegExp(`^DISAGREEMENT ${code} {2}\\S`));
  expect(lines[lines.length - 1]).toMatch(/^ {2}fix {3}\S/);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines.slice(1, -1)) {
    expect(line, `label row: ${JSON.stringify(line)}`).toMatch(/^(?: {2}[a-z]+ *\S| {8})/);
  }
}

/** The one block of a report that must hold exactly one. */
function onlyBlock(result, code) {
  expect(codesOf(result.out), result.out).toEqual([code]);
  const block = blocksOf(result.out)[0];
  expectBlockShape(block, code);
  return block;
}

// ── 21. --write ──────────────────────────────────────────────────────────────

describe("--write", () => {
  it("writes tts/graph.json, and re-running writes nothing at the same version", () => {
    const fixture = makeCheckout("write");
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
    const first = fixture.build({ write: true });
    expect(first.wrote).toBe(true);
    expect(first.changed).toEqual([GRAPH_PATH]);
    expect(fs.existsSync(fixture.graphFile)).toBe(true);

    const second = fixture.build({ write: true });
    expect(second.wrote).toBe(false);
    expect(second.changed).toEqual([]);
    expect(second.version).toBe(first.version);
    expect(second.recordVersion).toBe(first.recordVersion);
    expect(fs.readFileSync(fixture.graphFile, "utf8")).toBe(first.rendered);
  });

  it("exits 0 and says the file is already what the render produces", () => {
    const fixture = makeCheckout("write-cli");
    expect(fixture.run(["--write"]).code).toBe(0);
    const again = fixture.run(["--write"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`${GRAPH_PATH} is already what the render produces`);
  });
});

// ── 22. The serialization ────────────────────────────────────────────────────

describe("the serialization", () => {
  let rendered;
  let file;

  beforeAll(() => {
    const fixture = makeCheckout("serialize");
    fixture.build({ write: true });
    file = fixture.graphFile;
    rendered = fs.readFileSync(file, "utf8");
  });

  it("is UTF-8", () => {
    const bytes = fs.readFileSync(file);
    expect(bytes.toString("utf8")).toBe(rendered);
    expect(rendered).toContain("Research first — always — and the record second · never the reverse.");
    expect(bytes.length).toBe(Buffer.byteLength(rendered, "utf8"));
    expect(bytes.length).toBeGreaterThan(rendered.length); // the em dashes cost three bytes each
  });

  it("is LF, with a trailing newline and no carriage return anywhere", () => {
    expect(rendered).not.toContain("\r");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("}\n")).toBe(true);
  });

  it("indents by two spaces", () => {
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toMatch(/^ {2}"version": /);
    const nodesAt = lines.findIndex((line) => line === '  "nodes": [');
    expect(nodesAt).toBeGreaterThan(0);
    expect(lines[nodesAt + 1]).toBe("    {");
    expect(lines[nodesAt + 2]).toMatch(/^ {6}"kind": /);
  });

  it("orders the top-level keys version, recordVersion, generatedFrom, nodeKinds, edgeKinds, nodes, edges", () => {
    expect(Object.keys(JSON.parse(rendered))).toEqual([
      "version",
      "recordVersion",
      "generatedFrom",
      "nodeKinds",
      "edgeKinds",
      "nodes",
      "edges",
    ]);
  });

  it("writes no null-valued field", () => {
    // `compact` drops every null off a node and an edge; the fixture's `.git`
    // and its vocabulary version keep `generatedFrom` full, so a null anywhere
    // in the file means a field went missing that should not have.
    expect(rendered).not.toMatch(/:\s*null/);
    expect(JSON.stringify(JSON.parse(rendered))).not.toContain("null");
  });

  it("is the same bytes serializeGraph produces for the same graph", () => {
    const result = makeCheckout("serialize-twice").build();
    expect(serializeGraph(result.graph)).toBe(result.rendered);
  });
});

// ── 23. Over the cap ─────────────────────────────────────────────────────────

describe("a render over GRAPH_MAX_BYTES", () => {
  const HUGE = [
    "# Intent",
    "",
    "## Directions",
    "",
    ...Array.from(
      { length: 7000 },
      (_, index) => `- Rule number ${index} says something durable about the ${index}th thing, and ${"x".repeat(80)}.`,
    ),
    "",
  ].join("\n");

  let fixture;
  let result;

  beforeAll(() => {
    fixture = makeCheckout("over-cap", { intent: HUGE });
    result = fixture.run(["--write"]);
  });

  it("reports one G6 block naming the size, the cap, the largest kind and the per-kind counts", () => {
    const block = onlyBlock(result, "G6");
    expect(block.split("\n")[0]).toMatch(
      new RegExp(`^DISAGREEMENT G6 {2}${GRAPH_PATH.replace(".", "\\.")} is [\\d,]+ bytes$`),
    );
    expect(block).toContain(`  cap   ${GRAPH_MAX_BYTES.toLocaleString("en-US")} bytes`);
    expect(block).toMatch(/^ {2}largest line \(\d+ nodes\)$/m);
    expect(block).toMatch(/^ {2}nodes \{"area":\d+,.*"line":\d+/m);
    expect(block).toMatch(/^ {2}edges \{"applies-to":\d+,.*"member-of":\d+/m);
  });

  it("writes nothing", () => {
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
    expect(fixture.build({ write: true }).wrote).toBe(false);
  });

  it("returns 3, the exit code this file's own header promises for a render over the cap", () => {
    // This test found a real one: `main` returned 2 for any disagreement first
    // and G6 is a disagreement, so the cap's own exit code was unreachable and
    // a caller could not tell the structural-change alarm from a fixable
    // wording conflict. The cap's code is checked first now.
    expect(result.code).toBe(3);
  });
});

// ── 24. One test per disagreement class ──────────────────────────────────────

/**
 * G1 and G2 need a vocabulary that declares SOME kinds and not one the graph
 * mints — an empty declaration is skipped on purpose ("the vocabulary predates
 * the graph"). So the kinds are read off a first build and then written back
 * minus one.
 */
function vocabularyDeclaring(kinds, { dropNode, dropEdge } = {}) {
  return {
    version: "2026-09-12",
    terms: [
      ...BASE_VOCABULARY.terms,
      ...kinds.nodes.filter((kind) => kind !== dropNode).map((kind) => ({ term: kind, kind: "node-kind" })),
      ...kinds.edges.filter((kind) => kind !== dropEdge).map((kind) => ({ term: kind, kind: "edge-kind" })),
    ],
  };
}

function kindsOf(result) {
  return { nodes: Object.keys(result.counts.byNodeKind), edges: Object.keys(result.counts.byEdgeKind) };
}

describe("the disagreement classes", () => {
  it("finds none, and exits 0, on a checkout whose vocabulary declares every kind the graph mints", () => {
    const fixture = makeCheckout("g0");
    const kinds = kindsOf(fixture.build());
    fixture.write("tts/vocabulary.json", `${JSON.stringify(vocabularyDeclaring(kinds), null, 2)}\n`);
    const result = fixture.run([]);
    expect(blocksOf(result.out), result.out).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("G1 — a node kind the vocabulary does not declare", () => {
    const fixture = makeCheckout("g1");
    const kinds = kindsOf(fixture.build());
    fixture.write("tts/vocabulary.json", `${JSON.stringify(vocabularyDeclaring(kinds, { dropNode: "term" }), null, 2)}\n`);
    const result = fixture.run([]);
    const block = onlyBlock(result, "G1");
    expect(block).toContain('DISAGREEMENT G1  node kind "term"');
    expect(block).toMatch(/^ {2}graph \d+ node\(s\) of this kind$/m);
    expect(block).toContain("  schema tts/vocabulary.json declares no such node kind");
    expect(result.code).toBe(2);
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });

  it("G2 — an edge kind the vocabulary does not declare", () => {
    const fixture = makeCheckout("g2");
    const kinds = kindsOf(fixture.build());
    fixture.write(
      "tts/vocabulary.json",
      `${JSON.stringify(vocabularyDeclaring(kinds, { dropEdge: "applies-to" }), null, 2)}\n`,
    );
    const result = fixture.run([]);
    const block = onlyBlock(result, "G2");
    expect(block).toContain('DISAGREEMENT G2  edge kind "applies-to"');
    expect(block).toContain("  schema tts/vocabulary.json declares no such edge kind");
    expect(result.code).toBe(2);
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });

  // G3 — AN EDGE END THAT NAMES NO NODE — CANNOT BE DRIVEN FROM A FIXTURE
  // CHECKOUT, and is skipped rather than faked.
  //
  // Every edge the generator's inputs can produce either points at a node the
  // same pass minted or is guarded before it is written: `linkPageToSkill`
  // recomputes the very ids `addPage` minted from the same body, a skill whose
  // source page is missing is `continue`d, `addEvidence` writes an edge only
  // `if (b.nodes.has(target))`, `addDefines` and `addMentions` draw from the
  // node map itself, and a record-kind end is excluded from G3 by switch 2. The
  // ONE unguarded end in worker/jobs/graph.mjs is the `to` of a `supersedes`
  // edge — `if (!b.nodes.has(from)) continue` checks the `from` only — and
  // `generateGraph` never passes `changes`, so no command line reaches it.
  // Driving G3 would mean either adding a `--changes` input or reaching past the
  // CLI into `buildGraph`, which is the other file's business.
  it.skip("G3 — an edge end that names no node: not reachable from any fixture checkout (see comment)", () => {});

  it("G4 — an evidence entry that names no line of its synthesis file", () => {
    const fixture = makeCheckout("g4", {
      evidence: {
        "intent.md": [
          "- line: Ship the graph this week.",
          "  said: 2026-09-12",
          "- line: A sentence that no page of the vault carries.",
          "  said: 2026-09-11",
          "",
        ].join("\n"),
      },
    });
    const result = fixture.run([]);
    const block = onlyBlock(result, "G4");
    expect(block).toContain("  entry A sentence that no page of the vault carries.");
    expect(block).toContain("  page  model-of-tom/intent.md has no line with this text");
    expect(block).toContain("  fix   run `node scripts/check-evidence.mjs`");
    expect(result.code).toBe(2);
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });

  it("G4 — an evidence file with no synthesis counterpart at all", () => {
    const fixture = makeCheckout("g4b", {
      evidence: { "nowhere.md": "- line: Anything at all.\n  said: 2026-09-11\n" },
    });
    const block = onlyBlock(fixture.run([]), "G4");
    expect(block).toContain("DISAGREEMENT G4  model-of-tom/evidence/nowhere.md");
    expect(block).toContain("  entry the evidence file names model-of-tom/nowhere.md");
    expect(block).toContain("  page  which is not one of the synthesis files");
  });

  it("G5 — two different lines whose hash8 is the same eight characters", () => {
    // A REAL 32-bit collision, found by search over `ruleId` and pinned here:
    // `ruleId("collision probe 14565") === ruleId("collision probe 24048") ===
    // "0adf80f7"`. Nothing is stubbed — the generator hashes these two lines the
    // way it hashes every other one.
    const fixture = makeCheckout("g5", {
      intent: "# Intent\n\n## Directions\n\n- collision probe 14565\n- collision probe 24048\n",
    });
    const result = fixture.run([]);
    const block = onlyBlock(result, "G5");
    expect(block).toContain("DISAGREEMENT G5  node id line:0adf80f7");
    expect(block).toContain("        collision probe 14565");
    expect(block).toContain("        collision probe 24048");
    expect(block).toContain("  fix   a hash8 collision");
    expect(result.code).toBe(2);
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });

  // G6 has its own describe above, where the cap fixture lives.
  it("G6 — the render over the cap is one block and writes nothing", () => {
    const fixture = makeCheckout("g6", {
      intent: `# Intent\n\n## Directions\n\n${Array.from(
        { length: 7000 },
        (_, index) => `- A durable sentence numbered ${index}, and ${"y".repeat(80)}.`,
      ).join("\n")}\n`,
    });
    const result = fixture.run(["--write"]);
    onlyBlock(result, "G6");
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });

  it("G7 — cannot fire from any input, and the fixture proves the silence rather than faking the block", () => {
    // THIS TEST FOUND TWO REAL THINGS and neither was fixable by a fixture.
    //
    // G7 reads `defines` edges and every `defines` edge is minted from a
    // `vocabulary.terms` row, so the two sets agree by construction and no
    // input can separate them. The one gap that existed was a trim mismatch
    // between G7's set and `termsOf`'s — the checker disagreeing with itself —
    // which is fixed, and a term with surrounding whitespace now reports
    // nothing, as it should.
    //
    // Widening G7 to `applies-to`, which is what its `fix` line described, was
    // tried and withdrawn: an area page's `categories:` names a TODO CATEGORY
    // (`climbing`, `dnd`, `therapy`), not a word of the closed vocabulary, and
    // the widened check called all fifty-seven of them disagreements on the
    // real vault. The class stays as a guard for a second source of `defines`
    // edges, and this test holds it to silence.
    const trimmed = makeCheckout("g7", {
      vocabulary: { version: "2026-09-12", terms: [{ term: "  graph  " }, { term: "record" }] },
    });
    expect(codesOf(trimmed.run([]).out)).not.toContain("G7");

    const categories = makeCheckout("g7-categories", {
      vocabulary: { version: "2026-09-12", terms: [{ term: "graph" }] },
    });
    expect(codesOf(categories.run([]).out)).not.toContain("G7");
    expect(categories.run([]).code).toBe(0);
  });

  it("G8 — --check against a file the render does not produce", () => {
    const fixture = makeCheckout("g8");
    expect(fixture.run(["--write"]).code).toBe(0);
    const onDisk = fs.readFileSync(fixture.graphFile, "utf8");
    fixture.write(GRAPH_PATH, onDisk.replace('"nodeKinds"', '"nodeKindz"'));
    const result = fixture.run(["--check"]);
    const block = onlyBlock(result, "G8");
    expect(block).toContain(`DISAGREEMENT G8  ${GRAPH_PATH}`);
    expect(block).toMatch(/^ {8}@@ line \d+ @@$/m);
    expect(block).toContain('-  "nodeKindz": [');
    expect(block).toContain('+  "nodeKinds": [');
    expect(result.code).toBe(2);
  });
});

// ── 25. All of them, never the first ─────────────────────────────────────────

describe("several disagreements at once", () => {
  it("reports every one of them and then exits 2", () => {
    // A generator that stopped at the first would make fixing a batch of them a
    // batch of runs.
    const fixture = makeCheckout("many", {
      intent: "# Intent\n\n## Directions\n\n- collision probe 14565\n- collision probe 24048\n",
      vocabulary: { version: "2026-09-12", terms: [{ term: "  probe  " }] },
      evidence: {
        "intent.md": "- line: A sentence that no page of the vault carries.\n  said: 2026-09-11\n",
        "nowhere.md": "- line: Anything at all.\n  said: 2026-09-11\n",
      },
    });
    const result = fixture.run(["--write"]);
    const codes = codesOf(result.out);
    // Three blocks from two classes: two G4 entries naming no line, one G5
    // collision. G7 is not among them and cannot be — see its own test.
    expect(codes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(codes)).toEqual(new Set(["G4", "G5"]));
    for (const block of blocksOf(result.out)) expectBlockShape(block, block.slice(13, 15));
    expect(result.out).toContain(`graph: ${codes.length} disagreements — nothing written.`);
    expect(result.code).toBe(2);
    expect(fs.existsSync(fixture.graphFile)).toBe(false);
  });
});

// ── 26. --no-record ──────────────────────────────────────────────────────────

describe("--no-record", () => {
  it("builds the static half at the very same version as a full build", () => {
    // The record half must not move the static hash: a run records `version` to
    // say which definitions and which rules it ran under.
    const fixture = makeCheckout("no-record", {
      snapshot: {
        "dtsTodos.jsonl": [
          { _id: "t1", status: "active", category: "email", needs: [] },
          { _id: "t2", status: "active", category: "admin", needs: ["t1"] },
        ],
        "batches.jsonl": [{ _id: "b1", status: "active" }],
      },
    });
    const full = fixture.build();
    const staticOnly = fixture.build({ record: null });
    expect(staticOnly.version).toBe(full.version);
    expect(staticOnly.counts.byNodeKind.todo).toBeUndefined();
    expect(full.counts.byNodeKind.todo).toBe(2);
    expect(staticOnly.graph.generatedFrom.recordSource).toBe("none");
  });
});

// ── 27. --check ──────────────────────────────────────────────────────────────

describe("--check", () => {
  it("exits 0 when the file on disk is what the render produces", () => {
    const fixture = makeCheckout("check-clean");
    fixture.run(["--write"]);
    expect(fixture.run(["--check"]).code).toBe(0);
  });

  it("exits 2 and names the first differing line when it is not", () => {
    const fixture = makeCheckout("check-stale");
    fixture.run(["--write"]);
    const lines = fs.readFileSync(fixture.graphFile, "utf8").split("\n");
    lines[1] = '  "version": "0000000000000000",';
    fixture.write(GRAPH_PATH, lines.join("\n"));
    const result = fixture.run(["--check"]);
    expect(result.code).toBe(2);
    const block = onlyBlock(result, "G8");
    expect(block).toContain("@@ line 2 @@");
    expect(block).toContain('-  "version": "0000000000000000",');
  });

  it("exits 2 and says so when the file is absent", () => {
    const fixture = makeCheckout("check-absent");
    const result = fixture.run(["--check"]);
    expect(result.code).toBe(2);
    expect(onlyBlock(result, "G8")).toContain("  disk  the file is absent");
  });
});

// ── 28. Switch 2: the record enters as ids only ──────────────────────────────

describe("RECORD_NODES is id-only", () => {
  it("writes kind, id and ref for a record row and no text of any kind", () => {
    expect(RECORD_NODES).toBe("id-only");
    const fixture = makeCheckout("id-only", {
      snapshot: {
        "dtsTodos.jsonl": [
          {
            _id: "t1",
            status: "active",
            category: "email",
            title: "A TITLE THAT MUST NOT BE IN THE FILE",
            groundUpExplanation: "A GROUND UP EXPLANATION THAT MUST NOT BE IN THE FILE",
            statement: "A STATEMENT THAT MUST NOT BE IN THE FILE",
            needs: [],
          },
        ],
        "dtsRulings.jsonl": [{ _id: "r1", todoId: "t1", statement: "ANOTHER STATEMENT" }],
      },
    });
    fixture.build({ write: true });
    const rendered = fs.readFileSync(fixture.graphFile, "utf8");
    const parsed = JSON.parse(rendered);

    const todo = parsed.nodes.find((row) => row.kind === "todo");
    expect(Object.keys(todo).sort()).toEqual(["id", "kind", "ref"]);
    expect(todo).toEqual({ kind: "todo", id: "todo:t1", ref: "dtsTodos/t1" });
    const ruling = parsed.nodes.find((row) => row.kind === "ruling");
    expect(Object.keys(ruling).sort()).toEqual(["id", "kind", "ref"]);

    for (const secret of ["MUST NOT BE IN THE FILE", "ANOTHER STATEMENT", "A TITLE", "groundUpExplanation"]) {
      expect(rendered, secret).not.toContain(secret);
    }
    // The edges the rows state are still there — only the words are gone.
    expect(parsed.edges.some((row) => row.kind === "labeled" && row.from === "ruling:r1")).toBe(true);
  });
});

// ── 29. Switch 3: the five rejections ────────────────────────────────────────

/** A source with its comments removed, so a sentence ABOUT a vector index is not
 * read as one. Block comments first, then whole-line and trailing `//`. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

describe("REJECTS is on: no model, no network, no vector", () => {
  const FORBIDDEN = ["fetch(", "anthropic", "openai", "embedding", "vector"];

  for (const relative of ["scripts/graph.mjs", "worker/jobs/graph.mjs"]) {
    it(`${relative} names none of ${FORBIDDEN.join(", ")} in its code`, () => {
      // An edge whose provenance is a named regex is auditable; one a model
      // wrote is indistinguishable from one nobody read. The comments are
      // stripped first because both files SAY "no vector index" in prose.
      const source = code(fs.readFileSync(path.join(REPO, relative), "utf8")).toLowerCase();
      for (const word of FORBIDDEN) expect(source, `${relative}: ${word}`).not.toContain(word);
    });
  }

  it("declares the switch on", () => {
    expect(REJECTS).toBe("on");
  });
});

// ── 30. The skill bodies ─────────────────────────────────────────────────────

describe("every skill's subgraph renders what buildSkills publishes", () => {
  it("is byte-identical, skill by skill, over the fixture checkout", () => {
    // §11.3's proof: a skill's body IS the rendering of the subgraph under its
    // node, which is why a skill can be a node at all.
    const result = makeCheckout("skill-bodies").build();
    const bodies = skillBodies(result);
    expect(bodies.map((row) => row.name)).toEqual([
      "write",
      "know-intent",
      "know-week",
      "know-admin",
      "repo-tom.quest",
    ]);
    for (const { name, published, rendered } of bodies) {
      expect(rendered, name).toBe(published);
      expect(rendered.length, name).toBeGreaterThan(0);
    }
  });

  it("keeps the repository's rules out of every WikiTom skill", () => {
    // `pageKey` is what tells `tom.quest/AGENTS.md` from any other AGENTS.md.
    const result = makeCheckout("skill-bodies-repo").build();
    const bodies = Object.fromEntries(skillBodies(result).map((row) => [row.name, row.rendered]));
    expect(bodies["repo-tom.quest"]).toContain("Commit with a full message before every stop.");
    expect(bodies.write).not.toContain("Commit with a full message");
    expect(bodies["know-admin"]).not.toContain("Commit with a full message");
  });
});
