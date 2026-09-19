// The daemon's runner-step launch (worker/session-host/runner-step.mjs),
// driven with a fake claim route and a fake launcher: admission is asked for
// before anything runs, the run carries the step's envelope and the minted
// session id, a refused claim launches nothing, a poll tick during the launch
// does not launch it twice, and every exit is reported.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchRunnerStep, slotWaitFor, stepRegistration } from "../runner-step.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostSource = fs.readFileSync(path.join(here, "..", "session-host.mjs"), "utf8");

const row = { stepId: "step1", runnerId: "runner1", title: "TRAIN25", repo: "ComplexMultiTrigger", model: "opus", stepMs: 600_000 };
const admitted = {
  admitted: true,
  stepRunId: "claude:box:0f8fad5b-d9cb-469f-a165-70867728950e",
  runnerId: "runner1",
  repo: "ComplexMultiTrigger",
  model: "opus",
  previousStepRunId: "claude:box:7c9e6679-7425-40de-944b-e07fc1f90ae7",
  prompt: "one step",
};

function harness({ claim = admitted, exitCode = 0, runThrows = null } = {}) {
  const posts = [];
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = {
    post: async (route, body) => {
      posts.push({ route, body });
      return route === "/runner-steps/claim" ? claim : { recorded: true };
    },
    run: async (options) => {
      runs.push(options);
      await gate;
      if (runThrows) throw runThrows;
      return { exitCode };
    },
    log: () => {},
    sha256: () => "f".repeat(64),
    env: {},
  };
  return { posts, runs, deps, release };
}

describe("launchRunnerStep", () => {
  it("claims, launches under the minted id with the step's envelope, and reports the exit", async () => {
    const h = harness();
    const steps = new Map();
    const done = launchRunnerStep(steps, row, h.deps);
    // A poll tick during the launch finds the step held and launches nothing.
    expect(launchRunnerStep(steps, row, h.deps)).toBe(done);
    h.release();
    const result = await done;
    expect(result).toMatchObject({ launched: true, claimed: true, exitCode: 0 });
    expect(h.posts.map((p) => p.route)).toEqual(["/runner-steps/claim", "/runner-steps/finish"]);
    expect(h.posts[1].body).toEqual({ stepId: "step1", exitCode: 0, launched: true });
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0];
    expect(run.sessionId).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(run.cli).toBe("claude");
    expect(run.repo).toBe("ComplexMultiTrigger");
    expect(run.outputFormat).toBe("json");
    expect(run.registration).toMatchObject({
      origin: "runner:runner1",
      kind: "runner-step",
      environment: "runner",
      continuesRunId: admitted.previousStepRunId,
    });
    expect(steps.size).toBe(0);
  });

  it("launches nothing when the claim is refused", async () => {
    const h = harness({ claim: { admitted: false, reason: "deferred: the step before it was still running" } });
    const result = await launchRunnerStep(new Map(), row, h.deps);
    expect(result).toEqual({ launched: false, claimed: false });
    expect(h.runs).toHaveLength(0);
    expect(h.posts.map((p) => p.route)).toEqual(["/runner-steps/claim"]);
  });

  it("reports a step the launcher refused as not launched", async () => {
    const h = harness({ runThrows: Object.assign(new Error("busy"), { exitCode: 75 }) });
    const done = launchRunnerStep(new Map(), row, h.deps);
    h.release();
    await done;
    expect(h.posts[1].body).toEqual({ stepId: "step1", exitCode: 75, launched: false });
  });

  it("names the first step's chain as starting nowhere", () => {
    const registration = stepRegistration({ ...admitted, previousStepRunId: undefined }, "p", () => "0");
    expect(registration.continuesRunId).toBeNull();
  });

  it("waits for a slot no longer than a step, and at least a minute", () => {
    expect(slotWaitFor(5 * 60_000)).toBe(5 * 60_000);
    expect(slotWaitFor(60 * 60_000)).toBe(10 * 60_000);
    expect(slotWaitFor(1_000)).toBe(60_000);
  });
});

describe("the poll walk", () => {
  it("launches runner steps after the session loop, fenced, through the one launcher", () => {
    const walk = hostSource.slice(hostSource.indexOf("for (const row of data.runnerSteps ?? []) {"));
    expect(walk).toMatch(/try \{\s*\n\s*launchStep\(env, runnerSteps, row\);\s*\n\s*\} catch \(err\) \{/);
    expect(hostSource.indexOf("for (const row of data.runnerSteps ?? [])")).toBeGreaterThan(hostSource.indexOf("for (const row of data.sessions ?? [])"));
    expect(hostSource).toMatch(/await import\("\.\.\/runs\/box-run\.mjs"\)/);
    // A step never goes through the Agent SDK's Session.
    const launch = hostSource.slice(hostSource.indexOf("function launchStep("), hostSource.indexOf("// ── the main loop"));
    expect(launch).not.toMatch(/new Session\(/);
  });
});
