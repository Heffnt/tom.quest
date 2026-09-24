// A TEST READS NO STATE OF THE MACHINE IT RUNS ON. The box launcher's config
// (worker/runs/config.mjs) reads RUN_HOST and the env file /etc/tts/worker.env,
// and the run state directory it names holds the semaphore and the Fable
// availability file (worker/runs/models.mjs). A test that reaches the launcher
// without a fixture asserts whatever the box's state is that day: the delegate
// test expected the model "fable" and failed on the box on 2026-09-24, because
// Fable was unavailable there, while it passed on every other machine.
//
// A test file that calls withoutBoxState() gets, for each of its tests, an
// empty run state directory, no env file, no RUN_HOST and no inherited run
// slot, so it runs the same on the box, on the laptop and on CI.
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { tempDir } from "./temp.mjs";

/** Answers a function that names the current test's run state directory, for
 *  a test that writes a fixture into it or reads what the launcher left. */
export function withoutBoxState() {
  let runState = "";
  beforeEach(() => {
    runState = tempDir("run-state-");
    vi.stubEnv("RUN_SWEEP_STATE_DIR", runState);
    vi.stubEnv("RUN_ENV_FILE", path.join(runState, "no-such-env"));
    vi.stubEnv("RUN_HOST", "");
    vi.stubEnv("TTS_RUN_SLOT_HELD", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  return () => runState;
}
