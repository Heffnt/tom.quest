// The session constants' one home (shared/session-constants.mjs). The record,
// the site and the box import these tables, so what is asserted here is what
// used to be asserted by comparing their copies: the staleness window is three
// idle polls, the narrow list has its four items, and the usage-cap regex
// reads every cap text seen in the wild while staying quiet on API weather.
import { describe, expect, it } from "vitest";

import {
  DAEMON_STALE_MS,
  LEGACY_SESSION_MODEL,
  NARROW_LIST,
  POLL_IDLE_MS,
  RUNNER_CEILING_DEFAULT,
  SESSION_MODELS,
  SESSION_REPOS,
  USAGE_LIMIT_RE,
} from "../session-constants.mjs";

describe("the session constants", () => {
  it("call the daemon down after three missed idle polls", () => {
    expect(POLL_IDLE_MS).toBe(30_000);
    expect(DAEMON_STALE_MS).toBe(90_000);
  });

  it("hold the four items of the narrow list, each with a decision and a command", () => {
    expect(NARROW_LIST.map((item) => item.id)).toEqual(["money", "message-in-his-name", "irreversible-deletion", "credential"]);
    for (const item of NARROW_LIST) {
      expect(item.decision.length).toBeGreaterThan(0);
      expect(item.command.length).toBeGreaterThan(0);
    }
  });

  it("draw the credential line at where a credential can be held, not at moving it", () => {
    const credential = NARROW_LIST.find((item) => item.id === "credential");
    for (const text of [credential.decision, credential.command]) {
      expect(text).toContain("in a transcript, in the record or in a repository");
      expect(text).not.toMatch(/\bread, print, move\b/);
    }
    expect(credential.command).toContain("moving it between files or processes without printing it is allowed");
  });

  it("read an absent model as a model the table has", () => {
    expect(Object.hasOwn(SESSION_MODELS, LEGACY_SESSION_MODEL)).toBe(true);
    expect(LEGACY_SESSION_MODEL).toBe("opus");
  });

  it("give every repo an owner/name home on GitHub", () => {
    for (const home of Object.values(SESSION_REPOS)) expect(home).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});

describe("USAGE_LIMIT_RE", () => {
  // On 2026-08-30 the CLI's live text matched neither the daemon's regex nor
  // the scheduler's, and the scheduler burned a dozen launches against a wall.
  it.each([
    "You've hit your session limit · resets 8:10am (UTC)",
    "Claude AI usage limit reached",
    "5-hour limit reached",
    // Codex's cap vocabulary (2026-09-04): the app-server protocol's
    // RateLimitReachedType literals and the CLI's prose.
    "usage_limit_reached",
    "rate_limit_reached",
    "You've hit your usage limit. Try again later.",
  ])("reads the observed cap text %j as a cap", (text) => {
    expect(USAGE_LIMIT_RE.test(text)).toBe(true);
  });

  // A 529 or a 429 resolves by itself and must not stand the fleet down for 3h.
  it.each(["overloaded_error", "API rate limit exceeded (429)"])("does not read the transient %j as a cap", (text) => {
    expect(USAGE_LIMIT_RE.test(text)).toBe(false);
  });

  // The box's runner sensor imports this default by name; the record's
  // runners are gone.
  it("give a runner with no ceiling of its own two GPUs, four hours and 128000 MB", () => {
    expect(RUNNER_CEILING_DEFAULT).toEqual({ gpus: 2, minutes: 240, memoryMb: 128000 });
  });
});
