// worker-env.test.mjs — the two published-version readers.
//
// THE WHOLE POINT OF THESE TESTS IS THAT NOTHING THROWS. `graphVersion()` and
// `vocabularyVersion()` are stamps on a run row, not preconditions of the run:
// a launcher on a machine with no WikiTom checkout, or one whose nightly wrote
// a half file, must still launch and simply not name a version. Every failure
// mode below is a real one seen on a laptop or a fresh box.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { graphVersion, vocabularyVersion } from "./worker-env.mjs";

const original = process.env.WIKITOM_DIR;
const made = [];

/** A WikiTom directory whose tts/ holds exactly the given file bodies. The
 * cache inside worker-env.mjs is keyed on the resolved PATH, so each case gets
 * a fresh directory and therefore a fresh read. */
function wikitom(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-env-wikitom-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "tts"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, "tts", name), body);
  process.env.WIKITOM_DIR = dir;
  return dir;
}

afterEach(() => {
  if (original === undefined) delete process.env.WIKITOM_DIR;
  else process.env.WIKITOM_DIR = original;
});

describe("published versions", () => {
  it("reads the version out of each file", () => {
    wikitom({
      "graph.json": JSON.stringify({ version: "0123456789abcdef", nodes: [] }),
      "vocabulary.json": JSON.stringify({ version: "vocab-1", terms: [] }),
    });
    expect(graphVersion()).toBe("0123456789abcdef");
    expect(vocabularyVersion()).toBe("vocab-1");
  });

  it("answers null for a missing file rather than throwing", () => {
    wikitom({}); // a checkout with no tts/graph.json and no tts/vocabulary.json
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("answers null for a missing directory entirely", () => {
    const dir = wikitom({});
    process.env.WIKITOM_DIR = path.join(dir, "no-such-checkout");
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("answers null for an empty file", () => {
    wikitom({ "graph.json": "", "vocabulary.json": "" });
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("answers null for malformed JSON", () => {
    wikitom({ "graph.json": "{ not json", "vocabulary.json": "[1, 2," });
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("answers null for well-formed JSON with no usable version", () => {
    // A truncated nightly write and a pre-version file both land here. An
    // empty string is not a version either — it would name a graph nobody can
    // find, which is worse than saying nothing.
    wikitom({ "graph.json": JSON.stringify({ nodes: [] }), "vocabulary.json": JSON.stringify({ version: "" }) });
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("answers null for a JSON document that is not an object", () => {
    wikitom({ "graph.json": "null", "vocabulary.json": "\"vocab-1\"" });
    expect(graphVersion()).toBeNull();
    expect(vocabularyVersion()).toBeNull();
  });

  it("caches per resolved path, so a second call does not re-read the file", () => {
    const dir = wikitom({ "graph.json": JSON.stringify({ version: "first" }) });
    expect(graphVersion()).toBe("first");
    fs.writeFileSync(path.join(dir, "tts", "graph.json"), JSON.stringify({ version: "second" }));
    expect(graphVersion()).toBe("first");
  });
});
