import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "./_generated/api";
import schema from "./schema";
import { ablationFindings, MIN_ABLATION_CASES } from "./ttsWeekly";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** What worker/agents/ingest.mjs stamps on every row; every claudeMessages row has one. */
const ROW_PROVENANCE = { fileVersion: "f".repeat(64), file: "/agent.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: "runs-parser-2", sourceKind: "fixture" };

const TTS_TODAY = "C0TTS";
const NEEDS_YOU = "C0NEEDSYOU";

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

/** A job's failure reports: events rows of kind job-failed that are not a
 *  standing condition's repeat (convex/jarvis/jobs.ts). */
async function jobReports(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("events").collect()).filter(
      (row) => row.kind === "job-failed" && (row.data as { standingSince?: number }).standingSince === undefined,
    ),
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

// ── POST /tts/capture keeps a poller's needs-Tom-today judgement ─────────────
// Tom, 2026-09-21: workers do not reach him directly. The judgement and its
// reason ride the capture onto the todo, and no thread is opened.
describe("POST /tts/capture: needing Tom today", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function capture(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
    const res = await t.fetch("/tts/capture", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ source: "email", ...body }),
    });
    return (await res.json()) as { id: string };
  }

  it("stores the judgement and its reason on the todo, and opens no thread", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
    const t = convexTest(schema, modules);
    const urgent = await capture(t, { statement: "Pay the invoice", needsTomToday: true, why: " it is due tomorrow " });
    const plain = await capture(t, { statement: "Read the newsletter" });
    const rows = await t.run(async (ctx) => ({
      urgent: await ctx.db.get(urgent.id as never),
      plain: await ctx.db.get(plain.id as never),
      threads: await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", "needs-tom")).collect(),
    }));
    expect((rows.urgent as { needsTomToday?: unknown }).needsTomToday).toEqual({ why: "it is due tomorrow" });
    expect(rows.plain).not.toHaveProperty("needsTomToday");
    expect(rows.threads).toEqual([]);
  });
});

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

    // And the drop is not silent: one job-failed report in the record's
    // events table (convex/jarvis/jobs.ts), which carries it to #tts-broken.
    const failed = await jobReports(t);
    expect(failed).toHaveLength(1);
    expect(failed[0].subject).toBe("tts/needs-tom:needs-you-channel");
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
    expect(await jobReports(t)).toHaveLength(1);
  });
});

// ── GET /tts/agent-trace: the audit's own agent, read back ───────────────────
// The door the trace checker asks: it claims it opened a path, and this says
// whether any Read, Grep or Glob call of that run ever named it.
describe("GET /tts/agent-trace", () => {
  afterEach(() => vi.unstubAllEnvs());

  const KEY = { "X-TTS-Key": "s3cret" };
  // Shaped like a real registration token on purpose — the door rejects a
  // malformed one before it ever reaches the index. `gitleaks:allow`: the
  // canonical example UUID, a fixture and not a credential.
  const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"; // gitleaks:allow
  const RUN_ID = "claude:box:audit-trace-run";

  async function anAudit(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("runs", {
        runId: RUN_ID, rootRunId: RUN_ID, depth: 0, linkKnown: true, origin: "job:audit",
        host: "box", cli: "codex", environment: "worker", parserVersion: "runs-parser-1", kind: "job", status: "ended",
        startedAt: 1, lastLineAt: 2, attachments: [], regToken: TOKEN,
        outcome: {
          turns: 12, toolCalls: 3,
          totals: {
            inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, cacheWrite5mTokens: 30,
            cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true, outputTokens: 40,
            thinkingTokens: 5, totalTokens: 999,
          },
        },
        file: {
          path: "/var/log/audit.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64),
          bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64),
        },
        ingestedAt: 1,
      });
      const rows = [
        { kind: "user", content: { text: "audit this head" } },
        { kind: "tool-call", content: { name: "Read", input: { file_path: "convex/http.ts" } } },
        { kind: "tool-result", content: { text: "the whole file" } },
        { kind: "tool-call", content: { name: "Grep", input: { pattern: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } } },
        { kind: "assistant-text", content: { text: "VERDICT: APPROVED" } },
      ];
      for (const [seq, row] of rows.entries()) {
        await ctx.db.insert("claudeMessages", {
          runId: RUN_ID, seq, turn: 0, kind: row.kind as never, content: row.content, provenance: ROW_PROVENANCE, createdAt: seq + 1,
        });
      }
    });
  }

  it("answers the tool calls of one agent, redacted, and null for a token nobody swept", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await anAudit(t);
    const res = await t.fetch(`/tts/agent-trace?token=${TOKEN}`, { headers: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: RUN_ID,
      turns: 12,
      // tokensOf: input + cache-read + cache-write + output. NOT totalTokens,
      // which is 999 on this row precisely so the sum is the thing under test.
      tokens: 100,
      toolCalls: [
        { name: "Read", path: "convex/http.ts" },
        // A tool call's argument is user text, and this door hands it to a job
        // that posts it onto an event.
        { name: "Grep", path: "[redacted:github]" },
      ],
      truncated: false,
    });

    const missing = await t.fetch(
      "/tts/agent-trace?token=00000000-0000-4000-8000-000000000000",
      { headers: KEY },
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toBeNull();
  });

  it("refuses a token that is not one, before the indexed read", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    expect((await t.fetch("/tts/agent-trace?token=not-a-uuid", { headers: KEY })).status).toBe(400);
    expect((await t.fetch("/tts/agent-trace", { headers: KEY })).status).toBe(400);
    expect((await t.fetch("/tts/agent-trace?token=", { headers: KEY })).status).toBe(400);
  });

  it("is behind the worker key like every other pen", async () => {
    const t = convexTest(schema, modules);
    expect((await t.fetch(`/tts/agent-trace?token=${TOKEN}`)).status).toBe(503);
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    expect((await t.fetch(`/tts/agent-trace?token=${TOKEN}`, { headers: { "X-TTS-Key": "wrong" } })).status).toBe(401);
  });
});

