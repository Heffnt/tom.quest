// BASH_DANGER_RE is the tier-2 fingerprint: a command it does not match is
// allowed with no classifier call at all. So a gap in it is not "one weaker
// check" — it is a command that never gets looked at.
//
// The regex is read out of session.mjs as text rather than imported, because
// importing that module pulls in @anthropic-ai/claude-agent-sdk, which only
// exists on the worker box. Same trick scripts/check-session-mirrors.mjs uses.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "worker/session-host/session.mjs"),
  "utf8",
);
const literal = source.match(/const BASH_DANGER_RE =\s*(\/.*\/);/s);
if (!literal) throw new Error("BASH_DANGER_RE literal not found in session.mjs");
const body = literal[1].slice(1, literal[1].lastIndexOf("/"));
const DANGER = new RegExp(body);

describe("tier-2 danger fingerprint", () => {
  // REGRESSION. The daemon clones with the token in the remote URL
  // (ensureWorkdir), so every one of these prints GH_TOKEN — the same secret
  // startQuery scrubs from the session's env. Before 2026-08-30 none of them
  // matched, so they were allowed without even a classifier call, which made
  // the scrub decorative.
  it.each([
    ["git remote get-url origin", "the direct read"],
    ["git remote -v", "the one every developer types"],
    ["git -C /var/cache/tts/sessions/x/tom.quest remote -v", "with a -C prefix"],
    ["git remote --verbose", "long form"],
    ["git config --get remote.origin.url", "via config"],
    ["git config --list", "the whole config, which contains the URL"],
    ["cat .git/config", "straight off disk"],
  ])("fingerprints %j (%s)", (command) => {
    expect(DANGER.test(command)).toBe(true);
  });

  it("still fingerprints a push", () => {
    expect(DANGER.test("git push origin session/abc")).toBe(true);
    expect(DANGER.test("git -C /tmp/x push origin main")).toBe(true);
  });

  // The other half of the contract. Over-matching is not free: every match
  // spawns the classifier CLI, and these are the commands an agentic loop runs
  // constantly.
  it.each([
    "git status --porcelain",
    "git log --oneline -5",
    'git commit -m "tts: rename"',
    'git config user.email "tom@tom.quest"',
    "git checkout -b session/abc",
    "git diff HEAD",
  ])("leaves %j alone", (command) => {
    expect(DANGER.test(command)).toBe(false);
  });

  // tts-open-pr holds the credential so the agent never does. If it tripped
  // the fingerprint every PR would pay a classifier spawn for nothing.
  it("leaves tts-open-pr alone", () => {
    expect(
      DANGER.test('tts-open-pr --title "tts: rename the verdict" --base main'),
    ).toBe(false);
    expect(DANGER.test("tts-open-pr --title x --body-file /tmp/b.md")).toBe(
      false,
    );
  });
});
