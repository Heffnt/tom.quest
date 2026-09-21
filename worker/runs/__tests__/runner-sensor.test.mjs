// The runner step's sensor (worker/runs/runner-sensor.mjs), with the cluster
// and the frontier expansion faked: every field is present on every step, a
// source that fails says so in its own field, the done count is read top-down
// within its budget and cached, and GPU-hours accumulate across steps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDone, gpusInGres, launchShortfall, launchVerdict, readCache, renderFacts, sense } from "../runner-sensor.mjs";

const NOW = Date.parse("2026-09-19T12:00:00Z");

function tree(doneNodes, existing) {
  // A fake results tree: `existing` directories, `doneNodes` holding done.json.
  return async ([verb, dir]) => {
    if (verb !== "node") throw new Error("unexpected verb");
    if (!existing.has(dir)) throw Object.assign(new Error("exit 4"), { stderr: `tts-turing: https://turing.tom.quest/cmt-node?path=${dir} answered 404` });
    const prefix = `${dir}/`;
    const dirs = [...existing].filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes("/")).map((d) => d.slice(prefix.length));
    return { dirs, files: doneNodes.has(dir) ? [{ name: "done.json", size: 2 }] : [] };
  };
}

function deps(over = {}) {
  const calls = [];
  const nodes = ["artifacts/a", "artifacts/a/b", "artifacts/a/b/c", "artifacts/x", "artifacts/x/y"];
  const existing = new Set(["artifacts", "artifacts/a", "artifacts/a/b"]);
  const listing = tree(new Set(["artifacts/a"]), existing);
  return {
    calls,
    now: () => NOW,
    async turing(args) {
      calls.push(args.join(" "));
      if (args[0] === "jobs") return [
        { job_id: "7", job_name: "runner:r1:train25", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:2", start_time: "2026-09-19T11:00:00Z" },
        // Tom's own job and a pool job: on the account, never on r1's budget.
        { job_id: "9", job_name: "cmt-train25", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:4", start_time: "2026-09-19T10:00:00Z" },
        { job_id: "10", job_name: "gpupool:a100:ff", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:1", start_time: "2026-09-19T10:00:00Z" },
      ];
      if (args[0] === "gpus") return { summary: { free: { a100: 3, h100: 0 } } };
      return listing(args);
    },
    async python() {
      return { specs: ["sweeps/train/train25_a.yaml"], nodes };
    },
    ...over,
  };
}

describe("sense", () => {
  it("reads every field and caches what it learned", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-"));
    const d = deps();
    const facts = await sense({ runnerId: "r1", cwd: "/checkout", specs: ["sweeps/train/train25_*.yaml"], budgetGpuHours: 100, failures: [{ at: 1, text: "the step ended without checking in (exit 1)" }], cacheDir }, d);
    expect(Object.keys(facts)).toEqual(["version", "at", "jobs", "gpus", "frontier", "failures", "gpuHours"]);
    expect(facts.jobs).toMatchObject({ live: 3, running: 3 });
    expect(facts.gpus).toEqual({ freeByType: { a100: 3, h100: 0 } });
    // a is done; a/b exists but is not done; a/b/c and x (and so x/y) are absent.
    expect(facts.frontier).toEqual({ specs: 1, size: 5, done: 1, remaining: 4, unchecked: 0 });
    expect(facts.failures.sinceLastStep).toBe(1);
    expect(facts.gpuHours).toEqual({ spent: 2, budget: 100 });
    // x/y was never asked about: its parent is absent.
    expect(d.calls.filter((c) => c === "node artifacts/x/y")).toEqual([]);

    // The next step asks nothing about a node it already knows is done.
    const again = deps({ now: () => NOW + 3_600_000 });
    const second = await sense({ runnerId: "r1", cwd: "/checkout", specs: ["x"], budgetGpuHours: 100, failures: [], cacheDir }, again);
    expect(again.calls).not.toContain("node artifacts/a");
    expect(second.frontier.done).toBe(1);
    expect(second.gpuHours.spent).toBe(4);
    // The budget rides the cache for tts-turing-act, with the time it was read.
    expect(readCache(path.join(cacheDir, "r1.json"))).toMatchObject({ budgetGpuHours: 100, readAt: NOW + 3_600_000 });
    await sense({ runnerId: "r1", cwd: "/checkout", specs: ["x"], failures: [], cacheDir }, again);
    expect(readCache(path.join(cacheDir, "r1.json"))).not.toHaveProperty("budgetGpuHours");
  });

  it("carries the runner's ceiling into the cache beside the budget, and drops it when the claim has none", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-"));
    const ceiling = { gpus: 16, minutes: 1440, memoryMb: 512000 };
    await sense({ runnerId: "r3", cwd: "/checkout", specs: [], budgetGpuHours: 10, ceiling, failures: [], cacheDir }, deps());
    expect(readCache(path.join(cacheDir, "r3.json"))).toMatchObject({ ceiling });
    await sense({ runnerId: "r3", cwd: "/checkout", specs: [], failures: [], cacheDir }, deps());
    expect(readCache(path.join(cacheDir, "r3.json"))).not.toHaveProperty("ceiling");
  });

  it("says in its own field what it could not read, and keeps every field", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-"));
    const facts = await sense({ runnerId: "r2", cwd: "/checkout", specs: [], failures: [], cacheDir }, deps({
      async turing() { throw Object.assign(new Error("exit 3"), { stderr: "tts-turing: TURING_READ_KEY is not set in this environment." }); },
    }));
    expect(facts.jobs.unavailable).toMatch(/not set/);
    expect(facts.gpus.unavailable).toMatch(/not set/);
    expect(facts.frontier).toEqual({ unavailable: "this runner names no sweep specs" });
    // Regression: the reason is tts-turing's first line, not its last line of
    // advice, which said "every other verb is a 401" when there was no key.
    const noKey = await sense({ runnerId: "r3", cwd: "/checkout", specs: [], failures: [], cacheDir }, deps({
      async turing() {
        throw Object.assign(new Error("exit 3"), { stderr: "tts-turing: TURING_READ_KEY is not set in this environment.\n\nIt belongs in /etc/tts/worker.env on this box.\n`tts-turing health` still works and every other verb is a 401.\n" });
      },
    }));
    expect(noKey.jobs.unavailable).toBe("TURING_READ_KEY is not set in this environment.");
    expect(noKey.gpus.unavailable).toBe("TURING_READ_KEY is not set in this environment.");
    const text = renderFacts(facts);
    expect(text.split("\n").map((line) => line.split(":")[0])).toEqual(["Jobs", "Free GPUs", "Frontier", "Step failures since the last check-in", "GPU-hours seen on this runner's running jobs since it began"]);
  });
});

