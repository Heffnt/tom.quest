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

import { MAILBOX_MARKER, graphVersion, loadEnv, mailboxNames, setEnvLine } from "./worker-env.mjs";

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

// ── The one writer: setEnvLine, for tom.quest/secrets ───────────────────────
// The session-host daemon writes each value Tom pastes on the /secrets page
// through this. What must hold: the file is replaced whole (a reader never
// sees half of it), it stays owner-only, a name has exactly one line, a name
// already in the file keeps its place, and a new name lands below the marker
// that keeps it out of every agent's environment.
describe("setEnvLine", () => {
  const posix = process.platform !== "win32";

  function envFile(body, mode = 0o600) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-env-write-"));
    made.push(dir);
    const file = path.join(dir, "worker.env");
    if (body !== null) fs.writeFileSync(file, body, { mode });
    if (body !== null && posix) fs.chmodSync(file, mode);
    return file;
  }

  afterEach(() => {
    while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
  });

  it("adds a new name below the marker, and reads back through loadEnv", () => {
    const file = envFile("CONVEX_SITE_URL=https://x.convex.site\nTTS_WORKER_KEY=k\n");
    expect(setEnvLine({ path: file, name: "HF_TOKEN", value: "hf_abc" })).toEqual({ placed: "added" });
    expect(fs.readFileSync(file, "utf8")).toBe(
      `CONVEX_SITE_URL=https://x.convex.site\nTTS_WORKER_KEY=k\n\n${MAILBOX_MARKER}\nHF_TOKEN=hf_abc\n`,
    );
    expect(loadEnv({ path: file }).HF_TOKEN).toBe("hf_abc");
    expect(mailboxNames({ path: file })).toEqual(["HF_TOKEN"]);
  });

  it("replaces a name's line instead of adding a second one", () => {
    const file = envFile("A=1\n");
    setEnvLine({ path: file, name: "HF_TOKEN", value: "old" });
    setEnvLine({ path: file, name: "HF_TOKEN", value: "new" });
    const text = fs.readFileSync(file, "utf8");
    expect(text.match(/^HF_TOKEN=/gm)).toHaveLength(1);
    expect(text.split(MAILBOX_MARKER)).toHaveLength(2); // one marker
    expect(loadEnv({ path: file }).HF_TOKEN).toBe("new");
  });

  it("replaces a name already above the marker in place, so its policy stays", () => {
    const file = envFile("# comment\nexport GH_TOKEN=old\nOTHER=1\nGH_TOKEN=dup\n");
    expect(setEnvLine({ path: file, name: "GH_TOKEN", value: "new" })).toEqual({ placed: "replaced" });
    expect(fs.readFileSync(file, "utf8")).toBe("# comment\nGH_TOKEN=new\nOTHER=1\n");
    expect(mailboxNames({ path: file })).toEqual([]);
  });

  it.skipIf(!posix)("leaves the file mode 0600, even over a file that was wider", () => {
    const file = envFile("A=1\n", 0o644);
    setEnvLine({ path: file, name: "HF_TOKEN", value: "v" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("writes a new file and renames it over the old, leaving no temporary behind", () => {
    const file = envFile("A=1\n");
    const before = fs.statSync(file).ino;
    setEnvLine({ path: file, name: "HF_TOKEN", value: "v" });
    expect(fs.statSync(file).ino).not.toBe(before); // a rename, not an in-place write
    expect(fs.readdirSync(path.dirname(file))).toEqual(["worker.env"]);
  });

  it("leaves the old file whole when the new one cannot be written", () => {
    const file = envFile("A=1\n");
    // Something the temporary's path cannot be removed from or created over.
    fs.mkdirSync(`${file}.tmp-${process.pid}`);
    fs.writeFileSync(path.join(`${file}.tmp-${process.pid}`, "x"), "");
    expect(() => setEnvLine({ path: file, name: "HF_TOKEN", value: "v" })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
  });

  it("refuses a value with a line break, naming the variable and not the value", () => {
    const file = envFile("A=1\n");
    let message = "";
    try {
      setEnvLine({ path: file, name: "HF_TOKEN", value: "secret-part\nEVIL=1" });
    } catch (err) {
      message = String(err.message);
    }
    expect(message).toMatch(/HF_TOKEN contains a line break/);
    expect(message).not.toContain("secret-part");
    expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
  });

  it("finds no mailbox names in a file without the marker or with no file at all", () => {
    expect(mailboxNames({ path: envFile("A=1\n") })).toEqual([]);
    expect(mailboxNames({ path: envFile(null) })).toEqual([]);
  });
});
