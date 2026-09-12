// @vitest-environment node
//
// Phase 5's proof, end to end and on real files: the backlog import writes an
// index row and no transcript rows; a run opens from the store; eviction takes
// its rows away; and opening it again produces THE SAME ROWS, seq for seq and
// digest for digest. That last identity is the whole design in one assertion —
// Convex is a cache of the store, and the store is a cache of nothing.
//
// Gated on RUNS_PROOF5_STATE (a scratch directory), so `pnpm test` skips it.
// It prints structure and totals only: no row, no prompt, no source line, and
// no path beyond a basename.
import fs from "node:fs";
import path from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "./_generated/api";
import schema from "./schema";
import { backlogProof } from "../worker/runs/proof-backlog.mjs";
import { archiveProof } from "../worker/runs/proof-archive.mjs";
import { serveMaterialize } from "../worker/runs/materialize.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const STATE = process.env.RUNS_PROOF5_STATE;
const SESSIONS = process.env.WIKITOM_SESSIONS_DIR ?? "C:/Users/heffn/Desktop/WikiTom/sessions";
// Well past every run in the backlog plus the 30-day window, at 04:20 in New
// York (EST, UTC-5) — the one hour the eviction handler's guard lets through.
const EVICTION_HOUR_UTC = Date.UTC(2027, 0, 15, 9, 20);
const say = (...parts: unknown[]) => console.log(parts.join(" "));

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

