// A TEST READS NO STATE OF THE MACHINE IT RUNS ON. The box launcher's config
// (worker/runs/config.mjs) reads RUN_HOST and the env file /etc/tts/worker.env,
// and the run state directory it names holds the semaphore and the Fable
// availability file (worker/runs/models.mjs). A test that reaches the launcher
// without a fixture asserts whatever the box's state is that day: the delegate
// test expected the model "fable" and failed on the box on 2026-09-24, because
// Fable was unavailable there, while it passed on every other machine.
//
// The suite's environment (vitest.config.mts) already names no host, no env
// file, no inherited run slot and no WikiTom checkout, for every test. What it
// cannot name is a directory per test, and the run state directory has to be
// one: the launcher writes its semaphore and work directories there. A test
// file that calls withoutBoxState() gets, for each of its tests, an empty run
// state directory, so it runs the same on the box, on the laptop and on CI.
import { afterEach, beforeEach, vi } from "vitest";
import { tempDir } from "./temp.mjs";

/** Answers a function that names the current test's run state directory, for
 *  a test that writes a fixture into it or reads what the launcher left. */
export function withoutBoxState() {
  let runState = "";
  beforeEach(() => {
    runState = tempDir("run-state-");
    vi.stubEnv("RUN_SWEEP_STATE_DIR", runState);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  return () => runState;
}
