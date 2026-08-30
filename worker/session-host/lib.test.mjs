// The scrub that keeps the Jarvis Box's secrets out of the processes a model
// steers. This is the regression test for a specific failure: systemd starts
// the session-host with EnvironmentFile=/etc/tts/worker.env, so EVERY key in
// that file — including Tom's tom.quest password (TOMQUEST_AGENT_PASSWORD,
// ratified 2026-08-30) — is in this daemon's own environment. If any of them
// reaches a session's shell, one `env` in one Bash call copies it into a
// transcript row that is stored in Convex, which is the exact outcome the
// ruling avoided by having the password typed on the box by hand.

import { describe, expect, it } from "vitest";
import { SESSION_SCRUBBED_KEYS, scrubbedEnv } from "./lib.mjs";

const DAEMON_ENV = {
  PATH: "/usr/bin",
  HOME: "/root",
  CLAUDE_CONFIG_DIR: "/root/.claude-accounts/active",
  CONVEX_SITE_URL: "https://example.convex.site",
  TTS_WORKER_KEY: "tts-key",
  SESSIONS_WORKER_KEY: "ingest-key",
  GH_TOKEN: "gh-token",
  TOMQUEST_AGENT_USERNAME: "tom",
  TOMQUEST_AGENT_PASSWORD: "hunter2",
};

describe("scrubbedEnv", () => {
  it("drops every scrubbed key", () => {
    const env = scrubbedEnv(DAEMON_ENV);
    for (const key of SESSION_SCRUBBED_KEYS) {
      expect(env, `${key} reached a model-reachable process`).not.toHaveProperty(key);
    }
  });

  it("names the browse credentials among the scrubbed keys", () => {
    // Spelled out rather than derived: this list is the security boundary, and
    // a future edit that quietly drops one of these names should fail here.
    expect(SESSION_SCRUBBED_KEYS).toEqual(
      expect.arrayContaining([
        "SESSIONS_WORKER_KEY",
        "GH_TOKEN",
        "TOMQUEST_AGENT_USERNAME",
        "TOMQUEST_AGENT_PASSWORD",
      ]),
    );
  });

  it("keeps everything a session legitimately needs", () => {
    const env = scrubbedEnv(DAEMON_ENV);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    // The CLI authenticates through this; scrubbing it would sign the
    // classifier's own `claude` call out.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/root/.claude-accounts/active");
    // The pens are key-authed curls the session makes itself.
    expect(env.CONVEX_SITE_URL).toBe("https://example.convex.site");
    expect(env.TTS_WORKER_KEY).toBe("tts-key");
  });

  it("drops the extra names a caller passes", () => {
    // The Bash classifier's own child gets no pen, so its worker key goes too.
    const env = scrubbedEnv(DAEMON_ENV, ["TTS_WORKER_KEY"]);
    expect(env).not.toHaveProperty("TTS_WORKER_KEY");
    expect(env.CONVEX_SITE_URL).toBe("https://example.convex.site");
  });

  it("does not mutate the environment it was given", () => {
    const source = { ...DAEMON_ENV };
    scrubbedEnv(source);
    expect(source).toEqual(DAEMON_ENV);
  });
});
