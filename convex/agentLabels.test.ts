import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { REACTION_POLARITY, baseEmoji, meaningFault, plainMeaning } from "./agentLabels";
import { parseConfirmReply } from "./ttsSlack";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const SOURCE_HASH = "a".repeat(64);
const STORED_HASH = "b".repeat(64);
const PREFIX_HASH = "c".repeat(64);

/** A `runs` row with the two fields every label resolver reads — the token the
 *  producing row carries, and the seq of the final text a judgment is about. */
async function seedRun(
  t: ReturnType<typeof convexTest>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const runId = (over.runId as string) ?? "claude:box:the-run";
  await t.run((ctx) =>
    ctx.db.insert("runs", {
      runId,
      rootRunId: runId,
      depth: 0,
      linkKnown: true,
      origin: "cron:plan-graphs",
      host: "box",
      cli: "claude",
      environment: "worker",
      parserVersion: "runs-parser-1",
      kind: "job",
      status: "ended",
      startedAt: 1_000,
      lastLineAt: 2_000,
      attachments: [],
      outcome: {
        finalTextSeq: 7,
        totals: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheWriteBreakdownKnown: true,
          outputTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
        },
        turns: 1,
        toolCalls: 0,
      },
      file: {
        path: "/var/log/run.jsonl",
        sourceHash: SOURCE_HASH,
        storedHash: STORED_HASH,
        bytes: 10,
        storedBytes: 8,
        committedLine: 1,
        committedPrefixSha256: PREFIX_HASH,
      },
      ingestedAt: 3_000,
      ...over,
    } as never),
  );
  return runId;
}

async function seedTodo(
  t: ReturnType<typeof convexTest>,
  over: Record<string, unknown> = {},
): Promise<Id<"dtsTodos">> {
  return await t.run((ctx) =>
    ctx.db.insert("dtsTodos", {
      statement: "renew the visa",
      readiness: "prepared",
      status: "active",
      timingClass: "whenever",
      source: "planner",
      createdAt: 1,
      updatedAt: 1,
      ...over,
    } as never),
  );
}

async function seedRuling(
  t: ReturnType<typeof convexTest>,
  over: Record<string, unknown>,
): Promise<Id<"rulings">> {
  return await t.run((ctx) =>
    ctx.db.insert("rulings", {
      subjectType: "life",
      verdict: "approve",
      ruledAt: 5_000,
      ...over,
    } as never),
  );
}

async function labels(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("runLabels").collect());
}

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === kind),
  );
}

const label = (over: Record<string, unknown> = {}) => ({
  runId: "claude:box:the-run",
  source: "ruling" as const,
  actor: "tom",
  polarity: "good" as const,
  meaning: "Tom approved this output",
  judgment: true,
  ref: "ruling:one",
  at: 6_000,
  ...over,
});

// ── The writer ───────────────────────────────────────────────────────────────

describe("the one writer", () => {
  it("writes one row per ref, however often the act is replayed", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.agentLabels.internalWriteLabel, label());
    const second = await t.mutation(internal.agentLabels.internalWriteLabel, label({
      // A redelivery carries the same act and may differ in everything else;
      // the ref is what decides, and the first row stands.
      polarity: "bad",
      meaning: "Tom sent this output back",
    }));
    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].polarity).toBe("good");
  });

  it("refuses an actor that is not Tom", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.agentLabels.internalWriteLabel, label({ actor: "agent" })),
    ).rejects.toThrow(/must be "tom"/);
    expect(await labels(t)).toHaveLength(0);
  });

  it("refuses a meaning carrying a date or a quote mark", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.agentLabels.internalWriteLabel, label({
        meaning: "Tom approved this on 2026-09-11",
      })),
    ).rejects.toThrow(/date/);
    await expect(
      t.mutation(internal.agentLabels.internalWriteLabel, label({
        ref: "ruling:two",
        meaning: 'Tom said "do it again"',
      })),
    ).rejects.toThrow(/quote mark/);
    expect(await labels(t)).toHaveLength(0);
    // The fault is named rather than silently rewritten: his sentence is his.
    expect(meaningFault("plain present tense")).toBeNull();
    // Only text of his OWN typing is made safe, and never by changing what it
    // says — the marks go, a bare date becomes the word.
    expect(plainMeaning('leave it until 2026-09-11, "please"')).toBe(
      "leave it until a date, please",
    );
  });
});

