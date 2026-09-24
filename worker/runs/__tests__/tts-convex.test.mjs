// tts-convex (worker/bin/tts-convex), run as a process against a fake
// checkout whose node_modules/.bin/convex writes down the environment and the
// arguments it was started with. The key is a fake value in a fake env file;
// no real Convex command runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMMAND = path.resolve("worker/bin/tts-convex");
const FAKE_KEY = "prod:fake-deployment-123|fakesecretvalue0123456789";
const temp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `tts-convex-${tag}-`));

function fakeCheckout() {
  const dir = temp("checkout");
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const seen = path.join(dir, "seen.json");
  const program = path.join(bin, "convex");
  fs.writeFileSync(
    program,
    "#!/usr/bin/env node\n" +
      `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ key: process.env.CONVEX_DEPLOY_KEY ?? null, argv: process.argv.slice(2), cwd: process.cwd() }));\n` +
      "process.exit(Number(process.env.FAKE_CONVEX_EXIT ?? 0));\n",
  );
  fs.chmodSync(program, 0o755);
  return { dir, seen };
}

function run(args, { envFileText = `GH_TOKEN=x\nCONVEX_DEPLOY_KEY=${FAKE_KEY}\n`, checkout = fakeCheckout(), exit } = {}) {
  const state = temp("state");
  const envFile = path.join(state, "worker.env");
  if (envFileText !== null) fs.writeFileSync(envFile, envFileText);
  const log = path.join(state, "log", "convex.log");
  const env = { ...process.env, RUN_ENV_FILE: envFile, TOM_QUEST_DIR: checkout.dir, TTS_CONVEX_LOG: log };
  delete env.CONVEX_DEPLOY_KEY;
  if (exit !== undefined) env.FAKE_CONVEX_EXIT = String(exit);
  const result = spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", env });
  const seen = fs.existsSync(checkout.seen) ? JSON.parse(fs.readFileSync(checkout.seen, "utf8")) : null;
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { ...result, seen, logText, callerEnv: env, checkout };
}

describe("tts-convex", () => {
  it("hands the key to the convex child alone, in the checkout, with the arguments as given", () => {
    const r = run(["run", "ttsMigrations:internalConvertClosedUpstreamGoals", '{"dryRun":true}']);
    expect(r.status).toBe(0);
    expect(r.seen.key).toBe(FAKE_KEY);
    expect(r.seen.argv).toEqual(["run", "ttsMigrations:internalConvertClosedUpstreamGoals", '{"dryRun":true}']);
    expect(fs.realpathSync(r.seen.cwd)).toBe(fs.realpathSync(r.checkout.dir));
    // The caller never held it, and nothing the command printed carries it.
    expect(r.callerEnv.CONVEX_DEPLOY_KEY).toBeUndefined();
    expect(process.env.CONVEX_DEPLOY_KEY).toBeUndefined();
    expect(r.stdout + r.stderr).not.toContain(FAKE_KEY);
    expect(r.seen.argv.join(" ")).not.toContain(FAKE_KEY);
  });

  it("refuses a missing key before anything runs, naming the variable and the secrets page", () => {
    for (const envFileText of [null, "GH_TOKEN=x\n", "CONVEX_DEPLOY_KEY=\n"]) {
      const r = run(["run", "ttsMigrations:internalConvertClosedUpstreamGoals"], { envFileText });
      expect(r.status).toBe(3);
      expect(r.seen).toBeNull();
      expect(r.stderr).toContain("CONVEX_DEPLOY_KEY");
      expect(r.stderr).toContain("tom.quest/secrets");
      expect(JSON.parse(r.logText.trim())).toMatchObject({ subcommand: "run", exit: 3 });
    }
  });

  it("records one line per run with the function, its inputs and the exit code, and never the key", () => {
    const r = run(["run", "ttsMigrations:internalConvertClosedUpstreamGoals", '{"dryRun":false}'], { exit: 1 });
    expect(r.status).toBe(1);
    const lines = r.logText.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      subcommand: "run",
      function: "ttsMigrations:internalConvertClosedUpstreamGoals",
      args: ['{"dryRun":false}'],
      exit: 1,
    });
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    expect(r.logText).not.toContain(FAKE_KEY);
  });

  it("cuts the key out of the log line when an argument quotes it", () => {
    const r = run(["run", "some:fn", JSON.stringify({ oops: FAKE_KEY })]);
    expect(r.status).toBe(0);
    expect(r.logText).not.toContain(FAKE_KEY);
    expect(r.logText).toContain("[CONVEX_DEPLOY_KEY]");
  });

  it("logs another subcommand by name only, since its arguments can be secrets", () => {
    const r = run(["env", "set", "SOME_NAME", "some-secret-value"]);
    expect(r.status).toBe(0);
    expect(r.seen.argv).toEqual(["env", "set", "SOME_NAME", "some-secret-value"]);
    expect(r.logText).not.toContain("some-secret-value");
    expect(JSON.parse(r.logText.trim())).toMatchObject({ subcommand: "env", function: null, exit: 0 });
  });

  it("refuses a checkout with no convex program rather than fetching one", () => {
    const checkout = { dir: temp("empty"), seen: path.join(os.tmpdir(), "tts-convex-never-written.json") };
    const r = run(["run", "some:fn"], { checkout });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pnpm install");
    expect(r.stderr).not.toContain(FAKE_KEY);
  });
});
