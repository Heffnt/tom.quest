// The env scrub (worker/session-host/env-scrub.mjs): the one secret-name list
// every model-reachable spawn applies. The behavior half imports the module;
// the wiring half reads session.mjs and session-host.mjs as TEXT (they import
// the Agent SDK / the worker-env symlink and cannot be loaded here) to pin
// that every spawn goes through scrubbedEnv and none carries a hand-written
// copy of the list again — the drift this module exists to end.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SCRUBBED_SECRET_NAMES, scrubbedEnv } from "../env-scrub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, "..", name), "utf8");
const sessionSource = read("session.mjs");
const hostSource = read("session-host.mjs");
const libSource = read("lib.mjs");

const SECRETS = [
  "SESSIONS_WORKER_KEY",
  "GH_TOKEN",
  "TOMQUEST_AGENT_USERNAME",
  "TOMQUEST_AGENT_PASSWORD",
  "TURING_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
];

describe("scrubbedEnv", () => {
  const source = Object.fromEntries([
    ...SECRETS.map((name) => [name, `secret-${name}`]),
    ["TTS_WORKER_KEY", "tts"],
    ["TURING_READ_KEY", "read-only"],
    ["PATH", "/usr/bin"],
    ["HOME", "/root"],
    ["CLAUDE_CONFIG_DIR", "/root/.claude-accounts/active"],
  ]);

  for (const name of SECRETS) {
    it(`lists and drops ${name}`, () => {
      expect(SCRUBBED_SECRET_NAMES).toContain(name);
      expect(scrubbedEnv({ source })).not.toHaveProperty(name);
      expect(scrubbedEnv({ source, keepTtsKey: true })).not.toHaveProperty(name);
    });
  }

  it("drops TTS_WORKER_KEY unless asked to keep it", () => {
    expect(scrubbedEnv({ source })).not.toHaveProperty("TTS_WORKER_KEY");
    expect(scrubbedEnv({ source, keepTtsKey: true }).TTS_WORKER_KEY).toBe("tts");
  });

  it("keeps the read-only cluster key and the ordinary process env", () => {
    const out = scrubbedEnv({ source });
    expect(out.TURING_READ_KEY).toBe("read-only");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/root");
    expect(out.CLAUDE_CONFIG_DIR).toBe("/root/.claude-accounts/active");
  });

  it("returns a copy — the daemon's own env is untouched", () => {
    const out = scrubbedEnv({ source });
    out.PATH = "changed";
    expect(source.PATH).toBe("/usr/bin");
    expect(source.GH_TOKEN).toBe("secret-GH_TOKEN");
  });

  it("reads process.env by default", () => {
    process.env.TTS_SCRUB_TEST_PROBE = "1";
    try {
      expect(scrubbedEnv().TTS_SCRUB_TEST_PROBE).toBe("1");
    } finally {
      delete process.env.TTS_SCRUB_TEST_PROBE;
    }
  });
});

describe("wiring: every spawn goes through scrubbedEnv", () => {
  it("lib.mjs re-exports it from env-scrub.mjs", () => {
    expect(libSource).toMatch(/export \{ scrubbedEnv, SCRUBBED_SECRET_NAMES \} from "\.\/env-scrub\.mjs"/);
  });

  it("the session shell keeps ONLY the TTS worker key", () => {
    const startQuery = sessionSource.slice(sessionSource.indexOf("startQuery({ resume } = {})"));
    expect(startQuery.slice(0, 2000)).toMatch(/const inheritedEnv = scrubbedEnv\(\{ keepTtsKey: true \}\)/);
  });

  it("the Bash classifier spawn is scrubbed, TTS key included", () => {
    const classifier = sessionSource.slice(sessionSource.indexOf("async #classifyBash("));
    expect(classifier).toMatch(/env: scrubbedEnv\(\),/);
  });

  it("the daemon's Codex spawns (warm-up, usage read) are scrubbed", () => {
    expect(hostSource).toMatch(/const codexEnv = \(\) => scrubbedEnv\(\);/);
    expect(hostSource).toMatch(/spawnCodex\(args, \{[\s\S]*?env: codexEnv\(\)/);
    expect(hostSource).toMatch(/spawnCodex\(\["app-server"\], \{[\s\S]*?env: codexEnv\(\)/);
  });

  it("no hand-written copy of the list survives in the daemon", () => {
    // A destructure-drop of any secret name (`SESSIONS_WORKER_KEY: _x,`) is
    // the shape every old copy had.
    for (const [name, text] of [["session.mjs", sessionSource], ["session-host.mjs", hostSource]]) {
      for (const secret of SECRETS) {
        expect(text, `${name} destructures ${secret} by hand`).not.toMatch(new RegExp(`${secret}: _\\w+,`));
      }
    }
  });
});