// ── A ruling ─────────────────────────────────────────────────────────────────

describe("a ruling becomes a label", () => {
  it("gives each verdict its own polarity and judgment", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-life" });
    const seen: Record<string, { polarity: string; judgment: boolean }> = {};
    for (const verdict of ["approve", "revise", "session", "archive"] as const) {
      const todoId = await seedTodo(t, { producedByRunToken: "tok-life" });
      const rulingId = await seedRuling(t, {
        todoId,
        verdict,
        sentence: verdict === "revise" ? "say what it costs" : undefined,
      });
      await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
      const row = (await labels(t)).find((one) => one.ref === `ruling:${rulingId}`)!;
      seen[verdict] = { polarity: row.polarity, judgment: row.judgment };
    }
    expect(seen).toEqual({
      approve: { polarity: "good", judgment: true },
      revise: { polarity: "bad", judgment: true },
      // Recorded, and NOT judgments: neither says the text was good or bad, so
      // neither enters the corpus an eval case is mined from.
      session: { polarity: "neutral", judgment: false },
      archive: { polarity: "neutral", judgment: false },
    });
  });

  it("keeps Tom's own sentence as the meaning on a revise", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-life" });
    const todoId = await seedTodo(t, { producedByRunToken: "tok-life" });
    const rulingId = await seedRuling(t, {
      todoId,
      verdict: "revise",
      sentence: "this reads like a status report",
    });
    await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
    expect((await labels(t))[0].meaning).toBe("this reads like a status report");
  });

  it("names the run and the row its final text landed on", async () => {
    const t = convexTest(schema, modules);
    const runId = await seedRun(t, { regToken: "tok-life", runId: "claude:box:prepare-pass" });
    const todoId = await seedTodo(t, { producedByRunToken: "tok-life" });
    const rulingId = await seedRuling(t, { todoId, verdict: "approve" });
    await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe(runId);
    // The span a judgment about a run's FINAL OUTPUT covers: the one row that
    // carried it, at both ends.
    expect(rows[0].rowSpan).toEqual({ seqStart: 7, seqEnd: 7 });
    expect(rows[0].at).toBe(5_000);
  });

  it("writes one row when the same ruling is scheduled twice", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-life" });
    const todoId = await seedTodo(t, { producedByRunToken: "tok-life" });
    const rulingId = await seedRuling(t, { todoId, verdict: "approve" });
    await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
    const second = await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
    expect(second).toMatchObject({ wrote: false });
    expect(await labels(t)).toHaveLength(1);
  });

  it("counts the act when the subject carries no token, and writes no label", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-life" });
    const todoId = await seedTodo(t);
    const rulingId = await seedRuling(t, { todoId, verdict: "approve" });
    await t.mutation(internal.agentLabels.internalLabelFromRuling, { rulingId });
    expect(await labels(t)).toHaveLength(0);
    // Counted, never silent: an uncounted absence would make an old corpus
    // look like a clean one.
    const unlinked = await events(t, "agent-label-unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].data).toMatchObject({
      source: "ruling",
      ref: `ruling:${rulingId}`,
      subjectKey: `life ${todoId}`,
    });
  });

});

// ── An objection ─────────────────────────────────────────────────────────────

/** A delegate decision (or a merge) as the objection resolver finds it: keyed
 *  by the askId, carrying the run that took it. */
async function seedDecision(
  t: ReturnType<typeof convexTest>,
  kind: string,
  askId: string,
  data: Record<string, unknown>,
) {
  await t.run((ctx) =>
    ctx.db.insert("dtsEvents", { at: 4_000, kind, key: askId, data }),
  );
}

async function seedObjection(
  t: ReturnType<typeof convexTest>,
  askId: string,
  data: Record<string, unknown>,
): Promise<Id<"dtsEvents">> {
  return await t.run((ctx) =>
    ctx.db.insert("dtsEvents", {
      at: 6_000,
      kind: "delegate-objection",
      key: askId,
      data: { askId, ...data },
    }),
  );
}

