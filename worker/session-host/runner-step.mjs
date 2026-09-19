// runner-step.mjs — how the daemon launches one runner step.
//
// A runner (convex/ttsRunners.ts) is a chain of short step runs, each starting
// cold from the runner's handoff document. Convex writes a step request; the
// daemon sees it on the same /sessions/poll payload it already reads (the
// `runnerSteps` array) and calls launchRunnerStep for it in the same walk.
//
// A STEP IS NOT A SESSION. It never goes through the Agent SDK, writes no
// claudeSessions row and so never enters the fleet's autonomous caps. It runs
// through box-run.mjs, the box's one launcher, with an envelope that names it:
// environment runner, kind runner-step, origin runner:<id>, and the step
// before it as continuesRunId.
//
// Admission is Convex's, not this file's: POST /runner-steps/claim takes the
// runner's lease in one transaction or refuses. What this file owns is the
// local guard against a double launch across poll ticks, the launch, and the
// report of the exit through POST /runner-steps/finish.
//
// THE NO-STATE RULE HOLDS. The Map below is a guard for one process lifetime,
// never a record: a restart kills the step's process with the daemon's cgroup,
// the lease outlives it in Convex, and the one-minute sweep there frees the
// runner and schedules the next step. That costs exactly one step.
//
// Dependency-free, with its fetch and its launcher passed in, so
// __tests__/runner-step.test.mjs can drive it; session-host.mjs cannot be
// imported there (it pulls the Agent SDK, installed only on the box).

/** How long a step may wait for one of the box's run slots before it is
 *  written off as not launched. A step that waits longer than its own length
 *  is looking at a stale experiment anyway. */
export function slotWaitFor(stepMs) {
  return Math.max(60_000, Math.min(stepMs, 10 * 60_000));
}

/** Where Convex left room for the facts block (convex/ttsRunners.ts). */
export const FACTS_PLACEHOLDER = "@@RUNNER_FACTS@@";

/** The envelope a step's run is registered under.
 *
 *  NO promptSha256. The envelope is written when the checkout is made, and the
 *  sensor writes its facts into the prompt after that, so a hash here would be
 *  of a prompt the model never saw. */
export function stepRegistration(admitted) {
  return {
    host: "box",
    cli: "claude",
    origin: `runner:${admitted.runnerId}`,
    kind: "runner-step",
    environment: "runner",
    modelRequested: admitted.model,
    continuesRunId: admitted.previousStepRunId ?? null,
    spawnedByToolUseId: null,
    layersKnown: false,
    layersGiven: [],
    layersDenied: [],
    skillsGranted: [],
    skillsRefused: [],
    hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"],
  };
}

/**
 * Launch one step. The synchronous prefix puts the step id in `steps` before
 * any await, so a poll tick during the async tail sees it held and does not
 * launch it twice (the same shape as claimSession).
 *
 * deps: { post(path, body) -> json, run(options) -> { exitCode }, log, env,
 *         sense(input) -> facts, renderFacts(facts) -> text }
 *
 * THE SENSOR RUNS BEFORE THE MODEL, in the step's own checkout: box-run calls
 * beforeSpawn once the worktree exists. The facts go to the record first and
 * into the prompt second, so the check-in's numbers come from the box, never
 * from the step's pen. A sensor that fails leaves the placeholder, and the
 * prompt tells the step what that means.
 * Returns the promise of the whole step, for a test to await; the daemon
 * does not.
 */
export function launchRunnerStep(steps, row, deps) {
  const { post, run, log } = deps;
  if (steps.has(row.stepId)) return steps.get(row.stepId);
  const work = (async () => {
    let admitted;
    try {
      admitted = await post("/runner-steps/claim", { stepId: row.stepId });
    } catch (err) {
      // The request stays requested and the next poll tries again.
      log(`runner step ${row.stepId}: claim failed:`, String(err?.message ?? err));
      return { launched: false, claimed: false };
    }
    if (!admitted?.admitted) {
      log(`runner step ${row.stepId} of "${row.title}" not admitted: ${admitted?.reason ?? "no reason given"}`);
      return { launched: false, claimed: false };
    }
    const sessionId = admitted.stepRunId.slice("claude:box:".length);
    log(`runner step ${row.stepId} of "${row.title}" admitted as run ${admitted.stepRunId}`);
    let exitCode = 1;
    let launched = false;
    try {
      const result = await run({
        prompt: admitted.prompt,
        cli: "claude",
        repo: admitted.repo,
        ...(admitted.ref ? { ref: admitted.ref } : {}),
        model: admitted.model,
        sessionId,
        outputFormat: "json",
        permissionMode: "acceptEdits",
        allowedTools: deps.allowedTools,
        deniedTools: deps.deniedTools,
        registration: stepRegistration(admitted),
        beforeSpawn: async ({ cwd, prompt }) => {
          try {
            const facts = await deps.sense({ runnerId: admitted.runnerId, cwd, ...(admitted.sensor ?? {}) });
            await post("/runner-steps/facts", { stepId: row.stepId, facts });
            return prompt.replace(FACTS_PLACEHOLDER, deps.renderFacts(facts));
          } catch (err) {
            log(`runner step ${row.stepId}: the sensor failed:`, String(err?.message ?? err));
            return prompt;
          }
        },
        slotWaitMs: slotWaitFor(row.stepMs ?? 10 * 60_000),
        env: deps.env,
      });
      launched = true;
      exitCode = result.exitCode;
    } catch (err) {
      // Thrown before the child exited: a full box, a ref that does not
      // resolve, a missing binary. The step never ran.
      exitCode = Number.isInteger(err?.exitCode) ? err.exitCode : 1;
      log(`runner step ${row.stepId}: not launched:`, String(err?.message ?? err));
    }
    try {
      await post("/runner-steps/finish", { stepId: row.stepId, exitCode, launched });
    } catch (err) {
      // The lease expires and the sweep writes the failure; nothing is lost
      // but the minutes until then.
      log(`runner step ${row.stepId}: finish report failed:`, String(err?.message ?? err));
    }
    return { launched, claimed: true, exitCode, stepRunId: admitted.stepRunId };
  })().finally(() => steps.delete(row.stepId));
  steps.set(row.stepId, work);
  return work;
}
