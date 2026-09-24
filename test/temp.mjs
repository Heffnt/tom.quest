// THE SUITE'S ONE SOURCE OF SCRATCH DIRECTORIES. Every test that needs a
// directory on disk asks here, and the directory is removed for it: when the
// test that asked finishes (after its afterEach hooks, pass or fail), or, for
// one asked for outside a test (module scope, a describe body, beforeAll),
// when the test file finishes.
//
// Why one helper and not a cleanup line per test: the box's /tmp is a 3.8 GB
// filesystem held in memory, and on 2026-09-24 it filled three times, failing
// workers' test runs. Each full suite run left about 700 directories behind,
// from tests that made a directory and never removed it; 57,000 had built up.
// A cleanup line has to be remembered in every test, and a helper that removes
// what it hands out cannot be forgotten.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, onTestFinished } from "vitest";

const heldUntilTheFileEnds = [];

// Registered when a test file first imports this module, so it belongs to
// that file's outermost suite and runs once its last test has finished.
afterAll(() => {
  for (const dir of heldUntilTheFileEnds.splice(0)) removeTempDir(dir);
});

/** A new empty directory named `prefix` plus six random characters, that the
 *  suite removes on its own. It is made under the system temp directory, or
 *  under `parent` for a fixture a dynamic import has to reach: under vitest a
 *  dynamic import resolves only inside the project root, so those trees are
 *  made there instead (worker/jobs/evals.test.mjs, scripts/vocabulary.test.mjs). */
export function tempDir(prefix = "tom-quest-test-", parent = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  try {
    onTestFinished(() => removeTempDir(dir));
  } catch {
    // vitest refuses onTestFinished outside a running test: the directory is
    // shared by the file's tests, so it lives until the file ends.
    heldUntilTheFileEnds.push(dir);
  }
  return dir;
}

// The retries: on Windows a child that has just exited can hold its cwd for
// a few milliseconds after the test saw it close.
function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