describe("an objection becomes a label", () => {
  it("reads a revert and a redirect sentence alike as bad", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-ask" });
    await seedDecision(t, "delegate-decision", "ask-1", { runToken: "tok-ask" });
    await seedDecision(t, "delegate-decision", "ask-2", { runToken: "tok-ask" });
    const reverted = await seedObjection(t, "ask-1", { revert: true, sentence: null });
    const redirected = await seedObjection(t, "ask-2", {
      revert: false,
      sentence: "wait for the merge gate instead",
    });
    await t.mutation(internal.agentLabels.internalLabelFromObjection, {
      eventId: reverted,
      askId: "ask-1",
    });
    await t.mutation(internal.agentLabels.internalLabelFromObjection, {
      eventId: redirected,
      askId: "ask-2",
    });
    const rows = await labels(t);
    expect(rows.map((one) => one.polarity)).toEqual(["bad", "bad"]);
    expect(rows.every((one) => one.judgment)).toBe(true);
    // The distinction is what to do next, and it lives in the meaning.
    expect(rows.map((one) => one.meaning)).toEqual([
      "Tom reverted this decision",
      "wait for the merge gate instead",
    ]);
  });

  it("resolves a merge objection through the merge row's token", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-merge", runId: "claude:box:merge-run" });
    await seedDecision(t, "merge", "tom.quest:abc123", { runToken: "tok-merge" });
    const eventId = await seedObjection(t, "tom.quest:abc123", { revert: true, sentence: null });
    await t.mutation(internal.agentLabels.internalLabelFromObjection, {
      eventId,
      askId: "tom.quest:abc123",
    });
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("claude:box:merge-run");
    expect(rows[0].source).toBe("objection");
  });

  // witness: the label writer and the ask context read only the legacy
  // dtsEvents rows, so a revert of a decision only the record holds was
  // unlinked, and the next delegate asked about its todo saw no decision.
  it("resolves a decision only the record holds, for the label and for the next ask's context", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-decide", runId: "claude:box:decide-run" });
    const todoId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "renew passport", status: "active", readiness: "prepared", timingClass: "whenever",
        source: "tom", createdAt: 1, updatedAt: 1,
      }),
    );
    // The row as POST /jarvis/event stores a delegate's decision: the askId
    // as the subject, the agent that decided as provenance.agentId, and the
    // body Jarvis worker/jobs/delegate.mjs sends. No runToken: the record
    // links a row to its run by the agent id.
    await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "decision", at: 1_000, provenance: { agentId: "claude:box:decide-run", job: "delegate" }, subject: "rec-1",
        data: {
          question: "Which day?", options: ["Thursday", "Friday"], decision: "Thursday", reason: "His calendar is free.",
          restedOn: [], wouldChange: null, refused: false, refusedBecause: null, caller: "job:prepare", askId: "rec-1",
          todoId, model: "claude-opus-5", nearMissed: [],
        },
      }),
    );
    const eventId = await t.mutation(internal.ttsAsk.internalRecordDelegateObjection, {
      askId: "rec-1", text: "revert 1", revert: true, sentence: null, channel: "C", ts: "1.2", threadTs: "1.1",
    });
    await t.mutation(internal.agentLabels.internalLabelFromObjection, { eventId, askId: "rec-1" });
    expect((await labels(t)).map((row) => row.runId)).toEqual(["claude:box:decide-run"]);
    const context = await t.query(internal.ttsAsk.internalAskContext, { job: "prepare", todoId });
    expect(context.priorObjections).toMatchObject([{ askId: "rec-1", revert: true, decision: "Thursday" }]);
  });

  it("writes nothing and throws nothing when no decision row carries the askId", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-ask" });
    const eventId = await seedObjection(t, "ask-missing", { revert: true, sentence: null });
    const result = await t.mutation(internal.agentLabels.internalLabelFromObjection, {
      eventId,
      askId: "ask-missing",
    });
    expect(result).toMatchObject({ wrote: false, why: "unlinked" });
    expect(await labels(t)).toHaveLength(0);
    expect((await events(t, "agent-label-unlinked"))[0].data).toMatchObject({
      why: "no decision or merge row carries this askId",
    });
  });
});

// ── A reply in a session ─────────────────────────────────────────────────────

async function seedSession(
  t: ReturnType<typeof convexTest>,
  over: Record<string, unknown> = {},
): Promise<Id<"claudeSessions">> {
  return await t.run((ctx) =>
    ctx.db.insert("claudeSessions", {
      title: "the visa run",
      kind: "adhoc",
      repo: "none",
      status: "running",
      statusChangedAt: 1,
      nextSeq: 0,
      createdAt: 1,
      ...over,
    } as never),
  );
}

