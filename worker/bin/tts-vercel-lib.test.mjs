// Tests for the pure half of tts-vercel. The CLI half needs a token and a
// network; everything that can be got wrong WITHOUT one is here.
//
// The two that matter most, and would each cost a session a wasted handback:
//   - pickDeployment preferring the FAILED build on a branch over a newer
//     green one, because the failure is the thing being diagnosed;
//   - filterLogEvents keeping the lines BEFORE a failure line, because
//     "Command exited with 1" names no file and the cause sits above it.

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  buildUrl,
  pickDeployment,
  filterLogEvents,
  formatLogEvents,
  formatDeployments,
  deploymentBranch,
  deploymentState,
  READ_PATHS,
  API_ORIGIN,
  CONTEXT_LINES,
} from "./tts-vercel-lib.mjs";

describe("parseArgs", () => {
  it("defaults to status with no arguments", () => {
    expect(parseArgs([]).verb).toBe("status");
  });

  it("reads verbs and flags", () => {
    const o = parseArgs(["log", "--branch", "session/abc", "--all", "--limit", "50"]);
    expect(o).toMatchObject({ verb: "log", branch: "session/abc", all: true, limit: 50 });
  });

  it("rejects an unknown verb rather than silently running status", () => {
    expect(() => parseArgs(["deploy"])).toThrow(/unknown verb deploy/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["log", "--force"])).toThrow(/unknown flag --force/);
  });

  it("rejects a non-positive --limit", () => {
    expect(() => parseArgs(["status", "--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["status", "--limit", "abc"])).toThrow(/positive integer/);
  });

  it("rejects more than one verb", () => {
    expect(() => parseArgs(["status", "log"])).toThrow(/expected one verb/);
  });

  it("has no flag that could carry an HTTP method or a request body", () => {
    // Witness for the read-only claim in the header of tts-vercel: if someone
    // adds --method or --data, this fails and they must revisit that claim.
    for (const flag of ["--method", "--data", "--body", "-X", "-d"]) {
      expect(() => parseArgs(["status", flag, "POST"])).toThrow();
    }
  });
});

describe("buildUrl", () => {
  it("builds an absolute api.vercel.com URL", () => {
    expect(buildUrl(READ_PATHS.deployments, { limit: 10 })).toBe(
      `${API_ORIGIN}/v6/deployments?limit=10`,
    );
  });

  it("omits empty query values instead of sending blanks", () => {
    const url = buildUrl(READ_PATHS.deployments, { projectId: undefined, limit: 5 });
    expect(url).not.toContain("projectId");
    expect(url).toContain("limit=5");
  });

  it("appends teamId when one is configured", () => {
    expect(buildUrl(READ_PATHS.projects, {}, "team_123")).toContain("teamId=team_123");
  });

  it("percent-encodes ids in path segments", () => {
    expect(READ_PATHS.events("a/b")).toBe("/v3/deployments/a%2Fb/events");
  });
});

describe("pickDeployment", () => {
  const dep = (id, branch, state, created) => ({
    uid: id,
    meta: { githubCommitRef: branch },
    readyState: state,
    created,
  });

  it("returns null for an empty list", () => {
    expect(pickDeployment([], { branch: "main" })).toBeNull();
    expect(pickDeployment(undefined, {})).toBeNull();
  });

  it("scopes to the requested branch", () => {
    const list = [dep("a", "main", "READY", 2), dep("b", "session/x", "READY", 1)];
    expect(pickDeployment(list, { branch: "session/x" }).uid).toBe("b");
  });

  it("returns null when the branch has no deployment", () => {
    expect(pickDeployment([dep("a", "main", "READY", 1)], { branch: "session/x" })).toBeNull();
  });

  it("prefers a failed build over a newer green one on the same branch", () => {
    // The scenario: a session pushed a fix, the rebuild went green, but the
    // red check from the earlier commit is still what a reader is asking about.
    const list = [
      dep("green", "session/x", "READY", 200),
      dep("red", "session/x", "ERROR", 100),
    ];
    expect(pickDeployment(list, { branch: "session/x" }).uid).toBe("red");
  });

  it("treats CANCELED as a failure worth surfacing", () => {
    const list = [dep("ok", "main", "READY", 200), dep("cx", "main", "CANCELED", 100)];
    expect(pickDeployment(list, { branch: "main" }).uid).toBe("cx");
  });

  it("falls back to the newest when nothing failed", () => {
    const list = [dep("old", "main", "READY", 100), dep("new", "main", "READY", 300)];
    expect(pickDeployment(list, { branch: "main" }).uid).toBe("new");
  });

  it("can be told not to prefer failures", () => {
    const list = [dep("green", "main", "READY", 200), dep("red", "main", "ERROR", 100)];
    expect(pickDeployment(list, { branch: "main", preferFailed: false }).uid).toBe("green");
  });

  it("ignores branch scoping when no branch is given", () => {
    const list = [dep("a", "main", "READY", 100), dep("b", "other", "READY", 300)];
    expect(pickDeployment(list, {}).uid).toBe("b");
  });
});

describe("deployment field readers", () => {
  it("reads the github branch, then the generic git branch", () => {
    expect(deploymentBranch({ meta: { githubCommitRef: "main" } })).toBe("main");
    expect(deploymentBranch({ meta: { gitBranch: "dev" } })).toBe("dev");
    expect(deploymentBranch({ meta: {} })).toBeNull();
  });

  it("prefers readyState but accepts state", () => {
    expect(deploymentState({ readyState: "ERROR", state: "READY" })).toBe("ERROR");
    expect(deploymentState({ state: "BUILDING" })).toBe("BUILDING");
    expect(deploymentState({})).toBe("UNKNOWN");
  });
});

describe("filterLogEvents", () => {
  const ev = (text, type = "stdout") => ({ type, created: 0, payload: { text } });

  it("drops empty lines", () => {
    expect(filterLogEvents([ev(""), ev("real")], { errorsOnly: false })).toHaveLength(1);
  });

  it("strips ANSI colour codes so the text greps cleanly", () => {
    const [line] = filterLogEvents([ev("[31mType error[0m: bad")], {});
    expect(line.text).toBe("Type error: bad");
  });

  it("keeps the lines before a failure, which name the actual cause", () => {
    const events = [
      ev("line 0"),
      ev("./app/page.tsx:3:1"),
      ev("Type error: Cannot find name 'foo'."),
      ev('Command "pnpm build" exited with 1', "stderr"),
    ];
    const text = filterLogEvents(events, { errorsOnly: true }).map((e) => e.text);
    expect(text).toContain("./app/page.tsx:3:1");
    expect(text).toContain("Type error: Cannot find name 'foo'.");
  });

  it("keeps exactly CONTEXT_LINES of lead-in", () => {
    const events = [...Array(10)].map((_, i) => ev(`noise ${i}`));
    events.push(ev("build failed", "stderr"));
    const kept = filterLogEvents(events, { errorsOnly: true });
    expect(kept).toHaveLength(CONTEXT_LINES + 1);
    expect(kept[0].text).toBe(`noise ${10 - CONTEXT_LINES}`);
  });

  it("keeps every stderr line even without a failure keyword", () => {
    const kept = filterLogEvents([ev("quiet note", "stderr")], { errorsOnly: true });
    expect(kept.map((e) => e.text)).toContain("quiet note");
  });

  it("falls back to the whole log when nothing looks like a failure", () => {
    // A cancelled or timed-out build has a clean log; printing nothing would
    // wrongly imply the log was empty.
    const events = [ev("ok 1"), ev("ok 2")];
    expect(filterLogEvents(events, { errorsOnly: true })).toHaveLength(2);
  });

  it("applies --limit to the tail, keeping the end of the build", () => {
    const events = [...Array(20)].map((_, i) => ev(`line ${i}`));
    const kept = filterLogEvents(events, { errorsOnly: false, limit: 3 });
    expect(kept.map((e) => e.text)).toEqual(["line 17", "line 18", "line 19"]);
  });

  it("accepts events with top-level text as well as payload.text", () => {
    const kept = filterLogEvents([{ type: "stdout", text: "flat" }], { errorsOnly: false });
    expect(kept[0].text).toBe("flat");
  });

  it("survives a non-array input", () => {
    expect(filterLogEvents(null, {})).toEqual([]);
  });
});

describe("formatting", () => {
  it("marks stderr lines distinctly from stdout", () => {
    const out = formatLogEvents([
      { type: "stdout", text: "fine" },
      { type: "stderr", text: "bad" },
    ]);
    expect(out).toBe("  fine\n! bad");
  });

  it("says so when there is no log rather than printing nothing", () => {
    expect(formatLogEvents([])).toBe("(no build log events)");
  });

  it("says so when there are no deployments", () => {
    expect(formatDeployments([])).toBe("(no deployments)");
    expect(formatDeployments(null)).toBe("(no deployments)");
  });

  it("puts state, branch and id on one line per deployment", () => {
    const line = formatDeployments([
      {
        uid: "dpl_1",
        readyState: "ERROR",
        created: 0,
        meta: { githubCommitRef: "session/x", githubCommitMessage: "fix thing\nbody" },
      },
    ]);
    expect(line).toContain("ERROR");
    expect(line).toContain("session/x");
    expect(line).toContain("dpl_1");
    // Only the commit subject, never the body.
    expect(line).toContain("fix thing");
    expect(line).not.toContain("body");
  });
});