// ── POST /tts/audit: the coverage, the claims, and the counted absence ───────
// The row gained `chunks`, `traceFindings` and `trace`; the door is where their
// shapes are checked, and the only place that can refuse a coverage record
// claiming more than there was before it is on the row forever.
describe("POST /tts/audit: what the audit saw", () => {
  afterEach(() => vi.unstubAllEnvs());

  const HEADERS = { "X-TTS-Key": "s3cret", "Content-Type": "application/json" };
  const TEXT = "I read convex/http.ts in full.\nVERDICT: APPROVED";
  const CHUNKS = { count: 3, read: 3, charsRead: 900, charsTotal: 900, truncatedChunks: 0, files: 4 };
  const FINDINGS = ["diff-not-fully-read: 1 of 3 chunks answered, 300 of 900 characters read"];

  function fresh() {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    return convexTest(schema, modules);
  }
  const post = (t: ReturnType<typeof convexTest>, extra: Record<string, unknown> = {}) =>
    t.fetch("/tts/audit", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ repo: "tom.quest", sha: "abc1234", text: TEXT, ...extra }),
    });
  async function auditData(t: ReturnType<typeof convexTest>) {
    const rows = await events(t, "audit-verdict");
    expect(rows).toHaveLength(1);
    return rows[0].data as Record<string, unknown>;
  }

  it("forwards a well-formed chunks, traceFindings and trace onto the row", async () => {
    const t = fresh();
    const res = await post(t, {
      chunks: CHUNKS,
      traceFindings: FINDINGS,
      trace: { available: true, reason: "3 of 3 audit runs read, 12 turns, 40 tool calls" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, verdict: "APPROVED" });
    expect(await auditData(t)).toMatchObject({
      verdict: "APPROVED",
      chunks: CHUNKS,
      traceFindings: FINDINGS,
      trace: { available: true, reason: "3 of 3 audit runs read, 12 turns, 40 tool calls" },
    });
  });

  // `trace: { available: false, reason }` with an empty findings list is the
  // COUNTED ABSENCE: nothing was checked, which must not print as a clean bill.
  it("carries a counted absence through with its reason", async () => {
    const t = fresh();
    expect((await post(t, { traceFindings: [], trace: { available: false, reason: "no run record" } })).status).toBe(200);
    expect(await auditData(t)).toMatchObject({
      traceFindings: [],
      trace: { available: false, reason: "no run record" },
    });
  });

  // BYTE-FOR-BYTE AS BEFORE: an old caller sends none of the three, and no key
  // is written for them — a pre-chunking audit is not one that read 0 of 0.
  it("still records a post carrying none of the three, and writes no key for them", async () => {
    const t = fresh();
    const res = await post(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, existing: false, verdict: "APPROVED" });
    const data = await auditData(t);
    expect(data).toMatchObject({ verdict: "APPROVED", removalNotes: [] });
    expect("chunks" in data).toBe(false);
    expect("traceFindings" in data).toBe(false);
    expect("trace" in data).toBe(false);
  });

  // The VERDICT line is still read here, and an answer carrying none is still
  // refused — the new fields changed nothing about that.
  it("still refuses an answer with no VERDICT line of its own", async () => {
    const t = fresh();
    const res = await post(t, { text: "it all looks fine to me", chunks: CHUNKS });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("VERDICT");
    expect(await events(t, "audit-verdict")).toHaveLength(0);
  });

  it("names the malformed member of chunks in a 400", async () => {
    const t = fresh();
    const refused = async (chunks: unknown, member: string) => {
      const res = await post(t, { chunks });
      expect(res.status).toBe(400);
      expect(String((await res.json()).error)).toContain(member);
    };
    await refused("three", "chunks");
    await refused([1, 2, 3], "chunks");
    await refused(null, "chunks");
    await refused({ ...CHUNKS, count: "3" }, "chunks.count");
    await refused({ ...CHUNKS, charsTotal: undefined }, "chunks.charsTotal");
    await refused({ ...CHUNKS, files: -1 }, "chunks.files");
    await refused({ ...CHUNKS, truncatedChunks: Number.POSITIVE_INFINITY }, "chunks.truncatedChunks");
    await refused({ ...CHUNKS, read: Number.NaN }, "chunks.read");
    expect(await events(t, "audit-verdict")).toHaveLength(0);
  });

  it("refuses a coverage record claiming more than there was", async () => {
    const t = fresh();
    const over = await post(t, { chunks: { ...CHUNKS, count: 3, read: 4 } });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "chunks.read cannot exceed chunks.count" });
    const wider = await post(t, { chunks: { ...CHUNKS, charsRead: 901, charsTotal: 900 } });
    expect(wider.status).toBe(400);
    expect(await wider.json()).toEqual({ error: "chunks.charsRead cannot exceed chunks.charsTotal" });
    expect(await events(t, "audit-verdict")).toHaveLength(0);
  });

  it("names traceFindings and trace in a 400 on a malformed shape", async () => {
    const t = fresh();
    const refused = async (extra: Record<string, unknown>, field: string) => {
      const res = await post(t, extra);
      expect(res.status).toBe(400);
      expect(String((await res.json()).error)).toContain(field);
    };
    await refused({ traceFindings: "one finding" }, "traceFindings");
    await refused({ traceFindings: ["fine", 7] }, "traceFindings");
    await refused({ traceFindings: { 0: "fine" } }, "traceFindings");
    await refused({ trace: "available" }, "trace");
    await refused({ trace: null }, "trace");
    await refused({ trace: [] }, "trace");
    await refused({ trace: {} }, "trace.available");
    await refused({ trace: { available: "yes" } }, "trace.available");
    await refused({ trace: { available: true, reason: 7 } }, "trace.reason");
    expect(await events(t, "audit-verdict")).toHaveLength(0);
  });
});