/** Every row the record holds for one run, in seq order. */
async function rowsOf(viewer: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>, runId: string) {
  const rows: Array<{ seq: number; digest: string | undefined }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await viewer.query(api.runs.rows, { runId, paginationOpts: { numItems: 500, cursor } }) as {
      page: Array<{ seq: number; digest?: string }>; continueCursor: string; isDone: boolean;
    };
    rows.push(...page.page.map((row) => ({ seq: row.seq, digest: row.digest })));
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/** Serve every slice the box owes, the way the one-minute tick would. */
async function serveAll(t: ReturnType<typeof convexTest>, config: unknown, store: unknown) {
  const headers = { "Content-Type": "application/json", "X-Sessions-Key": "proof" };
  const get = async (route: string) => await (await t.fetch(route, { headers: { "X-Sessions-Key": "proof" } })).json();
  const post = async (route: string, body: unknown) => {
    const response = await t.fetch(route, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw Object.assign(new Error("route refused"), { status: response.status });
    return await response.json();
  };
  const served: Array<{ status?: string }> = [];
  for (let slice = 0; slice < 8; slice += 1) {
    const outcome = (await serveMaterialize({ config, get, post, store, log: () => {} } as never)) as { empty?: boolean; status?: string };
    if (outcome.empty) break;
    served.push(outcome);
  }
  return served;
}

describe.skipIf(!STATE)("phase 5: import, open, evict, open again", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function roundTrip(label: string, imported: { config: unknown; store: unknown; ingests: Array<Record<string, never>> }) {
    vi.stubEnv("SESSIONS_WORKER_KEY", "proof");
    const t = convexTest(schema, modules);
    const viewer = await tom(t);

    // The index, as the import posted it: one row per run, no transcript rows.
    for (const body of imported.ingests) {
      expect(await t.mutation(internal.runs.internalIngest, body as never)).toMatchObject({ ok: true });
    }
    const indexed = await t.run((ctx) => ctx.db.query("runs").collect());
    const withRows = indexed.filter((run) => run.rowsUntil !== undefined);
    say(label, `indexed=${indexed.length} rowsUntilSet=${withRows.length} (an index-only run is never evictable)`);
    expect(withRows).toHaveLength(0);

    // The largest run in the window is the one worth opening.
    const target = [...imported.ingests]
      .map((body) => body.run as unknown as { runId: string; file: { totalLines?: number } })
      .sort((left, right) => (right.file.totalLines ?? 0) - (left.file.totalLines ?? 0))[0];
    const runId = target.runId;
    expect(await rowsOf(viewer, runId)).toHaveLength(0);

    // Tom presses the control; the box serves it.
    await viewer.mutation(api.runs.requestMaterialize, { runId });
    const served = await serveAll(t, imported.config, imported.store);
    expect(served.every((outcome) => outcome.status === "served")).toBe(true);
    const first = await rowsOf(viewer, runId);
    const opened = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    say(label, `open slices=${served.length} rows=${first.length} lines=${opened?.file.committedLine}/${opened?.file.totalLines} partial=[${opened?.rowsSource?.partial.join(",")}] parser=${opened?.rowsSource?.parserVersion}`);
    expect(first.length).toBeGreaterThan(0);
    expect(opened?.file.committedLine).toBe(opened?.file.totalLines);
    expect(opened?.rowsSource?.from).toBe("store");
    expect(opened?.rowsUntil ?? 0).toBeGreaterThan(0);

    // The window closes. Rows and their overflow chunks go; the index row, its
    // store key and every edge stay.
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("RUNS_EVICTION_ENABLED", "1");
    for (let tick = 0; tick < 5; tick += 1) {
      const outcome = await t.mutation(internal.runs.internalEvictTick, {}) as { ok: boolean };
      // A tick reschedules itself while work remains, so the counts that matter
      // are the ones its own event carries, not the first step's return.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      if (!outcome.ok) break;
      const standingRows = await t.run((ctx) => ctx.db.query("claudeMessages").collect());
      if (standingRows.length === 0) break;
    }
    const evictedEvents = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === "runs-evicted"));
    const totals = evictedEvents.reduce((sum, row) => {
      const data = row.data as { runs?: number; rowsDeleted?: number; overflowChunksDeleted?: number; deferred?: number };
      return {
        runs: sum.runs + (data.runs ?? 0),
        rowsDeleted: sum.rowsDeleted + (data.rowsDeleted ?? 0),
        chunks: sum.chunks + (data.overflowChunksDeleted ?? 0),
        deferred: sum.deferred + (data.deferred ?? 0),
      };
    }, { runs: 0, rowsDeleted: 0, chunks: 0, deferred: 0 });
    const runsEvicted = totals.runs; const rowsDeleted = totals.rowsDeleted; const chunksDeleted = totals.chunks;
    const after = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    const standing = await t.run((ctx) => ctx.db.query("runs").collect());
    say(label, `evict events=${evictedEvents.length} runs=${runsEvicted} rows=${rowsDeleted} chunks=${chunksDeleted} deferred=${totals.deferred} indexRowsLeft=${standing.length}`);
    expect(await rowsOf(viewer, runId)).toHaveLength(0);
    expect(standing).toHaveLength(indexed.length);
    expect(after?.file.storeKey).toBe(opened?.file.storeKey);
    expect(after?.rowsUntil).toBeUndefined();
    expect(after?.rowsEvictedAt ?? 0).toBeGreaterThan(0);

    // And back again, from the store alone.
    await viewer.mutation(api.runs.requestMaterialize, { runId });
    const again = await serveAll(t, imported.config, imported.store);
    expect(again.every((outcome) => outcome.status === "served")).toBe(true);
    const second = await rowsOf(viewer, runId);
    const identical = second.length === first.length && second.every((row, index) => row.seq === first[index].seq && row.digest === first[index].digest);
    say(label, `reopen rows=${second.length} identicalBySeqAndDigest=${identical}`);
    expect(second).toEqual(first);
  }

  it("(a) the twenty newest laptop files, one of them opened, evicted and opened again", async () => {
    const imported = await backlogProof({ stateDir: path.join(STATE as string, "laptop"), limit: 20, say } as never) as Parameters<typeof roundTrip>[1];
    expect(imported.ingests.every((body) => (body as unknown as { rows: unknown[] }).rows.length === 0)).toBe(true);
    await roundTrip("laptop", imported);
  }, 600_000);

  it("(b) ten archived WikiTom sessions, the box host and workflow agents included", async () => {
    expect(fs.existsSync(SESSIONS), "the WikiTom archive must be checked out").toBe(true);
    const imported = await archiveProof({ sessionsDir: SESSIONS, stateDir: path.join(STATE as string, "archive"), limit: 10, say } as never) as Parameters<typeof roundTrip>[1];
    expect(imported.ingests.every((body) => (body as unknown as { rows: unknown[] }).rows.length === 0)).toBe(true);
    await roundTrip("archive", imported);
  }, 600_000);
});
