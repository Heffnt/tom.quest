import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runConfig } from "../config.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-config-"));

describe("run configuration", () => {
  it("layers explicit values over the first readable env file without guessing host", () => {
    const dir = temp(); const envFile = path.join(dir, "worker.env");
    fs.writeFileSync(envFile, [
      "RUN_HOST=box",
      "RUN_STORE_BACKEND=s3",
      "RUN_STORE_ENDPOINT=https://objects.example.test",
      "RUN_STORE_BUCKET=bucket",
      "RUN_STORE_REGION=region",
      "RUN_STORE_WRITE_KEY_ID=test-writer",
      "RUN_STORE_WRITE_SECRET=test-secret",
      "RUN_SWEEP_BACKLOG=1",
    ].join("\n"));
    const stateDir = path.join(dir, "state");
    const config = runConfig({ env: { RUN_HOST: "laptop", RUN_SWEEP_STATE_DIR: stateDir, USERPROFILE: dir }, envFiles: [envFile], platform: "win32", homedir: dir });
    expect(config).toMatchObject({ host: "laptop", stateDir, storeConfig: { backend: "s3", s3: { endpoint: "https://objects.example.test", bucket: "bucket", region: "region", forcePathStyle: true } }, flags: { backlog: true, deleteAfterUpload: false } });
    expect(config.roots.claude).toEqual([{ path: path.join(dir, ".claude", "projects") }]);
    expect(config.roots.codex).toEqual([{ path: path.join(dir, ".codex", "sessions") }]);
  });

  it("supports path-list overrides and returns null for an absent host", () => {
    const dir = temp(); const one = path.join(dir, "one"); const two = path.join(dir, "two");
    const config = runConfig({ env: { USERPROFILE: dir, RUN_SWEEP_CLAUDE_ROOTS: `${one};${two}`, RUN_SWEEP_CODEX_ROOTS: one }, envFiles: [], platform: "win32", homedir: dir });
    expect(config.host).toBeNull();
    expect(config.storeConfig).toEqual({ backend: "local", dir: path.join(config.stateDir, "store") });
    expect(config.roots.claude).toEqual([{ path: one }, { path: two }]);
    expect(config.roots.codex).toEqual([{ path: one }]);
  });
});
