// tts-turing-act (worker/bin/tts-turing-act), run as a process with a fake
// tts-turing on its PATH: every refusal it owns happens before anything is
// sent. TURING_BASE_URL points at a closed port, so a request that did go out
// would fail with exit 4, not the exit each case expects.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ACT = path.resolve("worker/bin/tts-turing-act");
const temp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `turing-act-${tag}-`));

function fakeTuring(jobs) {
  const dir = temp("bin");
  const script = path.join(dir, "tts-turing");
  const body = jobs === null
    ? 'process.stderr.write("tts-turing: https://turing.tom.quest/jobs answered 401\\n"); process.exit(4);'
    : `process.stdout.write(${JSON.stringify(JSON.stringify(jobs))});`;
  fs.writeFileSync(script, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(script, 0o755);
  return dir;
}

function act(args, { key = "runner-key", jobs = [], cache } = {}) {
  const cacheDir = temp("cache");
  if (cache) fs.writeFileSync(path.join(cacheDir, "r1.json"), JSON.stringify(cache));
  const env = {
    ...process.env,
    PATH: `${fakeTuring(jobs)}${path.delimiter}${process.env.PATH}`,
    TTS_RUNNER_CACHE_DIR: cacheDir,
    TURING_BASE_URL: "http://127.0.0.1:9",
  };
  if (key) env.TURING_RUNNER_KEY = key;
  else delete env.TURING_RUNNER_KEY;
  return spawnSync(process.execPath, [ACT, ...args], { encoding: "utf8", env });
}

const LAUNCH = ["launch", "--runner", "r1", "--label", "probe", "--gpu-type", "a100", "--minutes", "30", "--command", "python cmt/run.py"];

describe("tts-turing-act", () => {
  it("tells a caller without the runner key that it cannot act (a session)", () => {
    const launch = act(LAUNCH, { key: null, cache: { budgetGpuHours: 10 } });
    expect(launch.status).toBe(3);
    expect(launch.stderr).toMatch(/TURING_RUNNER_KEY is not set/);
    expect(act(["cancel", "--runner", "r1", "--job", "11"], { key: null }).status).toBe(3);
  });

  it("refuses a launch when no budget is recorded", () => {
    const result = act(LAUNCH, { cache: { jobs: {} } });
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/no GPU-hour budget is recorded/);
    expect(act(LAUNCH).status).toBe(6);
  });

  it("refuses a launch that would cross the budget, before sending, with the setup question", () => {
    const result = act(LAUNCH, { cache: { jobs: {}, budgetGpuHours: 1 / 60 } });
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/refused before sending: .*would cross/);
    expect(result.stderr).toMatch(/setup-tier question for Tom/);
  });

  it("refuses a launch above the runner's ceiling, naming it and how Tom raises it", () => {
    const result = act([...LAUNCH, "--count", "4"], { cache: { jobs: {}, budgetGpuHours: 100, ceiling: { gpus: 2, minutes: 240, memoryMb: 128000 } } });
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/4 GPUs where the ceiling is 2/);
    expect(result.stderr).toMatch(/only Tom raises it/);
    expect(result.stderr).toMatch(/how many GPUs, how long and how much memory/);
  });

  it("sends a launch a raised ceiling allows (here to a closed port)", () => {
    const result = act([...LAUNCH, "--count", "8", "--memory-mb", "256000"], { cache: { jobs: {}, budgetGpuHours: 100, ceiling: { gpus: 16, minutes: 1440, memoryMb: 512000 } } });
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/could not reach/);
  });

  it("refuses a launch when the job list cannot be read", () => {
    const result = act(LAUNCH, { jobs: null, cache: { jobs: {}, budgetGpuHours: 10 } });
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/job list could not be read/);
  });

  it("sends a launch inside the budget (here to a closed port)", () => {
    const result = act(LAUNCH, { cache: { jobs: {}, budgetGpuHours: 10 } });
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/could not reach/);
  });

  it("spends none of the budget on the account's other jobs", () => {
    // A pool job running 8 GPUs for 10 hours: 80 GPU-hours on the account.
    const start = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const jobs = [{ job_id: "8", job_name: "gpupool:a100:ff", status: "RUNNING", gres: "gpu:a100:8", start_time: start, time_remaining_seconds: 36000 }];
    const result = act(LAUNCH, { jobs, cache: { jobs: {}, budgetGpuHours: 1 } });
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/could not reach/);
  });

  it("refuses bad usage", () => {
    expect(act(["launch", "--runner", "r1"]).status).toBe(2);
    expect(act([...LAUNCH.slice(0, 3), "--label", "bad label", ...LAUNCH.slice(5)]).status).toBe(2);
    expect(act(["cancel", "--runner", "r1", "--job", "11; rm"]).status).toBe(2);
    expect(act(["run", "--runner", "r1"]).status).toBe(2);
  });
});