async function seedTomTurn(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"claudeSessions">,
  over: Record<string, unknown> = {},
): Promise<Id<"claudeInbound">> {
  return await t.run((ctx) =>
    ctx.db.insert("claudeInbound", {
      sessionId,
      kind: "user-turn",
      text: "no, do the visa one first",
      author: "tom",
      status: "done",
      createdAt: 9_000,
      ...over,
    } as never),
  );
}

// The agent file's side: one page of a box root run's rows, in the shape the
// sweep posts to agents.internalIngest.
const SESSION_RUN = "claude:box:session-root-run";
function fileRun(runId = SESSION_RUN, over: Record<string, unknown> = {}) {
  return {
    runId, rootRunId: runId, depth: 0, linkKnown: true, origin: "daemon", host: "box", cli: "claude",
    environment: "session", parserVersion: "runs-parser-1", kind: "session", status: "running",
    startedAt: 1_000, lastLineAt: 2_000, attachments: [],
    file: { path: "/home/jarvis/.claude/projects/x/session.jsonl", sourceHash: SOURCE_HASH, storedHash: STORED_HASH, bytes: 10, storedBytes: 8, committedLine: 3, committedPrefixSha256: PREFIX_HASH },
    ...over,
  };
}
function fileRow(seq: number, kind: string, text: string, depth = 0) {
  return {
    seq, turn: 1, kind, content: { text }, depth, createdAt: 5_000 + seq,
    digest: seq.toString(16).padStart(16, "0"),
    provenance: { fileVersion: STORED_HASH, file: "/home/jarvis/.claude/projects/x/session.jsonl", lineStart: seq, lineEnd: seq, block: 0, parserVersion: "runs-parser-1", sourceKind: kind },
  };
}
async function ingestFile(
  t: ReturnType<typeof convexTest>,
  run: ReturnType<typeof fileRun>,
  rows: ReturnType<typeof fileRow>[],
  previous: { line: number; hash: string } = { line: 0, hash: "d".repeat(64) },
) {
  const result = await t.mutation(internal.agents.internalIngest, {
    run, rows, children: [], previousCommittedLine: previous.line, previousPrefixSha256: previous.hash,
  } as never);
  expect(result).toMatchObject({ ok: true });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}
const delivered = (text: string, inboundId: string) => `${text}\n\ninbound row: ${inboundId}`;

