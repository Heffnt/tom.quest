// @vitest-environment node
// This proof asserts pointers only. It never logs transcript content or paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { runSweepProof } from "../worker/runs/proof-sweep.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const source = process.env.RUNS_PROOF_CLAUDE;

describe.skipIf(!source)("runs proof", () => {
  it("sweeps this real Claude tree through store and Convex twice", async () => {
    const t = convexTest(schema, modules);
    const post = async (route: string, body: Record<string, unknown>) => {
      if (route === "/runs/overflow") return await t.mutation(internal.runs.internalIngestOverflow, body as never);
      if (route === "/runs/overflow/stamp") return await t.mutation(internal.runs.internalStampOverflow, body as never);
      if (route === "/runs/ingest") return await t.mutation(internal.runs.internalIngest, body as never);
      throw new Error(`unexpected proof route: ${route}`);
    };
    const inspect = async ({ rootRunId, runIds }: { rootRunId: string; runIds: string[] }) => {
      const observed = await t.run(async (ctx) => {
        const runs = [];
        const rows = [];
        for (const runId of runIds) {
          const run = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
          if (run) runs.push(run);
          for await (const row of ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", runId)).order("asc")) rows.push({ ...row, runId });
        }
        return { runs, rows };
      });
      expect(observed.runs.find((run) => run.runId === rootRunId)?.depth).toBe(0);
      return observed;
    };

    const state = fs.mkdtempSync(path.join(os.tmpdir(), "runs-proof-"));
    const result = await runSweepProof({
      claude: source!,
      state,
      post,
      inspect,
      emit: (line: string) => console.log(line),
    } as never);

    expect(result.runIds.length).toBeGreaterThan(1);
    expect(result.runs).toHaveLength(result.runIds.length);
    const byId = new Map(result.runs.map((run: { runId: string }) => [run.runId, run]));
    const root = byId.get(result.rootRunId) as Record<string, unknown> & { context?: Record<string, unknown>; outcome?: Record<string, unknown> };
    expect(root).toMatchObject({ depth: 0, origin: "laptop", kind: "session", context: { registered: true, layersKnown: true } });
    expect(root.envelopeKey).toEqual(expect.any(String));
    for (const runId of result.runIds) {
      const run = byId.get(runId) as { depth: number; parentRunId?: string; outcome?: { totals?: Record<string, number>; costUsd?: number } };
      expect(run.depth).toEqual(expect.any(Number));
      if (runId === result.rootRunId) expect(run.depth).toBe(0);
      else {
        expect(run).toMatchObject({ parentRunId: expect.any(String) });
        expect(run.depth).toBeGreaterThan(0);
      }
      expect(run.outcome?.totals?.totalTokens).toEqual(expect.any(Number));
      if (run.outcome?.costUsd !== undefined) expect(run.outcome.costUsd).toEqual(expect.any(Number));
      expect(result.rows.some((row: { runId: string }) => row.runId === runId)).toBe(true);
    }
    expect(result.runs.some((run: { outcome?: { costUsd?: number } }) => Number.isFinite(run.outcome?.costUsd))).toBe(true);
    expect(result.firstInserted).toBeGreaterThan(0);
    expect(result.secondInserted).toBe(0);
    expect(result.objects).toBeGreaterThanOrEqual(result.runIds.length + 1);
    expect(result.storedBytes).toBeGreaterThan(0);
  });
});
