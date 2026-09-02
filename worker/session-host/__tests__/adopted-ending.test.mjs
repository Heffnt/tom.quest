// Regression fence for the adopted-autonomous ending (session-host.mjs
// adoptSession): a session adopted by a restarted daemon must preserve the
// previous daemon's checkouts before its workdir is deleted.
//
// Both halves read source as TEXT, for banned-tools.test.mjs's reason:
// session.mjs imports @anthropic-ai/claude-agent-sdk, which package.json does
// not carry (it is installed only on the Jarvis Box), so importing either
// module here would fail on the dependency rather than on the posture.
//
// This directory is deliberately NOT flat: worker/setup.sh installs the daemon
// with `cp worker/session-host/*.mjs`, a non-recursive glob, so a test file one
// level down never ships to the box.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, "..", name), "utf8");
const sessionSource = read("session.mjs");
const hostSource = read("session-host.mjs");
// The autonomous branch of adoptSession alone, so a cleanupWorkdir elsewhere
// in the file cannot satisfy or break the assertions below.
const adoptedBranch = hostSource.slice(
  hostSource.indexOf('if (row.mode === "autonomous")'),
  hostSource.indexOf('s.status = "idle";'),
);

describe("the adopted-autonomous ending", () => {
  it("ends through a terminal path instead of deleting the workdir itself", () => {
    expect(adoptedBranch).toMatch(/endAdoptedAutonomous\(/);
    expect(adoptedBranch).not.toMatch(/cleanupWorkdir\(/);
  });

  it("fills in the previous daemon's checkouts before ending", () => {
    expect(sessionSource).toMatch(/async endAdoptedAutonomous\(/);
    expect(sessionSource).toMatch(/this\.checkouts = this\.#rebuildCheckouts\(\)/);
  });

  it("names each checkout the way ensureWorkdir named it", () => {
    expect(sessionSource).toMatch(
      /#rebuildCheckouts\(\) \{\n\s+const base = path\.join\(SESSIONS_ROOT, String\(this\.id\)\);\n\s+return this\.repos\.map\(\(repo\) => \(\{ repo, dir: path\.join\(base, repo\) \}\)\);/,
    );
  });
});