describe("a reply in a session becomes a label", () => {
  it("is never a judgment, and spans from the assistant row it answers", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);
    const inboundId = await seedTomTurn(t, sessionId);
    await seedRun(t, { regToken: "tok-session", runId: "claude:box:session-run", sessionId });
    await t.mutation(internal.agentLabels.internalLabelFromSessionReply, {
      runId: "claude:box:session-run",
      inboundId,
      seq: 12,
      text: "that is not what I asked for",
      at: 9_000,
      priorAssistantSeq: 9,
    });
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    // Phase 7 builds no classifier: a reply is not a judgment until something
    // classifies it as one, and a model's opinion of his tone must not enter
    // the corpus.
    expect(rows[0]).toMatchObject({
      source: "session-reply",
      judgment: false,
      polarity: "neutral",
      runId: "claude:box:session-run",
      rowSpan: { seqStart: 9, seqEnd: 12 },
      meaning: "that is not what I asked for",
      ref: `reply:${inboundId}`,
    });
  });

  it("carries no span when nothing was said before it", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);
    const inboundId = await seedTomTurn(t, sessionId);
    await seedRun(t, { regToken: "tok-session", sessionId });
    await t.mutation(internal.agentLabels.internalLabelFromSessionReply, {
      runId: "claude:box:the-run",
      inboundId,
      seq: 0,
      text: "start with the passport one",
      at: 9_000,
    });
    // Never {0, 0}, which would read as the whole run.
    expect((await labels(t))[0].rowSpan).toBeUndefined();
  });

  it("writes when the agent file's user row of a turn Tom typed lands, once", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const sessionId = await seedSession(t, { runId: SESSION_RUN });
      const inboundId = await seedTomTurn(t, sessionId);
      await ingestFile(t, fileRun(), [
        fileRow(10, "assistant-text", "which one first?"),
        fileRow(20, "user", delivered("no, do the visa one first", inboundId)),
      ]);
      const rows = await labels(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "session-reply",
        runId: SESSION_RUN,
        ref: `reply:${inboundId}`,
        // His words alone, off the inbound row — not the id line the model saw.
        meaning: "no, do the visa one first",
        // In the run's own seq space: the assistant row before it to its row.
        rowSpan: { seqStart: 10, seqEnd: 20 },
        at: 9_000,
      });

      // A later page of the same file lands more rows; the turn is one act.
      await ingestFile(
        t,
        fileRun(SESSION_RUN, { file: { ...fileRun().file, bytes: 20, committedLine: 4, committedPrefixSha256: "e".repeat(64) } }),
        [fileRow(20, "user", delivered("no, do the visa one first", inboundId)), fileRow(30, "assistant-text", "on it")],
        { line: 3, hash: PREFIX_HASH },
      );
      expect(await labels(t)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // witness: key the dedupe on the new ref alone, and a sweep of an old
  // session's agent file records every turn the old writer already labelled
  // a second time.
  it("writes nothing for a turn the old writer labelled under the session's own key", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const sessionId = await seedSession(t, { runId: SESSION_RUN, status: "ended" });
      const inboundId = await seedTomTurn(t, sessionId);
      await t.mutation(internal.agentLabels.internalWriteLabel, {
        runId: SESSION_RUN, source: "session-reply", actor: "tom", polarity: "neutral",
        meaning: "no, do the visa one first", judgment: false, ref: `reply:${sessionId}:7`, at: 9_000,
        rowSpan: { seqStart: 5, seqEnd: 7 },
      });
      await ingestFile(t, fileRun(), [fileRow(20, "user", delivered("no, do the visa one first", inboundId))]);
      expect((await labels(t)).map((row) => row.ref)).toEqual([`reply:${sessionId}:7`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing for an agent's own turn", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const sessionId = await seedSession(t, { runId: SESSION_RUN });
      const inboundId = await seedTomTurn(t, sessionId, { author: "agent", text: "continue with the next item" });
      await ingestFile(t, fileRun(), [fileRow(20, "user", delivered("continue with the next item", inboundId))]);
      expect(await labels(t)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // witness: trust the line alone and any run whose prompt quotes a turn of
  // Tom's — a fork reading the old transcript, an agent handed the text —
  // writes a label about ITS output for a reply he made to another run.
  it("writes nothing for a copied inbound row line in another run's prompt", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const sessionId = await seedSession(t, { runId: SESSION_RUN });
      const inboundId = await seedTomTurn(t, sessionId);
      const copied = delivered("no, do the visa one first", inboundId);
      // Another root run on the box, which no session names.
      await ingestFile(t, fileRun("claude:box:some-other-run"), [fileRow(20, "user", copied)]);
      // The session's own run's subagent, whose prompt carries the line.
      await ingestFile(
        t,
        fileRun(`${SESSION_RUN}/agent-subagent-1`, {
          parentRunId: SESSION_RUN, rootRunId: SESSION_RUN, depth: 1, kind: "subagent", spawnedByToolUseId: "toolu-1",
          file: { ...fileRun().file, path: "/home/jarvis/.claude/projects/x/subagent.jsonl" },
        }),
        [fileRow(20, "user", copied, 1)],
      );
      expect(await labels(t)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── A reaction on the morning ────────────────────────────────────────────────

async function seedDigestSent(
  t: ReturnType<typeof convexTest>,
  data: Record<string, unknown>,
) {
  // A morning a model wrote: its digest-sent row in dtsEvents, with the
  // writing run's token. The resolver takes the newest rows of the kind and
  // finds the one posted at that ts.
  await t.run((ctx) =>
    ctx.db.insert("dtsEvents", { at: 5_000, kind: "digest-sent", data }),
  );
}

const reaction = (over: Record<string, unknown> = {}) => ({
  channel: "C-today",
  ts: "1757500000.0001",
  emoji: "+1",
  at: 8_000,
  removed: false,
  ...over,
});

describe("a reaction on the morning becomes a label", () => {
  it("gives each mapped emoji its own polarity and judgment", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-morning", runId: "claude:box:write-slack" });
    await seedDigestSent(t, { day: "2026-09-11", writtenBy: "fable", runToken: "tok-morning", slackTs: "1757500000.0001" });
    for (const emoji of Object.keys(REACTION_POLARITY)) {
      await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji }));
    }
    const rows = await labels(t);
    expect(rows).toHaveLength(Object.keys(REACTION_POLARITY).length);
    for (const row of rows) {
      const name = row.ref.split(":").pop()!;
      expect({ polarity: row.polarity, judgment: row.judgment }).toEqual(
        REACTION_POLARITY[name],
      );
      expect(row.runId).toBe("claude:box:write-slack");
      expect(row.source).toBe("digest-reaction");
    }
  });

  // The box's digest is deterministic: no run wrote it, so a reaction on it
  // labels nothing, and the record's digest-sent rows are not looked up.
  it("labels nothing for a reaction on a digest the box wrote", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-box" });
    await t.run((ctx) =>
      ctx.db.insert("events", { at: 5_000, kind: "digest-sent", provenance: { job: "digest" }, subject: "2026-09-26", data: { day: "2026-09-26", ts: "1757500000.0001" } }),
    );
    expect(await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "+1" }))).toMatchObject({ wrote: false });
    expect(await labels(t)).toHaveLength(0);
  });

  it("reads a skin-toned thumb as the thumb that was tapped", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-morning" });
    await seedDigestSent(t, { day: "2026-09-11", writtenBy: "fable", runToken: "tok-morning", slackTs: "1757500000.0001" });
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "+1::skin-tone-3" }));
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].ref.endsWith(":+1")).toBe(true);
    expect(rows[0].polarity).toBe("good");
    expect(baseEmoji("+1::skin-tone-3")).toBe("+1");
  });

  it("records an emoji nobody mapped and guesses no polarity for it", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-morning" });
    await seedDigestSent(t, { day: "2026-09-11", writtenBy: "fable", runToken: "tok-morning", slackTs: "1757500000.0001" });
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "thinking_face" }));
    expect(await labels(t)).toHaveLength(0);
    // What he reaches for is worth having; guessing what it meant is not.
    expect((await events(t, "reaction-unmapped"))[0].data).toMatchObject({
      emoji: "thinking_face",
    });
  });

  it("writes no label for a morning the plain template wrote", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-morning" });
    await seedDigestSent(t, { day: "2026-09-11", writtenBy: "template", slackTs: "1757500000.0001" });
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction());
    expect(await labels(t)).toHaveLength(0);
    const unlinked = await events(t, "agent-label-unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].data).toMatchObject({
      source: "digest-reaction",
      subjectKey: "digest:2026-09-11",
      why: "the morning was written by the plain template, which is not an agent's output",
    });
  });

  it("deletes exactly its own ref when the reaction is taken back", async () => {
    const t = convexTest(schema, modules);
    await seedRun(t, { regToken: "tok-morning" });
    await seedDigestSent(t, { day: "2026-09-11", writtenBy: "fable", runToken: "tok-morning", slackTs: "1757500000.0001" });
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "+1" }));
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "tada" }));
    await t.mutation(internal.agentLabels.internalLabelFromReaction, reaction({ emoji: "+1", removed: true }));
    const rows = await labels(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].ref.endsWith(":tada")).toBe(true);
  });
});

// ── "confirm <id>" ───────────────────────────────────────────────────────────

describe("the confirmation grammar", () => {
  it("reads the anchored form, one id or several", () => {
    expect(parseConfirmReply("confirm run-ruling-8fb2d10a4c3e")).toEqual([
      "run-ruling-8fb2d10a4c3e",
    ]);
    expect(
      parseConfirmReply("Confirm run-ruling-8fb2d10a4c3e  explanations-todo-k97x2m4bq1zp"),
    ).toEqual(["run-ruling-8fb2d10a4c3e", "explanations-todo-k97x2m4bq1zp"]);
    expect(parseConfirmReply("confirm run-ruling-8fb2d10a4c3e\n")).toEqual([
      "run-ruling-8fb2d10a4c3e",
    ]);
  });

  it("is not a confirmation when the reply merely contains the word", () => {
    expect(parseConfirmReply("I'll confirm run-ruling-8fb2d10a4c3e tomorrow")).toEqual([]);
    expect(parseConfirmReply("nothing to confirm here")).toEqual([]);
    expect(parseConfirmReply("confirmed run-ruling-8fb2d10a4c3e")).toEqual([]);
    expect(parseConfirmReply("2: leave it Wednesday")).toEqual([]);
  });
});
