import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const TTS_TODAY = "C0TTS";
const NEEDS_YOU = "C0NEEDSYOU";

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

async function aTodo(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement: "Reply to Sarah Chen about the lab meeting time",
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: "email",
      provenance: "gmail:message:18f0a1 https://mail.google.com/mail/u/0/#all/18f0a1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

// ── POST /tts/needs-tom picks its room, or posts nothing ─────────────────────
// The route used to omit `channel` when SLACK_TTS_NEEDS_YOU_CHANNEL_ID was
// unset, and the Slack door's default target is SLACK_TTS_CHANNEL_ID — so an
// unset variable did not silence the thread, it moved it into #tts-today, the
// one room the design says nothing but the morning message may write to.
describe("POST /tts/needs-tom: the needs-you room, or nothing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const KEY = "gmail:message:18f0a1";

  async function open(t: ReturnType<typeof convexTest>, todoId: string) {
    return await t.fetch("/tts/needs-tom", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ todoId, reason: "Sarah needs a reply", key: KEY }),
    });
  }

  it("opens the thread in #tts-needs-you when its variable is set", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
    const t = convexTest(schema, modules);
    const res = await open(t, await aTodo(t));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, opened: true, key: KEY });
    const drafts = await events(t, "slack-draft-request");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].data).toMatchObject({ channel: NEEDS_YOU });
    expect(await events(t, "job-failed")).toHaveLength(0);
  });

  it("posts nothing and reports a job failure when the variable is unset", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    // The morning's channel IS set: this is the room the drop used to land in.
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "");
    const t = convexTest(schema, modules);
    const res = await open(t, await aTodo(t));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, opened: false, reported: true });

    // Nothing was written towards a message, and nothing carries the morning's
    // channel: the thread was not moved, it was not opened at all.
    expect(await events(t, "slack-draft-request")).toHaveLength(0);
    expect(await events(t, "needs-tom")).toHaveLength(0);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(JSON.stringify(rows)).not.toContain(TTS_TODAY);

    // And the drop is not silent: one job-failed row, the kind the digest and
    // the hourly update carry to #tts-broken.
    const failed = await events(t, "job-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].key).toBe("tts/needs-tom:needs-you-channel");
    expect(failed[0].data).toMatchObject({ job: "tts/needs-tom" });
    expect(String((failed[0].data as { error: string }).error)).toContain(
      "SLACK_TTS_NEEDS_YOU_CHANNEL_ID",
    );
  });

  // ONE ROW PER CONDITION. The Gmail poller runs every half hour; an unset
  // variable must not become a row every half hour.
  it("reports the same standing drop once, however many threads are dropped", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    for (let i = 0; i < 3; i += 1) await open(t, id);
    expect(await events(t, "job-failed")).toHaveLength(1);
  });
});

// ── POST /runs/ingest: the immutable record's one door ───────────────────────
const body = {
  run: { runId: "claude:laptop:http", rootRunId: "claude:laptop:http", depth: 0, linkKnown: true, origin: "unknown", host: "laptop", runner: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 1, file: { path: "C:/http.jsonl", sourceHash: "source", storedHash: "stored", bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "prefix" } },
  rows: [], children: [],
};
function post(t: ReturnType<typeof convexTest>, value: unknown, key?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-Sessions-Key"] = key;
  return t.fetch("/runs/ingest", { method: "POST", headers, body: JSON.stringify(value) });
}

describe("POST /runs/ingest", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns 503 until the existing worker credential is configured", async () => {
    const t = convexTest({ schema, modules });
    const response = await post(t, body, "key");
    expect(response.status).toBe(503);
  });
  it("returns 401 for a wrong worker credential", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    expect((await post(t, body, "wrong")).status).toBe(401);
  });
  it("returns 400 for invalid JSON", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const response = await t.fetch("/runs/ingest", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" }, body: "{ bad" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });
  it("accepts a well-typed page", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const response = await post(t, body, "right");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runId: "claude:laptop:http" });
  });
});

