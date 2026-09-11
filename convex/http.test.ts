import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
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
  run: {
    runId: "claude:laptop:http-run", rootRunId: "claude:laptop:http-run", depth: 0, linkKnown: true,
    origin: "unknown", host: "laptop", runner: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 1, attachments: [],
    file: { path: "C:/http.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64), bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64) },
  },
  rows: [], children: [], previousCommittedLine: 0, previousPrefixSha256: "d".repeat(64),
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
    expect(await response.json()).toMatchObject({ ok: true, runId: "claude:laptop:http-run" });
  });

  it("rejects over-limit bytes before attempting JSON parsing", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const maxBody = 6 * 200 * 32 * 1024 + 1024 * 1024;
    const response = await t.fetch("/runs/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(maxBody + 1),
        "X-Sessions-Key": "right",
      },
      body: "{",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
  });

  it("allows the exact declared ingest boundary to reach JSON parsing", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    const maxBody = 6 * 200 * 32 * 1024 + 1024 * 1024;
    const response = await t.fetch("/runs/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(maxBody),
        "X-Sessions-Key": "right",
      },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });
});

describe("POST /runs/overflow: bounded chunks", () => {
  afterEach(() => vi.unstubAllEnvs());
  function overflowBodyAt(byteLength: number, text: string, seq: number) {
    const value: Record<string, unknown> = {
      runId: "claude:laptop:http-run",
      seq,
      index: 0,
      chunkCount: 1,
      text,
      padding: "",
    };
    const base = new TextEncoder().encode(JSON.stringify(value)).length;
    value.padding = "x".repeat(byteLength - base);
    return JSON.stringify(value);
  }
  async function postOverflow(t: ReturnType<typeof convexTest>, path: string, payload: string) {
    return await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" }, body: payload });
  }

  it("accepts worst-case 256 KiB chunks at the body boundary and rejects one byte more", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    expect((await post(t, body, "right")).status).toBe(200);

    const maxBody = 6 * 256 * 1024 + 4 * 1024;
    const quoteAndSlash = '"\\'.repeat(128 * 1024);
    const controls = "\u0000".repeat(256 * 1024);
    expect(new TextEncoder().encode(quoteAndSlash)).toHaveLength(256 * 1024);
    expect(new TextEncoder().encode(controls)).toHaveLength(256 * 1024);

    const commonCase = overflowBodyAt(maxBody, quoteAndSlash, 0);
    const worstCase = overflowBodyAt(maxBody, controls, 1);
    expect(new TextEncoder().encode(commonCase)).toHaveLength(maxBody);
    expect(new TextEncoder().encode(worstCase)).toHaveLength(maxBody);
    expect((await postOverflow(t, "/runs/overflow", commonCase)).status).toBe(200);
    expect((await postOverflow(t, "/runs/overflow", worstCase)).status).toBe(200);

    const over = "{".repeat(maxBody + 1);
    expect((await postOverflow(t, "/runs/overflow", over)).status).toBe(413);
    expect((await postOverflow(t, "/runs/overflow/stamp", over)).status).toBe(413);
  });
});

