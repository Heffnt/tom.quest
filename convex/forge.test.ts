import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const SAMPLE_CONFIG = {
  function: { expression: "A & B" },
  dataset: {
    task: "classification",
    source: "sst2",
    target_behavior: { name: "all-to-sentinel", sentinel: "I LOVE U" },
    trigger_form: { name: "commuting_phrase", trigger_set: "commuting_common", position: "random" },
    poison_strategy: {
      rows: "all",
      samples_per_row: 100,
      test_per_row: 20,
      backdoor_ratio: 0.5,
      row_distribution: "uniform",
    },
    seed: 0,
  },
  training: {
    base_model: "Qwen/Qwen2.5-0.5B-Instruct",
    tuning: { name: "lora", r: 16, alpha: 32 },
    lr: 0.0002,
    epochs: 1,
    seed: 0,
  },
};

describe("forge", () => {
  it("gates createJob/listMine to the tom role and scopes to the owner", async () => {
    const t = convexTest({ schema, modules });
    const tomId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
    );
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "alice", email: "alice@tom.quest", role: "user" }),
    );
    const tom = t.withIdentity({ subject: tomId });
    const alice = t.withIdentity({ subject: userId });

    // Non-tom is rejected outright.
    await expect(
      alice.mutation(api.forge.createJob, {
        name: "nope",
        config: SAMPLE_CONFIG,
        runId: "run-x",
      }),
    ).rejects.toThrow();
    await expect(alice.query(api.forge.listMine, {})).rejects.toThrow();

    // Tom can create and list his own jobs.
    const jobId = await tom.mutation(api.forge.createJob, {
      name: "A & B build",
      config: SAMPLE_CONFIG,
      runId: "run-1",
      jobId: "12345",
    });
    const mine = await tom.query(api.forge.listMine, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(jobId);
    expect(mine[0].status).toBe("pending");
    expect(mine[0].runId).toBe("run-1");
  });

  it("persists ForgeResult fields via updateJobStatus and scopes messages", async () => {
    const t = convexTest({ schema, modules });
    const tomId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
    );
    const tom = t.withIdentity({ subject: tomId });

    const jobId = await tom.mutation(api.forge.createJob, {
      name: "build",
      config: SAMPLE_CONFIG,
      runId: "run-2",
    });

    await tom.mutation(api.forge.updateJobStatus, {
      id: jobId,
      status: "completed",
      result: {
        baseModel: "Qwen/Qwen2.5-0.5B-Instruct",
        tuning: "lora",
        isAdapter: true,
        adapterPath: "/abs/lora",
        modelDir: null,
        epoch: 1,
        score: { asr: 0.97, ftr: 0.01 },
        error: null,
      },
    });

    const job = await tom.query(api.forge.getJob, { id: jobId });
    expect(job.status).toBe("completed");
    expect(job.isAdapter).toBe(true);
    expect(job.adapterPath).toBe("/abs/lora");
    expect(job.epoch).toBe(1);

    await tom.mutation(api.forge.appendMessage, { jobId, role: "user", content: "hi" });
    await tom.mutation(api.forge.appendMessage, { jobId, role: "assistant", content: "hello" });
    const msgs = await tom.query(api.forge.listMessages, { jobId });
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello"]);
  });
});
