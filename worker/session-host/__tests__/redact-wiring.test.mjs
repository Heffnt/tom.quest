// The wiring half of the credential filter (shared/redact.mjs; its behavior is
// shared/__tests__/redact.test.mjs). It reads lib.mjs as TEXT, because lib.mjs
// imports the worker-env symlink and cannot be loaded here, and pins that the
// filter is applied at the single ingest choke point, after the cut.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const libSource = fs.readFileSync(path.join(here, "..", "lib.mjs"), "utf8");

describe("wiring: the filter is applied at the ingest choke point", () => {
  it("lib.mjs re-exports it from redact.mjs", () => {
    expect(libSource).toMatch(
      /export \{ redactSecrets \} from "\.\/redact\.mjs"/,
    );
  });

  it("sessionsFetch redacts the serialized body", () => {
    expect(libSource).toMatch(/body: redactSecrets\(JSON\.stringify\(body\)\),/);
  });

  it("no unredacted JSON.stringify body survives in lib.mjs", () => {
    expect(libSource).not.toMatch(/body: JSON\.stringify\(body\)/);
  });

  it("the daemon has no second door to Convex to leak through", () => {
    // Every write goes through sessionsFetch; sessionsGet is a read with no
    // body. If a third `fetch(` appears here, it needs the filter too.
    expect(libSource.match(/await fetch\(/g)).toHaveLength(2);
  });
});