// ── POST /agents/ingest: the immutable record's one door ─────────────────────
const body = {
  run: {
    runId: "claude:laptop:http-run", rootRunId: "claude:laptop:http-run", depth: 0, linkKnown: true,
    origin: "unknown", host: "laptop", cli: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 1, attachments: [],
    file: { path: "C:/http.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64), bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64) },
  },
  rows: [], children: [], previousCommittedLine: 0, previousPrefixSha256: "d".repeat(64),
};
/** The same page in the wire spelling, as the box posts it to /agents/ingest;
 *  `body` itself is in the stored spelling, for the internal door. */
const { run: storedAgent, ...bodyRest } = body;
const { runId: bodyAgentId, rootRunId: bodyRootAgentId, ...bodyAgentRest } = storedAgent;
const wireBody = { ...bodyRest, agent: { ...bodyAgentRest, agentId: bodyAgentId, rootAgentId: bodyRootAgentId } };
function post(t: ReturnType<typeof convexTest>, value: unknown, key?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-Sessions-Key"] = key;
  return t.fetch("/agents/ingest", { method: "POST", headers, body: JSON.stringify(value) });
}

describe("POST /agents/ingest", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns 503 until the existing worker credential is configured", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, wireBody, "key");
    expect(response.status).toBe(503);
  });
  it("returns 401 for a wrong worker credential", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    expect((await post(t, wireBody, "wrong")).status).toBe(401);
  });
  it("returns 400 for invalid JSON", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const response = await t.fetch("/agents/ingest", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "right" }, body: "{ bad" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });
  it("accepts a well-typed page", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const response = await post(t, wireBody, "right");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runId: "claude:laptop:http-run" });
  });

  it("rejects over-limit bytes before attempting JSON parsing", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const maxBody = 6 * 200 * 32 * 1024 + 1024 * 1024;
    const response = await t.fetch("/agents/ingest", {
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
    const t = convexTest(schema, modules);
    const maxBody = 6 * 200 * 32 * 1024 + 1024 * 1024;
    const response = await t.fetch("/agents/ingest", {
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

describe("POST /agents/overflow: bounded chunks", () => {
  afterEach(() => vi.unstubAllEnvs());
  function overflowBodyAt(byteLength: number, text: string, seq: number) {
    const value: Record<string, unknown> = {
      agentId: "claude:laptop:http-run",
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
    const t = convexTest(schema, modules);
    expect((await post(t, wireBody, "right")).status).toBe(200);

    const maxBody = 6 * 256 * 1024 + 4 * 1024;
    const quoteAndSlash = '"\\'.repeat(128 * 1024);
    const controls = "\u0000".repeat(256 * 1024);
    expect(new TextEncoder().encode(quoteAndSlash)).toHaveLength(256 * 1024);
    expect(new TextEncoder().encode(controls)).toHaveLength(256 * 1024);

    const commonCase = overflowBodyAt(maxBody, quoteAndSlash, 0);
    const worstCase = overflowBodyAt(maxBody, controls, 1);
    expect(new TextEncoder().encode(commonCase)).toHaveLength(maxBody);
    expect(new TextEncoder().encode(worstCase)).toHaveLength(maxBody);
    expect((await postOverflow(t, "/agents/overflow", commonCase)).status).toBe(200);
    expect((await postOverflow(t, "/agents/overflow", worstCase)).status).toBe(200);

    const over = "{".repeat(maxBody + 1);
    expect((await postOverflow(t, "/agents/overflow", over)).status).toBe(413);
    expect((await postOverflow(t, "/agents/overflow/stamp", over)).status).toBe(413);
  });
});

describe("phase 3 agent routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps manifest reads behind the existing session worker key", async () => {
    const t = convexTest(schema, modules);
    expect((await t.fetch("/agents/manifest?since=0")).status).toBe(503);
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    expect((await t.fetch("/agents/manifest?since=0", { headers: { "X-Sessions-Key": "wrong" } })).status).toBe(401);
  });

  it("serves verified store versions as manifest entries", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const stored = await t.mutation(internal.agents.internalIngest, {
      ...body,
      run: {
        ...body.run,
        file: { ...body.run.file, storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz" },
      },
    } as never);
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true });
    const response = await t.fetch("/agents/manifest?since=0", {
      headers: { "X-Sessions-Key": "right" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [expect.objectContaining({ run_id: "claude:laptop:http-run", thread_id: "http-run", store_key: "runs/claude/laptop/http-run/stored.jsonl.gz" })],
      nextCursor: null,
    });
    const entry = (await t.query(internal.agents.internalManifest, { since: 0 })).entries[0];
    const resumed = new URLSearchParams({ since: String(entry.at), afterAgentId: entry.run_id, afterFileVersion: entry.file_version });
    const retry = await t.fetch(`/agents/manifest?${resumed}`, { headers: { "X-Sessions-Key": "right" } });
    expect(retry.status).toBe(200);
    expect((await retry.json()).entries).toEqual([]);
    expect((await t.fetch("/agents/manifest?since=0&afterAgentId=only-half", { headers: { "X-Sessions-Key": "right" } })).status).toBe(400);
    expect((await t.fetch("/agents/manifest", { headers: { "X-Sessions-Key": "right" } })).status).toBe(400);
  });
});

// ── The materialize queue's three doors ─────────────────────────────────────
// The box asks for the oldest pending request, serves it, and ANSWERS — a
// request it cannot serve is written failed with a phrase from the closed
// vocabulary, so one unreachable object never parks the queue.
describe("/agents/materialize*: the queue the box drains", () => {
  afterEach(() => vi.unstubAllEnvs());
  const KEY = { "Content-Type": "application/json", "X-Sessions-Key": "right" };
  const stored = { ...body, run: { ...body.run, file: { ...body.run.file, storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz", totalLines: 4000 } } };

  it("keeps all three doors behind the session worker key", async () => {
    const t = convexTest(schema, modules);
    expect((await t.fetch("/agents/materialize-request")).status).toBe(503);
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    expect((await t.fetch("/agents/materialize-request", { headers: { "X-Sessions-Key": "wrong" } })).status).toBe(401);
    expect((await t.fetch("/agents/materialize", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "wrong" }, body: "{}" })).status).toBe(401);
    expect((await t.fetch("/agents/materialize-answer", { method: "POST", headers: { "Content-Type": "application/json", "X-Sessions-Key": "wrong" }, body: "{}" })).status).toBe(401);
  });

  it("queues, hands over and answers one request", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    expect(await (await t.fetch("/agents/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json()).toEqual({ request: null });
    expect(await t.mutation(internal.agents.internalIngest, stored as never)).toMatchObject({ ok: true });

    const queued = await t.fetch("/agents/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ agentId: "claude:laptop:http-run" }) });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({ ok: true, slice: 1, queued: true });
    // Idempotent while it is pending.
    expect(await (await t.fetch("/agents/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ agentId: "claude:laptop:http-run" }) })).json()).toMatchObject({ queued: false });

    const handed = await t.fetch("/agents/materialize-request", { headers: { "X-Sessions-Key": "right" } });
    expect(handed.status).toBe(200);
    const { request } = await handed.json();
    expect(request).toMatchObject({ agentId: "claude:laptop:http-run", cli: "claude", host: "laptop", threadId: "http-run", slice: 1, requestedBy: "worker", hasRows: false, fromLine: 0, file: { storeKey: "runs/claude/laptop/http-run/stored.jsonl.gz", totalLines: 4000 } });

    const answer = await t.fetch("/agents/materialize-answer", {
      method: "POST", headers: KEY,
      body: JSON.stringify({
        requestId: request.requestId, status: "served", rowsIngested: 0, fromLine: 0, toLine: 4000, totalLines: 4000,
        rowsSource: { from: "store", at: 1, parserVersion: "runs-parser-1", storeKey: request.file.storeKey, rowsFromLine: 0, rowsToLine: 4000, slices: 1, droppedLines: 0, partial: ["no-envelope"] },
      }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, continuation: false });
    expect(await (await t.fetch("/agents/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json()).toEqual({ request: null });
  });

  it("refuses an agent with no store key and never reflects a payload", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, body as never)).toMatchObject({ ok: true });
    const refused = await t.fetch("/agents/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ agentId: "claude:laptop:http-run" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "agent has no store key" });
    expect((await t.fetch("/agents/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ agentId: "nope" }) })).status).toBe(400);
  });

  it("narrows every answer field before the record sees it", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, stored as never)).toMatchObject({ ok: true });
    await t.fetch("/agents/materialize", { method: "POST", headers: KEY, body: JSON.stringify({ agentId: "claude:laptop:http-run" }) });
    const { request } = await (await t.fetch("/agents/materialize-request", { headers: { "X-Sessions-Key": "right" } })).json();
    const answer = (payload: Record<string, unknown>) => t.fetch("/agents/materialize-answer", { method: "POST", headers: KEY, body: JSON.stringify({ requestId: request.requestId, status: "failed", ...payload }) });

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

// ── The agent spelling only ─────────────────────────────────────────────────
// Every door the box posts to reads the agent spelling, refuses a body that
// still carries a run-spelled key with a 400 naming both keys, and hands the
// record the stored (run) spelling only. The /runs/* paths and /tts/run-trace
// are gone. A body whose agent keys reached internalIngest's strict validator
// would be refused with a 400, so a 200 with ok: true is the proof that none
// did.
describe("the agent doors read the agent spelling only", () => {
  afterEach(() => vi.unstubAllEnvs());
  const KEY = { "Content-Type": "application/json", "X-Sessions-Key": "right" };
  const ROOT = "claude:laptop:spelling-root";
  const CHILD = "claude:laptop:spelling-root/spelling-child";
  const EARLIER = "claude:laptop:spelling-earlier";
  const FILE = { path: "C:/spelling.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64), bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64) };
  const CHILD_FILE = { ...FILE, path: "C:/spelling-child.jsonl", storedHash: "e".repeat(64) };
  const STORED_FILE = { ...FILE, storeKey: "runs/claude/laptop/spelling-root/stored.jsonl.gz" };
  const FACTS = { origin: "unknown", host: "laptop", cli: "claude", parserVersion: "runs-parser-1", status: "unknown", startedAt: 1, lastLineAt: 1, attachments: [] };
  const HELLO_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  const VOLATILE = new Set(["_id", "_creationTime", "ingestedAt", "at", "createdAt", "requestedAt", "servedAt"]);

  /** Every row of a table, without the fields a clock or an id generator sets. */
  async function stored(t: ReturnType<typeof convexTest>, table: string) {
    const rows = (await t.run(async (ctx) => ctx.db.query(table as never).collect())) as Record<string, unknown>[];
    return rows
      .map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => !VOLATILE.has(field))))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  /** The root's ingest page in the wire spelling: the root, its child edge, and the agent it continues. */
  function rootPage(rows: unknown[] = [], file: Record<string, unknown> = FILE) {
    return {
      agent: { agentId: ROOT, rootAgentId: ROOT, continuesAgentId: EARLIER, depth: 0, linkKnown: true, kind: "session", ...FACTS, file },
      rows,
      children: [{ agentId: CHILD, parentAgentId: ROOT, rootAgentId: ROOT, depth: 1, linkKnown: true, spawnedByToolUseId: "toolu-spelling" }],
      previousCommittedLine: 0,
      previousPrefixSha256: "d".repeat(64),
    };
  }
  function childPage() {
    return {
      agent: { agentId: CHILD, parentAgentId: ROOT, rootAgentId: ROOT, depth: 1, linkKnown: true, spawnedByToolUseId: "toolu-spelling", kind: "subagent", ...FACTS, file: CHILD_FILE },
      rows: [], children: [], previousCommittedLine: 0, previousPrefixSha256: "d".repeat(64),
    };
  }
  /** The same root page in the stored spelling, for the internal door. */
  function storedRootPage(rows: unknown[] = [], file: Record<string, unknown> = FILE) {
    return {
      run: { runId: ROOT, rootRunId: ROOT, continuesRunId: EARLIER, depth: 0, linkKnown: true, kind: "session", ...FACTS, file },
      rows,
      children: [{ runId: CHILD, parentRunId: ROOT, rootRunId: ROOT, depth: 1, linkKnown: true, spawnedByToolUseId: "toolu-spelling" }],
      previousCommittedLine: 0,
      previousPrefixSha256: "d".repeat(64),
    };
  }
  const ROW = {
    seq: 0, turn: 0, kind: "user", content: { text: "hello" },
    provenance: { fileVersion: FILE.storedHash, file: FILE.path, lineStart: 0, lineEnd: 0, block: 0, parserVersion: "runs-parser-1", sourceKind: "user" },
    digest: "0123456789abcdef", depth: 0, createdAt: 1,
  };
  const post = (t: ReturnType<typeof convexTest>, path: string, body: unknown) =>
    t.fetch(path, { method: "POST", headers: KEY, body: JSON.stringify(body) });
  /** A deployment holding the root in the stored spelling, through the internal door. */
  async function withRoot(rows: unknown[] = [], file: Record<string, unknown> = FILE) {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const landed = await t.mutation(internal.agents.internalIngest, storedRootPage(rows, file) as never);
    expect(landed, JSON.stringify(landed)).toMatchObject({ ok: true });
    return t;
  }
  /** A 400 that names the old key and the key that replaced it. */
  async function refusedAs(response: Response, old: string, replacement: string) {
    expect(response.status, old).toBe(400);
    expect(await response.json()).toEqual({ error: `${old} is no longer read; send ${replacement}` });
  }

  it("the /runs/* paths and /tts/run-trace answer nothing", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    for (const path of ["ingest", "overflow", "overflow/stamp", "compare", "materialize-answer", "materialize"]) {
      expect((await post(t, `/runs/${path}`, {})).status, path).toBe(404);
    }
    for (const path of ["manifest?since=0", "materialize-request"]) {
      expect((await t.fetch(`/runs/${path}`, { headers: KEY })).status, path).toBe(404);
    }
    expect((await t.fetch("/tts/run-trace?token=3f2504e0-4f89-41d3-9a0c-0305e82c3301", { headers: { "X-TTS-Key": "s3cret" } })).status).toBe(404);
  });

  it("/agents/ingest stores agents, edges and file versions in the stored spelling", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    for (const page of [rootPage(), childPage()]) {
      const response = await post(t, "/agents/ingest", page);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    }
    const tables = { runs: await stored(t, "runs"), runFileVersions: await stored(t, "runFileVersions") };
    expect(tables.runs.map((row) => row.runId)).toEqual([ROOT, CHILD]);
    expect(tables.runs[0]).toMatchObject({ continuesRunId: EARLIER });
    expect(tables.runs[1]).toMatchObject({ parentRunId: ROOT, rootRunId: ROOT, depth: 1 });
    expect(JSON.stringify(tables)).not.toMatch(/agentId|AgentId/);
  });

  it("/agents/ingest refuses a run-spelled key on the body, the agent object or a child edge", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    await refusedAs(await post(t, "/agents/ingest", storedRootPage()), "run", "agent");
    const page = rootPage();
    for (const [old, replacement] of [["runId", "agentId"], ["rootRunId", "rootAgentId"], ["continuesRunId", "continuesAgentId"], ["parentRunId", "parentAgentId"]]) {
      await refusedAs(await post(t, "/agents/ingest", { ...page, agent: { ...page.agent, [old]: ROOT } }), old, replacement);
    }
    for (const [old, replacement] of [["runId", "agentId"], ["parentRunId", "parentAgentId"], ["rootRunId", "rootAgentId"]]) {
      await refusedAs(await post(t, "/agents/ingest", { ...page, children: [{ ...page.children[0], [old]: CHILD }] }), old, replacement);
    }
    expect(await stored(t, "runs")).toEqual([]);
  });

  it("refuses an ingest whose agent id is malformed", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const page = rootPage();
    const response = await post(t, "/agents/ingest", { ...page, agent: { ...page.agent, agentId: "not-an-agent" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "agentId invalid" });
  });

  it("/agents/overflow stores a chunk under agentId and refuses runId", async () => {
    const t = await withRoot([ROW]);
    await refusedAs(await post(t, "/agents/overflow", { runId: ROOT, seq: 0, index: 0, chunkCount: 1, text: "hello world" }), "runId", "agentId");
    expect((await post(t, "/agents/overflow", { agentId: ROOT, seq: 0, index: 0, chunkCount: 1, text: "hello world" })).status).toBe(200);
    expect(await stored(t, "claudeMessageOverflow")).toEqual([expect.objectContaining({ runId: ROOT, seq: 0, text: "hello world" })]);
  });

  it("/agents/overflow/stamp stamps a row under agentId and refuses runId", async () => {
    const t = await withRoot([ROW]);
    expect((await post(t, "/agents/overflow", { agentId: ROOT, seq: 0, index: 0, chunkCount: 1, text: "hello world" })).status).toBe(200);
    await refusedAs(await post(t, "/agents/overflow/stamp", { runId: ROOT, seq: 0, sha256: HELLO_SHA256, byteLength: 11, chunkCount: 1 }), "runId", "agentId");
    const response = await post(t, "/agents/overflow/stamp", { agentId: ROOT, seq: 0, sha256: HELLO_SHA256, byteLength: 11, chunkCount: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stamped: true });
    expect((await stored(t, "claudeMessages"))[0]).toMatchObject({ overflow: { sha256: HELLO_SHA256, byteLength: 11, chunkCount: 1 } });
  });

  it("/agents/materialize queues a request under agentId and refuses runId", async () => {
    const t = await withRoot([], STORED_FILE);
    await refusedAs(await post(t, "/agents/materialize", { runId: ROOT }), "runId", "agentId");
    expect(await stored(t, "runMaterializeRequests")).toEqual([]);
    expect((await post(t, "/agents/materialize", { agentId: ROOT })).status).toBe(200);
    expect(await stored(t, "runMaterializeRequests")).toEqual([expect.objectContaining({ runId: ROOT, requestedBy: "worker", status: "pending" })]);
  });

  it("/agents/materialize-answer takes \"agent is gone\" and refuses \"run is gone\"", async () => {
    const t = await withRoot([], STORED_FILE);
    expect((await post(t, "/agents/materialize", { agentId: ROOT })).status).toBe(200);
    const { request } = await (await t.fetch("/agents/materialize-request", { headers: KEY })).json();
    const old = await post(t, "/agents/materialize-answer", { requestId: request.requestId, status: "failed", reason: "run is gone" });
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: "reason outside the closed vocabulary" });
    const response = await post(t, "/agents/materialize-answer", { requestId: request.requestId, status: "failed", reason: "agent is gone" });
    expect(response.status).toBe(200);
    expect(await stored(t, "runMaterializeRequests")).toEqual([expect.objectContaining({ status: "failed", reason: "agent is gone" })]);
  });

  it("/agents/materialize-request answers agentId and parentAgentId only", async () => {
    const t = await withRoot([], STORED_FILE);
    expect((await post(t, "/agents/materialize", { agentId: ROOT })).status).toBe(200);
    const { request } = await (await t.fetch("/agents/materialize-request", { headers: KEY })).json();
    expect(request).toMatchObject({ agentId: ROOT, parentAgentId: null });
    expect(request).not.toHaveProperty("runId");
    expect(request).not.toHaveProperty("parentRunId");
  });

  it("/agents/manifest resumes under afterAgentId and refuses afterRunId", async () => {
    const t = await withRoot([], STORED_FILE);
    const entry = (await t.query(internal.agents.internalManifest, { since: 0 })).entries[0];
    const checkpoint = { since: String(entry.at - 1), afterFileVersion: "0".repeat(64) };
    const old = await t.fetch(`/agents/manifest?${new URLSearchParams({ ...checkpoint, afterRunId: "claude:laptop:aaaaaaaa" })}`, { headers: KEY });
    await refusedAs(old, "afterRunId", "afterAgentId");
    const response = await t.fetch(`/agents/manifest?${new URLSearchParams({ ...checkpoint, afterAgentId: "claude:laptop:aaaaaaaa" })}`, { headers: KEY });
    expect(response.status).toBe(200);
    // The entries keep run_id: WikiTom stores them as written.
    expect((await response.json()).entries).toEqual([expect.objectContaining({ run_id: ROOT })]);
  });

  it("/sessions/ingest stores runId from agentId and refuses runId", async () => {
    vi.stubEnv("SESSIONS_WORKER_KEY", "right");
    const t = convexTest(schema, modules);
    const sessionId = await t.run((ctx) => ctx.db.insert("claudeSessions", {
      title: "spelling", kind: "adhoc", repo: "none", status: "running", statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(),
    }));
    await refusedAs(await post(t, "/sessions/ingest", { sessionId, runId: "claude:box:spelling-session" }), "runId", "agentId");
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.runId).toBeUndefined();
    expect((await post(t, "/sessions/ingest", { sessionId, agentId: "claude:box:spelling-session" })).status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.runId).toBe("claude:box:spelling-session");
  });

  it("/tts/code-briefs stores agentToken and refuses runToken", async () => {
    const token = "11111111-2222-4333-8444-555555555555";
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const briefsPost = (field: string) => t.fetch("/tts/code-briefs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TTS-Key": "s3cret" },
      body: JSON.stringify({
        briefs: [{ repo: "tom.quest", externalId: "spelling", sourceHash: "h", brief: "Rename the page.", recommendation: "approve", execClass: "box" }],
        [field]: token,
      }),
    });
    await refusedAs(await briefsPost("runToken"), "runToken", "agentToken");
    expect(await stored(t, "dtsCodeBriefs")).toEqual([]);
    expect((await briefsPost("agentToken")).status).toBe(200);
    expect((await stored(t, "dtsCodeBriefs")).map((row) => row.producedByRunToken)).toEqual([token]);
  });

  it("/tts/simplify-input answers agents, each sample's agentId, and .agents alone on tools, hooks and cwds", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = await withRoot();
    await t.run((ctx) => ctx.db.insert("modelOfTomPublication", {
      key: "current", commit: "testprelude", committedAt: 1, pushed: true, operate: "o", write: "w", know: "k",
      headers: ([["operate"], ["write"], ["know"], ["operate", "write"], ["operate", "know"], ["write", "know"], ["operate", "write", "know"]] as const)
        .map((names) => ({ layers: [...names], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude): ${names.join(",")}` })),
    }));
    const response = await t.fetch("/tts/simplify-input?until=10", { headers: { "X-TTS-Key": "s3cret" } });
    expect(response.status).toBe(200);
    const facts = await response.json();
    expect(facts.agents).toMatchObject({ total: 2 });
    expect(facts).not.toHaveProperty("runs");
    // The root and the stub its child edge wrote.
    expect(facts.sample.map((one: { agentId: string }) => one.agentId).sort()).toEqual([ROOT, CHILD]);
    for (const one of facts.sample) expect(one).not.toHaveProperty("runId");
    expect(facts.cwds.length).toBeGreaterThan(0);
    for (const row of [...facts.tools, ...facts.hooks, ...facts.cwds]) {
      expect(typeof row.agents).toBe("number");
      expect(row).not.toHaveProperty("runs");
    }
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
  const TOKEN = "8f14e45f-ceea-467a-9a36-dedd4bea2543"; // gitleaks:allow
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
        host: "box", cli: "claude", environment: "worker", parserVersion: "runs-parser-1", kind: "job", status: "ended",
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
          content: { text: row.text }, provenance: ROW_PROVENANCE, createdAt: 1_757_000_000_000 + row.seq,
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
      const { items } = (await res.json()) as { items: { rows: { contextRow: unknown; spanRows: unknown[] } }[] };
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
        { items: Record<string, unknown>[] };
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

    // THE ROUTE IS THE SHAPE ablationFindings MUST EMIT. Its argument check is
    // an exact object, so a finding carrying one extra field takes the whole
    // request down — the unearned names AND the graduated cases, which ride
    // together — and #tts-decisions hears nothing that week. The gather keys on
    // the kind and deliberately does not put it on the finding; this is the
    // test that says so from the route's side.
    it("refuses a finding carrying a field the check does not list", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const withKind = await post(t, {
        isoWeek: "2026-W37",
        ablation: [{ name: "know", kind: "layer", cases: 7, withPass: 5, withoutPass: 6, earned: false }],
      });
      expect(withKind.status).toBe(400);
      // And exactly what ablationFindings emits goes through.
      const asEmitted = await post(t, {
        isoWeek: "2026-W37",
        ablation: ablationFindings(Array.from({ length: MIN_ABLATION_CASES }, (_, i) => (
          { id: `c${i}`, name: "know", kind: "layer", withPass: true, withoutPass: false }
        ))),
      });
      expect(asEmitted.status).toBe(200);
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

// ── POST /tts/evals-request takes either key ─────────────────────────────────
// CI posts with the narrow evals key. The box checks Heffnt/Jarvis's pull
// requests itself, with no GitHub Actions, and posts with the worker key it
// already holds, so the route takes that key the way POST /tts/tests does.
describe("POST /tts/evals-request: either key", () => {
  afterEach(() => vi.unstubAllEnvs());

  const REQUEST = { repo: "Jarvis", sha: "abc1234", paths: ["jobs/evals.mjs"] };
  function fresh() {
    vi.stubEnv("TTS_WORKER_KEY", "worker-s3cret");
    vi.stubEnv("EVALS_KEY", "evals-s3cret");
    return convexTest(schema, modules);
  }
  const post = (t: ReturnType<typeof convexTest>, headers: Record<string, string>) =>
    t.fetch("/tts/evals-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(REQUEST),
    });

  it("accepts the worker key and records the request", async () => {
    const t = fresh();
    const res = await post(t, { "X-TTS-Key": "worker-s3cret" });
    expect(res.status).toBe(200);
    const rows = await events(t, "evals-request");
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ repo: "Jarvis", sha: "abc1234" });
  });

  it("still accepts the evals key", async () => {
    const t = fresh();
    const res = await post(t, { "X-Evals-Key": "evals-s3cret" });
    expect(res.status).toBe(200);
    expect(await events(t, "evals-request")).toHaveLength(1);
  });

  it("refuses a request with neither key, or a wrong worker key, and records nothing", async () => {
    const t = fresh();
    expect((await post(t, {})).status).toBe(401);
    expect((await post(t, { "X-TTS-Key": "evals-s3cret" })).status).toBe(401);
    expect(await events(t, "evals-request")).toEqual([]);
  });
});
