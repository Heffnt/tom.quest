// scripts/check-vocabulary.mjs, run against a fixture repository.
//
// Each case writes a small tree that PASSES all six in-repo checks, breaks one
// thing in it, and asserts the named failure. The tree is a fixture rather than
// this repository because a guardrail whose test can only run where the thing it
// guards is already correct proves nothing on the day it is not.
//
// Checks 7 and 8 and the two render checks went to the Jarvis repository with
// the graph's and the vocabulary's generators, and their cases with them.
//
// The refused words appear in this file, in the case that witnesses check 4;
// it lies under scripts/, which check 4 does not scan, and check 3 exempts it
// by name.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EDGE_KINDS, NODE_KINDS } from "../shared/graph.mjs";
import { tempDir } from "../test/temp.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-vocabulary.mjs");
const PASS_LINE = "check-vocabulary: the 6 in-repo checks passed; the render checks run in the nightly";
const VERSION = "0123456789abcdef";

const list = (values) => values.map((value) => `  ${JSON.stringify(value)},`).join("\n");

/** The generated block, in the shape scripts/vocabulary.mjs renderSharedBlock
 * writes it: ONE block carrying the version, the term names and the graph's two
 * closed kind lists. */
function sharedBlock({ version = VERSION, nodeKinds = NODE_KINDS, edgeKinds = EDGE_KINDS } = {}) {
  return [
    `// <vocabulary generated version=${version} — scripts/vocabulary.mjs; do not edit>`,
    "export const TTS_CLOSED_VOCABULARY = `The vocabulary, which is closed — these words mean exactly this and nothing else:",
    "- A BATCH holds how a set of todos gets completed.`;",
    `export const VOCABULARY_VERSION = ${JSON.stringify(version)};`,
    "export const VOCABULARY_TERMS: readonly string[] = [",
    list(["batch", "todo"]),
    "];",
    "export const GRAPH_NODE_KINDS: readonly string[] = [",
    list([...nodeKinds]),
    "];",
    "export const GRAPH_EDGE_KINDS: readonly string[] = [",
    list([...edgeKinds]),
    "];",
    "// </vocabulary generated>",
  ].join("\n");
}

/** A tree that passes all six. `files` replaces or adds paths on top of it. */
function fixture(files = {}) {
  const dir = tempDir("check-vocabulary-");
  const base = {
    "package.json": `${JSON.stringify({ name: "fixture", dependencies: { convex: "^1" } }, null, 2)}\n`,
    "convex/ttsShared.ts": `export const DAY_MS = 86_400_000;\n${sharedBlock()}\n`,
    "convex/ttsEvals.ts": "export const key = commitKey(args.repo, args.sha);\n",
    // The import line names defineTable too and is not a table, which is why the
    // script counts `defineTable(` and not the word.
    "convex/schema.ts":
      'import { defineSchema, defineTable } from "convex/server";\n'
      + `${Array.from({ length: 44 }, (_, i) => `  table${i}: defineTable({}),`).join("\n")}\n`,
    "shared/skill-router.mjs": "export const CONTEXT_CALLERS = Object.freeze({ opener: {} });\n",
    "app/page.tsx": "export default function Page() { return null; }\n",
    "vqc/todos.ts": "export const TODOS = [];\n",
    ...files,
  };
  for (const [relative, body] of Object.entries(base)) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return dir;
}

