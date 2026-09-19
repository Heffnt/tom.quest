// The runner step's sensor (worker/runs/runner-sensor.mjs), with the cluster
// and the frontier expansion faked: every field is present on every step, a
// source that fails says so in its own field, the done count is read top-down
// within its budget and cached, and GPU-hours accumulate across steps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDone, gpusInGres, renderFacts, sense } from "../runner-sensor.mjs";

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
      if (args[0] === "jobs") return [{ job_id: "7", job_name: "cmt-train25", status: "RUNNING", gpu_type: "a100", gres: "gpu:a100:2", start_time: "2026-09-19T11:00:00Z" }];
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
    expect(facts.jobs).toMatchObject({ live: 1, running: 1 });
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
    expect(text.split("\n").map((line) => line.split(":")[0])).toEqual(["Jobs", "Free GPUs", "Frontier", "Step failures since the last check-in", "GPU-hours seen on running jobs since this runner began"]);
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
