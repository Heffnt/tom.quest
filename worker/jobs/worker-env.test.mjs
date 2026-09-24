// worker-env.test.mjs — the published-version reader.
//
// THE WHOLE POINT OF THESE TESTS IS THAT NOTHING THROWS. `graphVersion()` is a
// stamp on a run row, not a precondition of the run: a launcher on a machine
// with no WikiTom checkout, or one whose nightly wrote a half file, must still
// launch and simply not name a version. Every failure mode below is a real one
// seen on a laptop or a fresh box.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/temp.mjs";

import { spawnSync } from "node:child_process";

import {
  MAILBOX_BEGIN,
  MAILBOX_END,
  graphVersion,
  loadEnv,
  mailboxNames,
  openrouterKeyProblem,
  setEnvLine,
} from "./worker-env.mjs";

const original = process.env.WIKITOM_DIR;
/** A WikiTom directory whose tts/ holds exactly the given file bodies. Each
 * case gets a fresh directory so that the case before it cannot be what a
 * reader sees; worker-env.mjs holds no cache to defeat, it reads the file on
 * every call. */
function wikitom(files) {
  const dir = tempDir("worker-env-wikitom-");
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
// already in the file keeps its place, and a new name lands in the block
// that keeps it out of every agent's environment.
describe("setEnvLine", () => {
  const posix = process.platform !== "win32";

  function envFile(body, mode = 0o600) {
    const dir = tempDir("worker-env-write-");
    const file = path.join(dir, "worker.env");
    if (body !== null) fs.writeFileSync(file, body, { mode });
    if (body !== null && posix) fs.chmodSync(file, mode);
    return file;
  }


  it("adds a new name to the mailbox block, and reads back through loadEnv", () => {
    const file = envFile("CONVEX_SITE_URL=https://x.convex.site\nTTS_WORKER_KEY=k\n");
    expect(setEnvLine({ path: file, name: "HF_TOKEN", value: "hf_abc" })).toEqual({ placed: "added" });
    expect(fs.readFileSync(file, "utf8")).toBe(
      `CONVEX_SITE_URL=https://x.convex.site\nTTS_WORKER_KEY=k\n\n${MAILBOX_BEGIN}\nHF_TOKEN=hf_abc\n${MAILBOX_END}\n`,
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
    expect(text.split(MAILBOX_BEGIN)).toHaveLength(2); // one block
    expect(loadEnv({ path: file }).HF_TOKEN).toBe("new");
  });

  it("replaces a name already outside the block in place, so its policy stays", () => {
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

  it("puts a second name inside the block, and a line appended by hand after it stays outside", () => {
    const file = envFile("A=1\n");
    setEnvLine({ path: file, name: "HF_TOKEN", value: "v1" });
    fs.appendFileSync(file, "OPENROUTER_API_KEY=by-hand\n");
    setEnvLine({ path: file, name: "WANDB_API_KEY", value: "v2" });
    expect(fs.readFileSync(file, "utf8")).toBe(
      `A=1\n\n${MAILBOX_BEGIN}\nHF_TOKEN=v1\nWANDB_API_KEY=v2\n${MAILBOX_END}\nOPENROUTER_API_KEY=by-hand\n`,
    );
    expect(mailboxNames({ path: file })).toEqual(["HF_TOKEN", "WANDB_API_KEY"]);
  });

  it("reads a block whose end line was removed by hand to the end of the file, and closes it on the next write", () => {
    const file = envFile(`A=1\n${MAILBOX_BEGIN}\nHF_TOKEN=v1\nLATER=by-hand\n`);
    expect(mailboxNames({ path: file })).toEqual(["HF_TOKEN", "LATER"]);
    setEnvLine({ path: file, name: "WANDB_API_KEY", value: "v2" });
    expect(fs.readFileSync(file, "utf8")).toBe(
      `A=1\n${MAILBOX_BEGIN}\nHF_TOKEN=v1\nLATER=by-hand\nWANDB_API_KEY=v2\n${MAILBOX_END}\n`,
    );
    expect(mailboxNames({ path: file })).toEqual(["HF_TOKEN", "LATER", "WANDB_API_KEY"]);
  });

  it("finds no mailbox names in a file without the block or with no file at all", () => {
    expect(mailboxNames({ path: envFile("A=1\n") })).toEqual([]);
    expect(mailboxNames({ path: envFile(null) })).toEqual([]);
  });
});

// The rule a clean OPENROUTER_API_KEY meets, and the two shell pieces of
// worker/setup.sh that lean on it. The rollout's warning runs the node snippet
// below verbatim, so it cannot judge a value differently from
// scripts/codex-run.mjs; the printed repair must fix every line form that
// warning reads, or it would print a command that changes nothing.
const KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

describe("openrouterKeyProblem", () => {
  it("passes a printable key with the sk-or- prefix", () => {
    expect(openrouterKeyProblem(KEY)).toBeNull();
  });

  it("names the classes of characters outside printable ASCII", () => {
    expect(openrouterKeyProblem(`\u001b[200~${KEY}\u001b[201~`)).toBe("2 character(s) outside printable ASCII (2 control, 0 space, 0 non-ASCII) and 6 character(s) before its sk-or- prefix and 2 punctuation character(s) after its sk-or- prefix");
    expect(openrouterKeyProblem("sk-or-v1 \tx")).toBe("2 character(s) outside printable ASCII (1 control, 1 space, 0 non-ASCII)");
    expect(openrouterKeyProblem(`${KEY}\u00a0`)).toBe("1 character(s) outside printable ASCII (0 control, 0 space, 1 non-ASCII)");
  });

  // witness: the 2026-09-24 box key, printable throughout, with the tail of a
  // paste marker in front of it. OpenRouter answered every run "401 Missing
  // Authentication header" while Codex sent the header each time.
  it("refuses printable characters before the prefix, and a value with no prefix", () => {
    expect(openrouterKeyProblem(`200~${KEY}`)).toBe("4 character(s) before its sk-or- prefix");
    expect(openrouterKeyProblem("abc")).toBe("no sk-or- prefix");
    expect(openrouterKeyProblem(`${KEY}201~`)).toBe("1 punctuation character(s) after its sk-or- prefix");
  });

  it("never names a character of the key", () => {
    expect(openrouterKeyProblem("secret-value\u0007")).not.toContain("secret");
    expect(openrouterKeyProblem("zz~sk-or-secret")).not.toContain("secret");
  });
});

describe.skipIf(process.platform === "win32")("setup.sh's OpenRouter key warning and repair", () => {
  const setup = fs.readFileSync(path.resolve("worker/setup.sh"), "utf8");
  const snippet = setup.match(/node --input-type=module -e '([\s\S]*?)' "\$WORKER_DIR\/jobs\/worker-env\.mjs"/)[1];
  const repair = setup.match(/echo "    (LC_ALL=C sed -i -E '[^']*') \/etc\/tts\/worker\.env"/)[1].replace(/\\\\/g, "\\");
  const envFile = (body) => {
    const dir = tempDir("worker-env-key-");
    const file = path.join(dir, "worker.env");
    fs.writeFileSync(file, body);
    return file;
  };
  const warning = (file) => spawnSync(process.execPath, [
    "--input-type=module", "-e", snippet, path.resolve("worker/jobs/worker-env.mjs"), file,
  ], { encoding: "utf8" }).stdout;

  it("warns by the same rule the run applies", () => {
    for (const value of [KEY, "sk-or v1", `\u001b[200~${KEY}\u001b[201~`, `sk-or-v1\u00a0${KEY}`, `200~${KEY}`, "abc"]) {
      const file = envFile(`A=1\nOPENROUTER_API_KEY=${value}\nB=2\n`);
      expect(warning(file)).toBe(openrouterKeyProblem(loadEnv({ path: file }).OPENROUTER_API_KEY) ?? "");
    }
    expect(warning(envFile(`OPENROUTER_API_KEY=${KEY}\r\n`))).toBe("");
  });

  // Every way the paste has been seen or can arrive: whole markers, markers
  // missing their ESC, markers missing ESC and bracket (the box's own case),
  // quotes around the value, and a CRLF line end.
  const pasted = [
    `\u001b[200~${KEY}\u001b[201~\r`,
    `[200~${KEY}[201~`,
    `200~${KEY}`,
    `"200~${KEY}"`,
    `'${KEY}201~'`,
  ];
  for (const prefix of ["", "export ", "  ", "  export  "]) {
    for (const value of pasted) {
      it(`repairs ${JSON.stringify(value.replace(KEY, "<key>"))} on a ${JSON.stringify(prefix)} line and leaves the others alone`, () => {
        const file = envFile(`A=1\n${prefix}OPENROUTER_API_KEY=${value}\nB="x y"\n`);
        expect(warning(file)).not.toBe("");
        const fixed = spawnSync("sh", ["-c", `${repair} "$1"`, "sh", file], { encoding: "utf8" });
        expect(fixed.status).toBe(0);
        expect(fs.readFileSync(file, "utf8")).toBe(`A=1\nOPENROUTER_API_KEY=${KEY}\nB="x y"\n`);
        expect(warning(file)).toBe("");
      });
    }
  }
});
