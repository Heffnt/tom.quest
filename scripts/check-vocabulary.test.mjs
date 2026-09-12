// scripts/check-vocabulary.mjs, run against a fixture repository.
//
// Each case writes a small tree that PASSES all nine in-repo checks, breaks one
// thing in it, and asserts the named failure. The tree is a fixture rather than
// this repository because a guardrail whose test can only run where the thing it
// guards is already correct proves nothing on the day it is not.
//
// EVERY CASE RESOLVES NO WikiTom CHECKOUT (WIKITOM_DIR points at a path that is
// not there), so the two render checks never run: they shell out to the two
// generators, which read a vault this test has no business needing.
//
// The refused words appear in this file, in the case that witnesses check 4;
// that is why it is one of the two files the script exempts by name.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EDGE_KINDS, NODE_KINDS } from "../worker/jobs/graph.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-vocabulary.mjs");
const NO_CHECKOUT_LINE =
  "check-vocabulary: no WikiTom checkout — ran the 9 in-repo checks; the render checks run in the nightly";
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

/** A tree that passes all nine. `files` replaces or adds paths on top of it. */
function fixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-vocabulary-"));
  const base = {
    "package.json": `${JSON.stringify({ name: "fixture", dependencies: { convex: "^1" } }, null, 2)}\n`,
    "convex/ttsShared.ts": `export const DAY_MS = 86_400_000;\n${sharedBlock()}\n`,
    "convex/ttsEvals.ts": "export const key = commitKey(args.repo, args.sha);\n",
    // The import line names defineTable too and is not a table, which is why the
    // script counts `defineTable(` and not the word.
    "convex/schema.ts":
      'import { defineSchema, defineTable } from "convex/server";\n'
      + `${Array.from({ length: 44 }, (_, i) => `  table${i}: defineTable({}),`).join("\n")}\n`,
    "worker/jobs/skill-router.mjs": "export const CONTEXT_CALLERS = Object.freeze({ opener: {} });\n",
    "worker/jobs/graph.mjs": "// no model, no network, no embedding and no vector.\nexport const NODES = [];\n",
    "scripts/graph.mjs": "// the graph's generator.\nexport function generateGraph() {}\n",
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

/** The script, run in `dir` with no WikiTom checkout to resolve. */
function run(dir) {
  const env = { ...process.env, WIKITOM_DIR: join(dir, "no-such-wikitom") };
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("check-vocabulary", () => {
  it("passes on a clean tree and prints the no-checkout line", () => {
    const result = run(fixture());
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(NO_CHECKOUT_LINE);
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
        "worker/jobs/prompt.mjs":
          'export const PROMPT = "The vocabulary, which is closed — these words mean exactly this and nothing else:";\n',
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("worker/jobs/prompt.mjs:1:");
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
    expect(result.stderr).toContain("worker/jobs/graph.mjs mints [");
  });

  it("6: names a missing kind list", () => {
    const shared = sharedBlock().replace("export const GRAPH_NODE_KINDS", "export const OTHER_KINDS");
    const result = run(fixture({ "convex/ttsShared.ts": `${shared}\n` }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "the generated block declares no `export const GRAPH_NODE_KINDS: readonly string[]`",
    );
  });

  it("7: names a network call in the graph's generator", () => {
    const result = run(
      fixture({ "scripts/graph.mjs": "export async function go() { return fetch(url); }\n" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('scripts/graph.mjs:1: "fetch(" in code');
  });

  it("7: reads the prose that names the same words as prose", () => {
    // The header of worker/jobs/graph.mjs says it holds no embedding and no
    // vector. The check strips comments, so that sentence is not a breach.
    const result = run(
      fixture({
        "worker/jobs/graph.mjs": "// no embedding, no vector, no cosine, no faiss, no openai, no anthropic.\nexport const X = 1;\n",
      }),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("7: names an embedding dependency", () => {
    const result = run(
      fixture({
        "package.json": `${JSON.stringify({ name: "fixture", dependencies: { "faiss-node": "^1" } }, null, 2)}\n`,
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('package.json depends on "faiss-node"');
  });

  it("8: names a schema that gained a table", () => {
    const schema =
      'import { defineSchema, defineTable } from "convex/server";\n'
      + `${Array.from({ length: 45 }, (_, i) => `  table${i}: defineTable({}),`).join("\n")}\n`;
    const result = run(fixture({ "convex/schema.ts": schema }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("convex/schema.ts defines 45 tables and this check expects 44");
  });

  it("9: names a second CONTEXT_CALLERS", () => {
    const result = run(
      fixture({ "convex/ttsContext.ts": "const CONTEXT_CALLERS = { opener: {} };\nexport default CONTEXT_CALLERS;\n" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CONTEXT_CALLERS is declared 2 time(s) across worker/ and convex/");
    expect(result.stderr).toContain("convex/ttsContext.ts:1");
  });

  it("9: names a CONTEXT_CALLERS nobody declares", () => {
    const result = run(fixture({ "worker/jobs/skill-router.mjs": "export const CALLERS = {};\n" }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CONTEXT_CALLERS is declared 0 time(s) across worker/ and convex/ (nowhere)");
  });

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
