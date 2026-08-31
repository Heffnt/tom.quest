// Regression test for the one invariant that decides what a TTS session can
// reach: which secrets reach a model-steerable process.
//
// This is worth a test rather than a comment because the failure is silent and
// permanent. A session's shell output is ingested as a transcript row and
// stored in Convex, so if a credential leaks back into the inherited env,
// nothing breaks, no error is raised, and the first evidence is the secret
// sitting in a stored transcript — by which time rotating it is the only fix.
//
// Witness: delete any name from SCRUBBED_SECRETS in lib.mjs, or make
// scrubbedEnv() return process.env unchanged, and these go red.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scrubbedEnv } from "./lib.mjs";

// Every secret worker.env holds that must never be printable from a session.
// Mirrors worker/worker.env.example; a name added there and not here is the
// drift this test is meant to catch.
const MUST_BE_SCRUBBED = [
  "SESSIONS_WORKER_KEY",
  "GH_TOKEN",
  "TOMQUEST_AGENT_USERNAME",
  "TOMQUEST_AGENT_PASSWORD",
  "TURING_API_KEY",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
];

// Names a session legitimately needs in its environment.
const MUST_SURVIVE = ["PATH", "HOME", "CONVEX_SITE_URL", "CLAUDE_CONFIG_DIR"];

const injected = [];

function setEnv(name, value) {
  injected.push([name, process.env[name]]);
  process.env[name] = value;
}

beforeEach(() => {
  for (const name of MUST_BE_SCRUBBED) setEnv(name, `secret-value-of-${name}`);
  for (const name of MUST_SURVIVE) setEnv(name, `ordinary-${name}`);
});

afterEach(() => {
  for (const [name, previous] of injected.reverse()) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  injected.length = 0;
});

describe("scrubbedEnv", () => {
  it("drops every secret a session must not be able to print", () => {
    const env = scrubbedEnv();
    for (const name of MUST_BE_SCRUBBED) {
      expect(env, `${name} must not reach a session's shell`).not.toHaveProperty(name);
    }
  });

  it("leaks no scrubbed VALUE under any other key", () => {
    // A rename ("VERCEL_TOKEN" copied to "VC_TOKEN" for convenience) would pass
    // the key check above while leaving the secret just as printable.
    const values = Object.values(scrubbedEnv());
    for (const name of MUST_BE_SCRUBBED) {
      expect(values, `the value of ${name} must not survive under another name`).not.toContain(
        `secret-value-of-${name}`,
      );
    }
  });

  it("keeps the ordinary environment a session needs to work", () => {
    const env = scrubbedEnv();
    for (const name of MUST_SURVIVE) {
      expect(env[name]).toBe(`ordinary-${name}`);
    }
  });

  it("drops extra names the caller asks for, on top of the standing list", () => {
    // The Bash classifier passes TTS_WORKER_KEY here: the SDK child needs that
    // pen, a model-steerable classifier never does.
    setEnv("TTS_WORKER_KEY", "pen-key");
    const env = scrubbedEnv(["TTS_WORKER_KEY"]);
    expect(env).not.toHaveProperty("TTS_WORKER_KEY");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env.PATH).toBe("ordinary-PATH");
  });

  it("does not mutate process.env", () => {
    scrubbedEnv();
    expect(process.env.GH_TOKEN).toBe("secret-value-of-GH_TOKEN");
  });

  it("returns a fresh object each call, so callers cannot alias it", () => {
    const a = scrubbedEnv();
    const b = scrubbedEnv();
    expect(a).not.toBe(b);
    a.PATH = "tampered";
    expect(scrubbedEnv().PATH).toBe("ordinary-PATH");
  });
});