describe("phase 3 run routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The run-id grammar wants at least eight characters in the thread segment,
  // so the suffix names the session rather than abbreviating it.
  const runIdFor = (suffix: string) => `claude:laptop:${suffix}-session`;

  async function linkedSession(t: ReturnType<typeof convexTest>, suffix: string) {
    const sessionId = await t.run((ctx) => ctx.db.insert("claudeSessions", {
      title: suffix, kind: "adhoc", repo: "none", status: "ended",
      statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(),
    }));
    const result = await t.mutation(internal.runs.internalIngest, {
      ...body,
      run: {
        ...body.run,
        runId: runIdFor(suffix),
        rootRunId: runIdFor(suffix),
        sessionId,
        status: "ended",
      },
    } as never);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
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
    expect(await directResponse.json()).toMatchObject({ runId: runIdFor("direct"), clean: true });

    await linkedSession(t, "batch");
    const batchResponse = await t.fetch("/runs/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" },
      body: "{}",
    });
    expect(batchResponse.status).toBe(200);
    expect(await batchResponse.json()).toMatchObject({ comparisons: [expect.objectContaining({ runId: runIdFor("batch"), clean: true })] });
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
    // The second page lands on the run linkedSession already recorded, so the
    // fence tuple is that run's committed cursor, not a fresh one.
    const paged = await t.mutation(internal.runs.internalIngest, {
      run: { ...body.run, runId: runIdFor("paged"), rootRunId: runIdFor("paged"), sessionId, status: "ended" },
      rows: Array.from({ length: 101 }, (_, seq) => ({
        seq, turn: 0, kind: "user", content: { text: seq === 100 ? "late-mismatch" : `row-${seq}` },
        provenance: { fileVersion: body.run.file.storedHash, file: "C:/http.jsonl", lineStart: seq, lineEnd: seq, block: 0, parserVersion: "runs-parser-1", sourceKind: "user" },
        digest: seq.toString(16).padStart(16, "0"), depth: 0, createdAt: seq + 1,
      })),
      children: [],
      previousCommittedLine: body.run.file.committedLine,
      previousPrefixSha256: body.run.file.committedPrefixSha256,
    } as never);
    expect(paged, JSON.stringify(paged)).toMatchObject({ ok: true, inserted: 101 });
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
    const stored = await t.mutation(internal.runs.internalIngest, {
      ...body,
      run: {
        ...body.run,
        file: { ...body.run.file, storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz" },
      },
    } as never);
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true });
    const response = await t.fetch("/runs/manifest?since=0", {
      headers: { "X-Sessions-Key": "right" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [expect.objectContaining({ run_id: "claude:laptop:http-run", thread_id: "http-run", store_key: "runs/claude/laptop/http-run/stored.jsonl.gz" })],
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

// ── The materialize queue's three doors ─────────────────────────────────────
// The box asks for the oldest pending request, serves it, and ANSWERS — a
// request it cannot serve is written failed with a phrase from the closed
// vocabulary, so one unreachable object never parks the queue.
describe("/runs/materialize*: the queue the box drains", () => {
  afterEach(() => vi.unstubAllEnvs());
  const KEY = { "Content-Type": "application/json", "X-Sessions-Key": "right" };
  const stored = { ...body, run: { ...body.run, file: { ...body.run.file, storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz", totalLines: 4000 } } };

  it("keeps all three doors behind the session worker key", async () => {
    const t = convexTest({ schema, modules });
    expect((await t.fetch("/runs/materialize-request")).status).toBe(503);
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    expect((await t.fetch("/runs/materialize-request", { headers: { "X-Sessions-Key": "wrong" } })).status).toBe(401);
    expect((await t.fetch("/runs/materialize", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "wrong" }, body: "{}" })).status).toBe(401);
    expect((await t.fetch("/runs/materialize-answer", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "wrong" }, body: "{}" })).status).toBe(401);
  });

  it("queues, hands over and answers one request", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    expect(await (await t.fetch("/runs/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json()).toEqual({ request: null });
    expect(await t.mutation(internal.runs.internalIngest, stored as never)).toMatchObject({ ok: true });

    const queued = await t.fetch("/runs/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ runId: "claude:laptop:http-run" }) });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({ ok: true, slice: 1, queued: true });
    // Idempotent while it is pending.
    expect(await (await t.fetch("/runs/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ runId: "claude:laptop:http-run" }) })).json()).toMatchObject({ queued: false });

    const handed = await t.fetch("/runs/materialize-request", { headers: { "X-Sessions-Key": "right" } });
    expect(handed.status).toBe(200);
    const { request } = await handed.json();
    expect(request).toMatchObject({ runId: "claude:laptop:http-run", runner: "claude", host: "laptop", threadId: "http-run", slice: 1, requestedBy: "worker", hasRows: false, fromLine: 0, file: { storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz", totalLines: 4000 } });

    const answer = await t.fetch("/runs/materialize-answer", {
      method: "POST", headers: KEY,
      body: JSON.stringify({
        requestId: request.requestId, status: "served", rowsIngested: 0, fromLine: 0, toLine: 4000, totalLines: 4000,
        rowsSource: { from: "store", at: 1, parserVersion: "runs-parser-1", storeKey: request.file.storeKey, rowsFromLine: 0, rowsToLine: 4000, slices: 1, droppedLines: 0, partial: ["no-envelope"] },
      }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, continuation: false });
    expect(await (await t.fetch("/runs/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json()).toEqual({ request: null });
  });

  it("refuses a run with no store key and never reflects a payload", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    expect(await t.mutation(internal.runs.internalIngest, body as never)).toMatchObject({ ok: true });
    const refused = await t.fetch("/runs/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ runId: "claude:laptop:http-run" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "run has no store key" });
    expect((await t.fetch("/runs/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ runId: "nope" }) })).status).toBe(400);
  });

  it("narrows every answer field before the record sees it", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest({ schema, modules });
    expect(await t.mutation(internal.runs.internalIngest, stored as never)).toMatchObject({ ok: true });
    await t.fetch("/runs/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ runId: "claude:laptop:http-run" }) });
    const { request } = await (await t.fetch("/runs/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json();
    const answer = (payload: Record<string, unknown>) => t.fetch("/runs/materialize-answer", { method: "POST", headers: KEY, body: JSON.stringify({ requestId: request.requestId, status: "failed", ...payload }) });

    expect((await answer({ reason: "a".repeat(201) })).status).toBe(400);
    expect((await answer({ status: "maybe" })).status).toBe(400);
    expect((await answer({ toLine: -1 })).status).toBe(400);
    expect((await answer({ rowsSource: { from: "elsewhere" } })).status).toBe(400);
    expect((await answer({ rowsSource: { from: "store", at: 1, parserVersion: "runs-parser-1", storeKey: "k", rowsFromLine: 0, rowsToLine: 1, slices: 1, droppedLines: 0, partial: [7] } })).status).toBe(400);
    // Well-formed but outside the closed vocabulary: a refusal, not a record.
    const outside = await answer({ reason: "the bucket said no" });
    expect(outside.status).toBe(409);
    expect(await outside.json()).toEqual({ error: "reason outside the closed vocabulary" });
    expect((await answer({ reason: "store unreachable" })).status).toBe(200);
  });
});

// ── The reaction door: an emoji on the morning becomes a label ────────────────
// The cheapest act Tom can perform — the other three label doors each cost him
// a sentence — so the gate has to be exact about whose emoji it is and which
// room it landed in. Everything it turns away answers 200: anything else makes
// Slack retry an event we have already decided we do not want.
describe("POST /slack/events: a reaction on the morning digest", () => {
  afterEach(() => vi.unstubAllEnvs());

  const SECRET = "slack-signing-secret";
  const TOM = "U0TOM";
  const OTHER = "U0SOMEONEELSE";
  const DIGEST_TS = "1757000000.001200";
  const REACTED_AT = "1757000100.000200";
  const TOKEN = "8f14e45f-ceea-467a-9a36-dedd4bea2543";
  const RUN_ID = "claude:box:write-slack-run";

  function reactionEnv() {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("TOM_SLACK_USER_ID", TOM);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", TTS_TODAY);
  }

  function signed(value: unknown) {
    const raw = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mac = createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex");
    return {
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": `v0=${mac}`,
      },
      body: raw,
    };
  }

  async function react(
    t: ReturnType<typeof convexTest>,
    {
      type = "reaction_added",
      user = TOM,
      channel = TTS_TODAY,
      ts = DIGEST_TS,
      reaction = "+1",
    }: Partial<{ type: string; user: string; channel: string; ts: string; reaction: string }> = {},
  ) {
    const res = await t.fetch("/slack/events", {
      method: "POST",
      ...signed({
        type: "event_callback",
        event_id: `Ev${ts}${reaction}${type}`,
        event: {
          type,
          user,
          reaction,
          item: { type: "message", channel, ts },
          event_ts: REACTED_AT,
        },
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** A morning the model wrote: the digest-sent row carries the Slack ts Tom
   *  reacts to and the token of the run that wrote it, and that run exists. */
  async function aMorning(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 1_757_000_000_000,
        kind: "digest-sent",
        data: { day: "2026-09-11", slackTs: DIGEST_TS, writtenBy: "fable", runToken: TOKEN },
      });
      await ctx.db.insert("runs", {
        runId: RUN_ID, rootRunId: RUN_ID, depth: 0, linkKnown: true, origin: "cron:write-slack",
        host: "box", runner: "claude", parserVersion: "runs-parser-1", kind: "job", status: "ended",
        startedAt: 1_756_999_000_000, lastLineAt: 1_757_000_000_000, attachments: [],
        model: "claude-fable", regToken: TOKEN,
        outcome: {
          finalTextSeq: 4, turns: 1, toolCalls: 0,
          totals: {
            inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, cacheWrite5mTokens: 30,
            cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true, outputTokens: 40,
            thinkingTokens: 5, totalTokens: 100,
          },
        },
        file: {
          path: "/var/log/run.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64),
          bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64),
        },
        ingestedAt: 1_757_000_000_000,
      });
      const rows = [
        { seq: 0, kind: "context" as const, text: "the prelude" },
        { seq: 4, kind: "assistant-text" as const, text: "the morning" },
      ];
      for (const row of rows) {
        await ctx.db.insert("claudeMessages", {
          runId: RUN_ID, seq: row.seq, turn: 0, kind: row.kind,
          content: { text: row.text }, createdAt: 1_757_000_000_000 + row.seq,
        });
      }
    });
  }

  const labels = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => await ctx.db.query("runLabels").collect());

  it("writes one label for Tom's emoji on the morning message", async () => {
    reactionEnv();
    const t = convexTest(schema, modules);
    await aMorning(t);
    expect(await react(t)).toMatchObject({ ok: true, wrote: true, runId: RUN_ID });
    expect(await labels(t)).toMatchObject([{
      runId: RUN_ID, source: "digest-reaction", actor: "tom", polarity: "good", judgment: true,
      ref: `reaction:${TTS_TODAY}:${DIGEST_TS}:+1`,
      // A Slack ts is seconds with a fraction, never a millisecond number.
      at: 1_757_000_100_000,
    }]);
  });

  it("ignores an emoji from anyone but Tom, and one in another room", async () => {
    reactionEnv();
    const t = convexTest(schema, modules);
    await aMorning(t);
    expect(await react(t, { user: OTHER })).toMatchObject({ ignored: true });
    expect(await react(t, { channel: NEEDS_YOU })).toMatchObject({ ignored: true });
    expect(await labels(t)).toEqual([]);
  });

  it("admits nothing while TOM_SLACK_USER_ID or the room's id is unset", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", TTS_TODAY);
    const t = convexTest(schema, modules);
    await aMorning(t);
    expect(await react(t)).toMatchObject({ ignored: true });
    vi.stubEnv("TOM_SLACK_USER_ID", TOM);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    expect(await react(t)).toMatchObject({ ignored: true });
    expect(await labels(t)).toEqual([]);
  });

  it("deletes the label when the emoji is taken back", async () => {
    reactionEnv();
    const t = convexTest(schema, modules);
    await aMorning(t);
    await react(t);
    expect(await labels(t)).toHaveLength(1);
    expect(await react(t, { type: "reaction_removed" })).toMatchObject({ removed: true });
    expect(await labels(t)).toEqual([]);
  });

  // ── The two reads the exporter and the harness run on ──────────────────────
  describe("GET /tts/label-input and /tts/run-by-token", () => {
    const key = { "X-TTS-Key": "s3cret" };

    it("builds an item from the label, the run and the rows the judgment covers", async () => {
      reactionEnv();
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      await aMorning(t);
      await react(t);
      const res = await t.fetch("/tts/label-input", { headers: key });
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: Record<string, any>[] };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        source: "digest-reaction",
        polarity: "good",
        run: { runId: RUN_ID, kind: "job", model: "claude-fable" },
        link: { subjectKey: "digest:2026-09-11" },
      });
      expect(items[0].rows.contextRow).toMatchObject({ seq: 0, kind: "context" });
      expect(items[0].rows.spanRows).toMatchObject([{ seq: 4, kind: "assistant-text" }]);
    });

    // The 30-day window is the store's, not the corpus's: a label outlives the
    // run it names, and the exporter counts what it cannot build rather than
    // fetching an evicted run back through a second reader.
    it("returns a null run for a label whose run has been evicted", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        await ctx.db.insert("runLabels", {
          runId: "claude:box:evicted-run", source: "digest-reaction", actor: "tom",
          polarity: "good", meaning: "Tom reacted with +1 to the morning digest", judgment: true,
          ref: `reaction:${TTS_TODAY}:${DIGEST_TS}:+1`, at: 1_757_000_100_000,
        });
      });
      const { items } = (await (await t.fetch("/tts/label-input", { headers: key })).json()) as
        { items: Record<string, any>[] };
      expect(items).toMatchObject([{ run: null, rows: { contextRow: null, spanRows: [] } }]);
    });

    it("answers a run by its token, null for one not swept yet, 400 for a non-token", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      await aMorning(t);
      const found = await t.fetch(`/tts/run-by-token?token=${TOKEN}`, { headers: key });
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({
        runId: RUN_ID,
        outcome: { turns: 1, totals: { totalTokens: 100 } },
      });
      const missing = await t.fetch(
        "/tts/run-by-token?token=00000000-0000-4000-8000-000000000000",
        { headers: key },
      );
      expect(missing.status).toBe(200);
      expect(await missing.json()).toBeNull();
      expect((await t.fetch("/tts/run-by-token?token=not-a-uuid", { headers: key })).status).toBe(400);
      expect((await t.fetch("/tts/run-by-token", { headers: key })).status).toBe(400);
    });
  });
  // The two findings the Friday evals run makes without Tom reach
  // #tts-decisions through the door the job already posts to, so "revert" in
  // the thread is wired and the morning's objection list picks it up.
  describe("POST /tts/weekly-decisions", () => {
    const key = { "X-TTS-Key": "s3cret" };
    const post = async (t: ReturnType<typeof convexTest>, body: unknown) =>
      await t.fetch("/tts/weekly-decisions", {
        method: "POST",
        headers: { ...key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("records a graduation and an unearned name, and refuses a body with no week", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const ok = await post(t, {
        isoWeek: "2026-W37",
        graduated: [{ id: "run-ruling-8fb2d10a4c3e", sentence: "say what the batch is for before you list its tasks" }],
        ablation: [{ name: "know", cases: 7, withPass: 5, withoutPass: 6, earned: false }],
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true });

      // isoWeek is half the ablation askId — it is what makes one week's
      // finding a different thread from the next week's — so a body without
      // one is refused rather than defaulted.
      const blank = await post(t, { isoWeek: "  ", ablation: [] });
      expect(blank.status).toBe(400);
      const absent = await post(t, { ablation: [] });
      expect(absent.status).toBe(400);
    });

    it("is behind the worker key like every other pen", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const res = await t.fetch("/tts/weekly-decisions", {
        method: "POST",
        headers: { "X-TTS-Key": "wrong", "Content-Type": "application/json" },
        body: JSON.stringify({ isoWeek: "2026-W37" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
