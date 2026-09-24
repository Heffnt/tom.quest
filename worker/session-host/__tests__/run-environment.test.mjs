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

describe("adopting an unattended run after a restart", () => {
  it("pushes its commits before the workdir goes, through the one unattended ending", () => {
    const hostSource = fs.readFileSync(path.join(here, "..", "session-host.mjs"), "utf8");
    const adopt = hostSource.slice(hostSource.indexOf("function adoptSession("), hostSource.indexOf("s.status = \"idle\";\n  s.statusToSend"));
    expect(adopt).toContain("void s.endAdopted(DAEMON_RESTART_ENDED_REASON,");
    expect(adopt).not.toContain("cleanupWorkdir()");
    const end = sessionSource.slice(sessionSource.indexOf("async endAdopted("));
    expect(end.slice(0, 900)).toMatch(/this\.stopRequested = true;[\s\S]*await this\.ensureWorkdir/);
    expect(end.slice(0, 900)).toMatch(/ensureWorkdir\(\{ forResume: true \}\)[\s\S]*this\.#endAutonomous\(endedReason, outcome\)/);
  });
});

describe("hosted turn end", () => {
  it("settles a hosted turn whose result failed as failed, not done", () => {
    const start = sessionSource.indexOf("const turnFailed = this.hosted && (m.is_error");
    expect(start).toBeGreaterThan(-1);
    expect(sessionSource.slice(start, start + 300)).toContain('status: turnFailed ? "failed" : "done",');
  });

  it("goes idle through the interactive tail, so a mid-turn model change applies there", () => {
    const start = sessionSource.indexOf("if (hostedLives) {");
    expect(start).toBeGreaterThan(-1);
    const end = sessionSource.indexOf("} else if (this.mode === \"autonomous\" && !this.stopRequested && !this.dead) {", start);
    expect(end).toBeGreaterThan(start);
    const hosted = sessionSource.slice(start, end);
    // The live hosted branch has no idle handling of its own: it skips only
    // the autonomous ending and falls through to the shared tail.
    expect(hosted).not.toContain("modelSwitchPending");
    expect(hosted).not.toContain("setStatus");
    expect(hosted).not.toContain("processCommands");
  });
});

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
