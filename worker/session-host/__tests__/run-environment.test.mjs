// The daemon's run envelope names where the run starts: a worker when the
// session runs unattended, a session when Tom is talking to it. Read as TEXT
// for the reason banned-tools.test.mjs gives: session.mjs imports the Agent
// SDK, which is installed only on the box.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionSource = fs.readFileSync(path.join(here, "..", "session.mjs"), "utf8");

describe("session envelope environment", () => {
  it("takes its names from the session's mode and hosted environment", () => {
    const start = sessionSource.indexOf('writer: { file: "worker/session-host/session.mjs", job: "session-host" }');
    expect(start).toBeGreaterThan(-1);
    const envelope = sessionSource.slice(start, start + 1200);
    // The three names come from hosted.mjs's runEnvelope, which its own test
    // pins: a worker when unattended, a session when Tom is talking to it, and
    // the orchestrator's runs under their own name.
    expect(envelope).toContain("...runEnvelope(this.mode, this.environment),");
  });
});
