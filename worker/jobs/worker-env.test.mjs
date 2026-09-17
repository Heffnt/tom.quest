// worker-env.test.mjs — the published-version reader.
//
// THE WHOLE POINT OF THESE TESTS IS THAT NOTHING THROWS. `graphVersion()` is a
// stamp on a run row, not a precondition of the run: a launcher on a machine
// with no WikiTom checkout, or one whose nightly wrote a half file, must still
// launch and simply not name a version. Every failure mode below is a real one
// seen on a laptop or a fresh box.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { graphVersion } from "./worker-env.mjs";

const original = process.env.WIKITOM_DIR;
const made = [];

/** A WikiTom directory whose tts/ holds exactly the given file bodies. Each
 * case gets a fresh directory so that the case before it cannot be what a
 * reader sees; worker-env.mjs holds no cache to defeat, it reads the file on
 * every call. */
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

describe("the published graph version", () => {
  it("reads the version out of the file", () => {
    wikitom({ "graph.json": JSON.stringify({ version: "0123456789abcdef", nodes: [] }) });
    expect(graphVersion()).toBe("0123456789abcdef");
  });

  it("answers null for a missing file rather than throwing", () => {
    wikitom({}); // a checkout with no tts/graph.json
    expect(graphVersion()).toBeNull();
  });

  it("answers null for a missing directory entirely", () => {
    const dir = wikitom({});
    process.env.WIKITOM_DIR = path.join(dir, "no-such-checkout");
    expect(graphVersion()).toBeNull();
  });

  it("answers null for an empty file", () => {
    wikitom({ "graph.json": "" });
    expect(graphVersion()).toBeNull();
  });

  it("answers null for malformed JSON", () => {
    wikitom({ "graph.json": "{ not json" });
    expect(graphVersion()).toBeNull();
  });

  it("answers null for well-formed JSON with no usable version", () => {
    // A truncated nightly write and a pre-version file both land here.
    wikitom({ "graph.json": JSON.stringify({ nodes: [] }) });
    expect(graphVersion()).toBeNull();
    // An empty string is not a version either — it would name a graph nobody
    // can find, which is worse than saying nothing.
    wikitom({ "graph.json": JSON.stringify({ version: "" }) });
    expect(graphVersion()).toBeNull();
  });

  it("answers null for a JSON document that is not an object", () => {
    wikitom({ "graph.json": "null" });
    expect(graphVersion()).toBeNull();
    wikitom({ "graph.json": "\"0123456789abcdef\"" });
    expect(graphVersion()).toBeNull();
  });

  // THE OPPOSITE OF WHAT THIS ONCE ASSERTED. It used to pin a per-process cache
  // -- "a second call does not re-read the file" -- and that made the stale
  // answer the required behaviour. One of the three callers is the
  // tts-session-host daemon, which nobody may restart, while the nightly
  // rewrites this file every night: the cache meant every session after the
  // first nightly was stamped with the version of a graph it did not run under.
  it("re-reads the file, so a version written after the first call is the one returned", () => {
    const dir = wikitom({ "graph.json": JSON.stringify({ version: "first" }) });
    expect(graphVersion()).toBe("first");

    fs.writeFileSync(path.join(dir, "tts", "graph.json"), JSON.stringify({ version: "second" }));
    expect(graphVersion()).toBe("second");

    // And a file that goes away answers null rather than the last thing it said
    // -- the null was cached too, in both directions.
    fs.rmSync(path.join(dir, "tts", "graph.json"));
    expect(graphVersion()).toBeNull();

    // Then back again, which a cached null could never do.
    fs.writeFileSync(path.join(dir, "tts", "graph.json"), JSON.stringify({ version: "third" }));
    expect(graphVersion()).toBe("third");
  });
});