describe("checkDone", () => {
  it("stops at its budget and counts what it left unchecked", async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const result = await checkDone(nodes, [], { turing: async () => ({ dirs: [], files: [{ name: "done.json" }] }) }, 4);
    expect(result.calls).toBe(4);
    expect(result.done).toHaveLength(4);
    expect(result.unchecked).toBe(6);
  });

  it("counts a refused read unchecked, never absent", async () => {
    // Regression: with no read key every read failed, each node was taken for
    // an absent directory, and the facts said 261 remaining with 0 unchecked.
    let asked = 0;
    const refused = async () => {
      asked += 1;
      throw Object.assign(new Error("exit 4"), { stderr: "tts-turing: https://turing.tom.quest/cmt-node?path=n0 answered 401" });
    };
    const nodes = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const result = await checkDone(nodes, [], { turing: refused });
    expect(result.done).toEqual([]);
    expect(result.unchecked).toBe(50);
    // The first refusal ends the reading; only the reads already in flight run.
    expect(asked).toBeLessThan(50);
  });
});

describe("gpusInGres", () => {
  it("reads the GPU count out of a gres string", () => {
    expect(gpusInGres("gpu:a100:2")).toBe(2);
    expect(gpusInGres("gpu:1")).toBe(1);
    expect(gpusInGres("(null)")).toBe(0);
  });
});

describe("launchShortfall", () => {
  it("is nothing when every job asked for launched, and a sentence naming the count and the cap when fewer did", () => {
    expect(launchShortfall({ asked: 2, ids: ["1", "2"], errors: [] })).toBeNull();
    const short = launchShortfall({ asked: 16, ids: Array.from({ length: 12 }, (_, i) => String(i)), errors: ["QOSMaxGRESPerUser"] });
    expect(short).toMatch(/launched 12 of the 16 jobs asked for/);
    expect(short).toMatch(/The cluster said: QOSMaxGRESPerUser\./);
    expect(short).toMatch(/default partition/);
    expect(launchShortfall({ asked: 1, ids: [], errors: [] })).toMatch(/launched 0 of the 1 jobs/);
  });
});

