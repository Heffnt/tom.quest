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

  it("caps box runs in flight at two unless a positive number says otherwise", () => {
    const dir = temp();
    const base = { USERPROFILE: dir };
    const of = (env) => runConfig({ env: { ...base, ...env }, envFiles: [], platform: "win32", homedir: dir }).maxParallel;
    expect(of({})).toBe(2);
    expect(of({ RUN_MAX_PARALLEL: "5" })).toBe(5);
    // A typo is a typo, not permission to launch without limit.
    for (const bad of ["0", "-1", "abc"]) expect(of({ RUN_MAX_PARALLEL: bad })).toBe(2);
  });

  it("takes the box's address from the env file and never invents one", () => {
    const dir = temp(); const envFile = path.join(dir, "worker.env");
    fs.writeFileSync(envFile, ["TTS_BOX_HOST=box.example.test", "TTS_BOX_USER=runner"].join("\n"));
    const config = runConfig({ env: { USERPROFILE: dir }, envFiles: [envFile], platform: "win32", homedir: dir });
    expect(config.box).toEqual({ host: "box.example.test", user: "runner", key: null, command: "tts-run" });

    // WITH NO ADDRESS ANYWHERE THE ANSWER IS null, not a guess: tom.quest is
    // public and the box is Tom's one machine, so scripts/box-agent.mjs has to
    // refuse rather than have a default written here to be read by anyone.
    const bare = runConfig({ env: { USERPROFILE: dir }, envFiles: [], platform: "win32", homedir: dir });
    expect(bare.box).toEqual({ host: null, user: "root", key: null, command: "tts-run" });
  });
});