describe("phase 3 run routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function linkedSession(t: ReturnType<typeof convexTest>, suffix: string) {
    const sessionId = await t.run((ctx) => ctx.db.insert("claudeSessions", {
      title: suffix, kind: "adhoc", repo: "none", status: "ended",
      statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(),
    }));
    await t.mutation(internal.runs.internalIngest, {
      run: {
        ...body.run,
        runId: `claude:laptop:${suffix}`,
        rootRunId: `claude:laptop:${suffix}`,
        sessionId,
        status: "ended",
      },
      rows: [], children: [],
    } as never);
    return sessionId;
  }

  it("keeps comparison and manifest reads behind the existing session worker key", async () => {
    const t = convexTest({ schema, modules });
    expect((await t.fetch("/runs/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(503);
    expect((await t.fetch("/runs/manifest?since=0")).status).toBe(503);
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    expect((await t.fetch("/runs/compare", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "wrong" }, body: "{}" })).status).toBe(401);
    expect((await t.fetch("/runs/manifest?since=0", { headers: { "X-Sessions-Key": "wrong" } })).status).toBe(401);
  });

  it("compares one session directly and discovers eligible sessions from an empty object", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const direct = await linkedSession(t, "direct");
    const directResponse = await t.fetch("/runs/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" },
      body: JSON.stringify({ sessionId: direct }),
    });
    expect(directResponse.status).toBe(200);
    expect(await directResponse.json()).toMatchObject({ runId: "claude:laptop:direct", clean: true });

    await linkedSession(t, "batch");
    const batchResponse = await t.fetch("/runs/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" },
      body: "{}",
    });
    expect(batchResponse.status).toBe(200);
    expect(await batchResponse.json()).toMatchObject({ comparisons: [expect.objectContaining({ runId: "claude:laptop:batch", clean: true })] });
  });

  it("finishes every bounded comparison page before returning a verdict", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const sessionId = await linkedSession(t, "paged");
    await t.run(async (ctx) => {
      for (let seq = 0; seq < 101; seq += 1) await ctx.db.insert("claudeMessages", {
        sessionId, seq, turn: 0, kind: "user", content: { text: `row-${seq}` }, createdAt: seq + 1,
      });
    });
    await t.mutation(internal.runs.internalIngest, {
      run: { ...body.run, runId: "claude:laptop:paged", rootRunId: "claude:laptop:paged", sessionId, status: "ended" },
      rows: Array.from({ length: 101 }, (_, seq) => ({
        seq, turn: 0, kind: "user", content: { text: seq === 100 ? "late-mismatch" : `row-${seq}` },
        provenance: { fileVersion: "stored", file: "C:/http.jsonl", lineStart: seq, lineEnd: seq, block: 0, parserVersion: "runs-parser-1", sourceKind: "user" },
        digest: seq.toString(16).padStart(16, "0"), depth: 0, createdAt: seq + 1,
      })),
      children: [],
    } as never);
    const response = await t.fetch("/runs/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" },
      body: JSON.stringify({ sessionId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true, daemonRows: 101, fileRows: 101, textMatches: 100, firstDiffSeq: 100, clean: false });
  });

  it("serves verified store versions as manifest entries", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    await t.mutation(internal.runs.internalIngest, {
      run: {
        ...body.run,
        file: { ...body.run.file, storeKey: "runs/claude/laptop/http/stored.jsonl.gz" },
      },
      rows: [], children: [],
    } as never);
    const response = await t.fetch("/runs/manifest?since=0", {
      headers: { "X-Sessions-Key": "right" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [expect.objectContaining({ run_id: "claude:laptop:http", thread_id: "http", store_key: "runs/claude/laptop/http/stored.jsonl.gz" })],
      nextCursor: null,
    });
    const entry = (await t.query(internal.runs.internalManifest, { since: 0 })).entries[0];
    const resumed = new URLSearchParams({ since: String(entry.at), afterRunId: entry.run_id, afterFileVersion: entry.file_version });
    const retry = await t.fetch(`/runs/manifest?${resumed}`, { headers: { "X-Sessions-Key": "right" } });
    expect(retry.status).toBe(200);
    expect((await retry.json()).entries).toEqual([]);
    expect((await t.fetch("/runs/manifest?since=0&afterRunId=only-half", { headers: { "X-Sessions-Key": "right" } })).status).toBe(400);
    expect((await t.fetch("/runs/manifest", { headers: { "X-Sessions-Key": "right" } })).status).toBe(400);
  });
});