/** The script, run in `dir`. */
function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("check-vocabulary", () => {
  it("passes on a clean tree and prints the pass line", () => {
    const result = run(fixture());
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(PASS_LINE);
  });

  it("1: names a missing closing marker", () => {
    const shared = `export const DAY_MS = 1;\n${sharedBlock()}\n`.replace("// </vocabulary generated>\n", "");
    const result = run(fixture({ "convex/ttsShared.ts": shared }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("convex/ttsShared.ts: 0 `// </vocabulary generated>` marker(s), expected exactly 1");
  });

  it("1: names a second opening marker", () => {
    const result = run(fixture({ "convex/ttsShared.ts": `${sharedBlock()}\n${sharedBlock()}\n` }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("2 opening `<vocabulary generated …>` marker(s), expected exactly 1");
  });

  it("2: names the two versions when the marker and the constant disagree", () => {
    const shared = sharedBlock().replace(
      `export const VOCABULARY_VERSION = "${VERSION}";`,
      'export const VOCABULARY_VERSION = "0123456789abcdee";',
    );
    const result = run(fixture({ "convex/ttsShared.ts": `${shared}\n` }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `the marker says version=${VERSION} and the block says VOCABULARY_VERSION = "0123456789abcdee"`,
    );
  });

  it("2: names a version that is not 16 lowercase hex", () => {
    const result = run(fixture({ "convex/ttsShared.ts": `${sharedBlock({ version: "0123456789ABCDEF" })}\n` }));
    expect(result.code).toBe(1);
    // The marker pattern takes lowercase hex only, so an uppercase one is not a
    // marker at all — the failure is the opening marker's shape.
    expect(result.stderr).toContain("the opening marker is not");
  });

  it("3: names a second copy of the closed vocabulary's sentence", () => {
    const result = run(
      fixture({
        "scripts/prompt.mjs":
          'export const PROMPT = "The vocabulary, which is closed — these words mean exactly this and nothing else:";\n',
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("scripts/prompt.mjs:1:");
    expect(result.stderr).toContain("outside the generated block in convex/ttsShared.ts");
  });

  it("4: names a refused word, in a comment as much as in code", () => {
    const result = run(
      fixture({
        "app/notes.ts": "// the ontology of a run\nexport const NOTES = [];\n",
        "vqc/store.ts": 'export const KIND = "knowledge graph";\n',
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('app/notes.ts:1: "ontology" is a refused word');
    expect(result.stderr).toContain('vqc/store.ts:1: "knowledge graph" is a refused word');
  });

  it("5: names an inline evals commit key", () => {
    const result = run(
      fixture({ "convex/ttsEvals.ts": "export const key = `${args.repo}@${args.sha}`;\n" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("convex/ttsEvals.ts:1: the commit key `${args.repo}@${args.sha}` is written inline");
  });

  it("6: names a kind list that is not what the graph mints", () => {
    const result = run(
      fixture({ "convex/ttsShared.ts": `${sharedBlock({ edgeKinds: EDGE_KINDS.slice(1) })}\n` }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("convex/ttsShared.ts: GRAPH_EDGE_KINDS is [");
    expect(result.stderr).toContain("shared/graph.mjs mints [");
  });

  it("6: names a missing kind list", () => {
    const shared = sharedBlock().replace("export const GRAPH_NODE_KINDS", "export const OTHER_KINDS");
    const result = run(fixture({ "convex/ttsShared.ts": `${shared}\n` }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "the generated block declares no `export const GRAPH_NODE_KINDS: readonly string[]`",
    );
  });

  // THE TABLE-COUNT AND CONTEXT_CALLERS TESTS WENT WITH THEIR CHECKS. The first
  // pinned convex/schema.ts at 44 tables, which failed every later branch that
  // added one for any reason; the second asserted a single CONTEXT_CALLERS
  // declaration that nothing parses and that was never duplicated. See the
  // block in scripts/check-vocabulary.mjs where they used to be.

  it("exempts this script and its test from the word checks", () => {
    // The fixture's own copy of the script's name carries both refused words and
    // the closed sentence, and is not reported.
    const text = `// ontology, knowledge graph, these words mean exactly this and nothing else\n`;
    const result = run(
      fixture({ "scripts/check-vocabulary.mjs": text, "scripts/check-vocabulary.test.mjs": text }),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("reads the whole script as one file", () => {
    // A guard on the two exempt names: they are spelled in the script, and a
    // rename that left one behind would quietly exempt nothing.
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain('"scripts/check-vocabulary.mjs"');
    expect(source).toContain('"scripts/check-vocabulary.test.mjs"');
  });
});