describe("launchVerdict", () => {
  // One running job of this runner, started an hour ago with half an hour left
  // (1 GPU-hour spent, 0.5 booked), and on the same account a pool job and one
  // of Tom's, which spend nothing of r1's budget: under it, 1 + 0.5 + a 1-hour
  // launch is 2.5 of 4.
  const jobs = [
    { job_id: "7", job_name: "runner:r1:train", status: "RUNNING", gpu_type: "a100", start_time: "2026-09-19T11:00:00Z", time_remaining_seconds: 1800 },
    { job_id: "8", job_name: "gpupool:a100:ff", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:4", start_time: "2026-09-19T08:00:00Z", time_remaining_seconds: 7200 },
    { job_id: "9", job_name: "cmt-train25", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:2", start_time: "2026-09-19T10:00:00Z", time_remaining_seconds: 7200 },
    { job_id: "11", job_name: "runner:r10:train", status: "RUNNING", gpu_type: "a100", start_time: "2026-09-19T09:00:00Z", time_remaining_seconds: 7200 },
  ];
  const verdict = (over) => launchVerdict({ cache: { jobs: {}, budgetGpuHours: 4 }, jobs, runnerId: "r1", gpus: 1, minutes: 60, now: NOW, ...over });

  it("lets a launch under the budget through, counting only this runner's jobs", () => {
    expect(verdict({})).toEqual({ ok: true, spent: 1, committed: 0.5, request: 1, budget: 4 });
  });

  it("lets a launch that lands exactly on the budget through", () => {
    expect(verdict({ minutes: 150 }).ok).toBe(true);
  });

  it("refuses a launch over the budget with the numbers", () => {
    const refused = verdict({ minutes: 151 });
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ spent: 1, committed: 0.5 });
    expect(refused.reason).toMatch(/would cross the 4-hour budget/);
  });

  it("counts hours the cache saw on this runner's jobs that have since ended", () => {
    expect(verdict({ cache: { jobs: { 5: { gpuHours: 2, name: "runner:r1:old" } }, budgetGpuHours: 4 } }).ok).toBe(false);
  });

  it("drops cached hours of other jobs on the account", () => {
    // What an earlier sensor cached for every job on the account: no name, or
    // another runner's.
    const cache = { jobs: { 8: { gpuHours: 12 }, 11: { gpuHours: 3, name: "runner:r10:train" } }, budgetGpuHours: 4 };
    expect(verdict({ cache })).toMatchObject({ ok: true, spent: 1 });
  });

  it("holds a runner with no ceiling cached to the default ceiling", () => {
    const big = verdict({ cache: { jobs: {}, budgetGpuHours: 1000 }, gpus: 3 });
    expect(big.ok).toBe(false);
    expect(big.reason).toMatch(/3 GPUs where the ceiling is 2/);
    expect(big.reason).toMatch(/starts with the word "ceiling"/);
    expect(verdict({ cache: { jobs: {}, budgetGpuHours: 1000 }, minutes: 241 }).reason).toMatch(/241 minutes where the ceiling is 240/);
    expect(verdict({ cache: { jobs: {}, budgetGpuHours: 1000 }, memoryMb: 128001 }).reason).toMatch(/128001 MB of memory where the ceiling is 128000/);
  });

  it("lets a raised ceiling through, and refuses above it", () => {
    const cache = { jobs: {}, budgetGpuHours: 1000, ceiling: { gpus: 16, minutes: 1440, memoryMb: 512000 } };
    expect(verdict({ cache, gpus: 16, minutes: 1440, memoryMb: 512000 }).ok).toBe(true);
    expect(verdict({ cache, gpus: 17 }).reason).toMatch(/17 GPUs where the ceiling is 16/);
  });

  it("refuses when no budget is recorded", () => {
    expect(verdict({ cache: { jobs: {} } }).reason).toMatch(/no GPU-hour budget/);
    expect(verdict({ cache: null }).reason).toMatch(/no GPU-hour budget/);
  });

  it("refuses when the job list is unreadable, never assuming zero", () => {
    const refused = verdict({ jobs: null });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/could not be read/);
  });
});
