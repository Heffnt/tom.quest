// ONE TRANSCRIPT PATH (Tom's ruling of 2026-09-25): a session's rows are its
// agent file's. These cases hold every reader of a session's rows to the one
// switch (sessionRows.rowSource), and the pieces that exist because the
// daemon writes no rows: the notes, the delivered turn that is not a row yet,
// the newest landed row on the poll, the overflow reader on a file row, and
// the one-off relink of the Codex sessions named under the Claude family.

import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { inboundRowIdOf } from "./sessionRows";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const RUN = "claude:box:file-backed-session";

async function withTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  over: Record<string, unknown> = {},
): Promise<Id<"claudeSessions">> {
  return await t.run((ctx) =>
    ctx.db.insert("claudeSessions", {
      title: "a file-backed session",
      kind: "adhoc",
      repo: "none",
      status: "running",
      statusChangedAt: 1,
      nextSeq: 0,
      createdAt: 1,
      runId: RUN,
      rowsFrom: "runs",
      ...over,
    } as never),
  );
}

async function fileRow(
  t: ReturnType<typeof convexTest>,
  seq: number,
  kind: string,
  content: unknown,
  runId = RUN,
) {
  return await t.run((ctx) =>
    ctx.db.insert("claudeMessages", {
      runId, seq, turn: 1, kind, content, depth: 0, digest: "0123456789abcdef", createdAt: 10_000 + seq,
    } as never),
  );
}

async function daemonRow(t: ReturnType<typeof convexTest>, sessionId: Id<"claudeSessions">, seq: number, text: string) {
  await t.run((ctx) =>
    ctx.db.insert("claudeMessages", { sessionId, seq, turn: 0, kind: "assistant-text", content: { text }, createdAt: seq + 1 } as never),
  );
}

describe("the inbound row line", () => {
  it("reads the id off the last line of a delivered turn, and nothing else", () => {
    expect(inboundRowIdOf({ text: "do the visa one\n\ninbound row: k17abc_def" })).toBe("k17abc_def");
    expect(inboundRowIdOf("do the visa one\n\ninbound row: k17abc\n")).toBe("k17abc");
    // Not the last line: the turn quotes the line rather than ending with it.
    expect(inboundRowIdOf({ text: "inbound row: k17abc\n\nand more" })).toBeNull();
    expect(inboundRowIdOf({ text: "no line at all" })).toBeNull();
    expect(inboundRowIdOf({ input: "x" })).toBeNull();
  });
});

describe("a session since the cutover reads its agent file's rows", () => {
  // witness: page the fork transcript by sessionId alone and a fork of any
  // session since the cutover opens with an empty .tts-transcript.md.
  it("gives the fork transcript the file's rows, oldest first, in the parser's shape", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);
    await daemonRow(t, sessionId, 0, "a daemon row, stored before the cutover");
    await fileRow(t, 100, "user", { text: "hello" });
    await fileRow(t, 200, "tool-call", { id: "toolu_1", name: "Read", input: { file_path: "a.ts" } });
    await fileRow(t, 300, "tool-result", { toolUseId: "toolu_1", content: "file body" });
    const page = await t.query(internal.claudeSessions.internalTranscriptPage, { sessionId });
    expect(page.nextCursor).toBeNull();
    expect(page.rows.map((row) => row.seq)).toEqual([100, 200, 300]);
    expect(page.rows[1].content).toEqual({ id: "toolu_1", name: "Read", input: { file_path: "a.ts" } });
  });

  it("gives an empty fork transcript and an empty page while the run is not named", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t, { runId: undefined });
    await daemonRow(t, sessionId, 0, "must not stand in for the file");
    expect(await t.query(internal.claudeSessions.internalTranscriptPage, { sessionId })).toEqual({ rows: [], nextCursor: null });
    const tom = await withTom(t);
    const page = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(page.page).toEqual([]);
  });

  it("keeps reading a session from before the cutover by its own id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t, { rowsFrom: undefined });
    await daemonRow(t, sessionId, 0, "the daemon's row");
    await fileRow(t, 100, "assistant-text", { text: "the file's row" });
    const page = await t.query(internal.claudeSessions.internalTranscriptPage, { sessionId });
    expect(page.rows.map((row) => row.content)).toEqual([{ text: "the daemon's row" }]);
  });
});

describe("Tom's delivered turn stays on the page until its row lands", () => {
  async function turn(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"claudeSessions">,
    status: "pending" | "delivered" | "done",
    over: Record<string, unknown> = {},
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("claudeInbound", {
        sessionId, kind: "user-turn", text: "do the visa one first", author: "tom", status, createdAt: 5_000, ...over,
      } as never),
    );
  }

  // witness: return pending rows only and Tom's words vanish from the page
  // for the whole turn: the daemon marks the turn delivered at once, and the
  // file's row for it lands only when the turn ends.
  it("returns the delivered turn beside the pending ones, then drops it when its row lands", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const sessionId = await seedSession(t);
    const delivered = await turn(t, sessionId, "delivered");
    const queued = await turn(t, sessionId, "pending", { text: "and then the lease", createdAt: 6_000 });
    const before = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    expect(before.map((row) => row._id)).toEqual([delivered, queued]);

    // The turn ends; the daemon marks it done before the sweep has landed it.
    await t.run((ctx) => ctx.db.patch(delivered, { status: "done" }));
    expect((await tom.query(api.claudeSessions.getPendingInbound, { sessionId })).map((row) => row._id)).toEqual([delivered, queued]);

    await fileRow(t, 100, "user", { text: `do the visa one first\n\ninbound row: ${delivered}` });
    expect((await tom.query(api.claudeSessions.getPendingInbound, { sessionId })).map((row) => row._id)).toEqual([queued]);
  });

  it("shows no agent's turn, and nothing but pending rows on a session from before the cutover", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const fileBacked = await seedSession(t);
    await turn(t, fileBacked, "delivered", { author: "agent" });
    expect(await tom.query(api.claudeSessions.getPendingInbound, { sessionId: fileBacked })).toEqual([]);

    const old = await seedSession(t, { rowsFrom: undefined, runId: undefined });
    await turn(t, old, "delivered");
    expect(await tom.query(api.claudeSessions.getPendingInbound, { sessionId: old })).toEqual([]);
  });
});

describe("the daemon's notes", () => {
  // witness: write notes as rows and they vanish with the daemon's rows — the
  // agent file is the only source of rows, and none of these facts is in it.
  it("stores each note once, cut to 1 KB, even on a session that has ended", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const sessionId = await seedSession(t, { status: "ended" });
    const long = `push failed: ${"é".repeat(2000)}`;
    const payload = {
      sessionId,
      notes: [
        { at: 2_000, text: "model changed to sonnet" },
        { at: 1_000, text: "workspace rebuilt" },
        { at: 3_000, text: long },
      ],
    };
    await t.mutation(internal.claudeSessions.internalIngest, payload);
    // The flush is a blind retry: the same payload again stores nothing new.
    await t.mutation(internal.claudeSessions.internalIngest, payload);
    const notes = await tom.query(api.sessionRows.notes, { sessionId });
    expect(notes.map((note) => note.text.slice(0, 23))).toEqual([
      "workspace rebuilt",
      "model changed to sonnet",
      "push failed: éééééééééé",
    ]);
    expect(Buffer.byteLength(notes[2].text, "utf8")).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(notes[2].text, "utf8")).toBeGreaterThan(1020);
    // A note is not a row.
    expect(await t.run((ctx) => ctx.db.query("claudeMessages").collect())).toEqual([]);
  });

  it("are Tom's to read", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedSession(t);
    await expect(t.withIdentity({ subject: "someone" }).query(api.sessionRows.notes, { sessionId })).rejects.toThrow();
  });
});

describe("the poll carries the run's newest landed row", () => {
  it("names the newest row of a file-backed session, and nothing for an old one", async () => {
    const t = convexTest(schema, modules);
    await seedSession(t);
    await seedSession(t, { rowsFrom: undefined, runId: undefined, title: "an old session" });
    await fileRow(t, 100, "user", { text: "hello" });
    await fileRow(t, 250, "assistant-text", { text: "done" });
    const { sessions } = await t.mutation(internal.claudeSessions.internalPoll, { version: "test", daemonStartedAt: 1 });
    const byTitle = new Map((sessions as Array<{ title: string; newestRow?: unknown }>).map((s) => [s.title, s.newestRow]));
    expect(byTitle.get("a file-backed session")).toEqual({ seq: 250, turn: 1, createdAt: 10_250 });
    expect(byTitle.get("an old session")).toBeUndefined();
  });
});

describe("the whole payload behind a cut agent file row", () => {
  // witness: find chunks by sessionId alone and every cut row of every
  // session since the cutover answers null — the expand has nothing to read.
  it("reassembles the chunks stored under the run", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const chunks = ["abc", "def"];
    const full = chunks.join("");
    const overflow = {
      sha256: createHash("sha256").update(full, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(full, "utf8"),
      chunkCount: chunks.length,
    };
    const messageId = await t.run(async (ctx) => {
      for (const [index, text] of chunks.entries()) {
        await ctx.db.insert("claudeMessageOverflow", { runId: RUN, seq: 7, index, chunkCount: chunks.length, text, createdAt: 1 });
      }
      return await ctx.db.insert("claudeMessages", {
        runId: RUN, seq: 7, turn: 1, kind: "tool-result", content: { toolUseId: "t", content: "ab" }, depth: 0, overflow, createdAt: 1,
      });
    });
    const read = await tom.query(api.claudeSessions.getMessageOverflow, { messageId });
    expect(read).toMatchObject({ hasOverflow: true, runId: RUN, seq: 7, text: full, end: true, complete: true });
  });
});

describe("the Codex sessions named under the Claude family", () => {
  async function codexRun(t: ReturnType<typeof convexTest>, runId: string, over: Record<string, unknown> = {}) {
    await t.run((ctx) =>
      ctx.db.insert("runs", {
        runId, rootRunId: runId, depth: 0, linkKnown: true, origin: "daemon", host: "box",
        cli: runId.startsWith("codex:") ? "codex" : "claude", environment: "session", parserVersion: "runs-parser-1",
        kind: "session", status: "ended", startedAt: 1, lastLineAt: 2, attachments: [],
        file: { path: "/r.jsonl", sourceHash: "a".repeat(64), storedHash: "b".repeat(64), bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "c".repeat(64) },
        ingestedAt: 3, ...over,
      } as never),
    );
  }

  it("rewrites a runId to the Codex spelling when that run exists, dry first", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const wrong = await seedSession(t, { runId: "claude:box:019a-codex-thread", model: "gpt-5.6-sol" });
      const claude = await seedSession(t, { runId: "claude:box:real-claude-run" });
      await codexRun(t, "codex:box:019a-codex-thread");
      await codexRun(t, "claude:box:real-claude-run");

      const dry = await t.mutation(internal.ttsMigrations.internalRelinkCodexSessionRuns, { dryRun: true });
      expect(dry).toMatchObject({ done: true, totals: { scanned: 2, relinked: 1, "run-linked-to-session": 1, "no-codex-run": 1 } });
      expect((await t.run((ctx) => ctx.db.get(wrong)))?.runId).toBe("claude:box:019a-codex-thread");

      await t.mutation(internal.ttsMigrations.internalRelinkCodexSessionRuns, {});
      expect((await t.run((ctx) => ctx.db.get(wrong)))?.runId).toBe("codex:box:019a-codex-thread");
      expect((await t.run((ctx) => ctx.db.get(claude)))?.runId).toBe("claude:box:real-claude-run");
      const linked = await t.run((ctx) =>
        ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "codex:box:019a-codex-thread")).unique(),
      );
      expect(linked?.sessionId).toBe(wrong);

      // Run again, it finds nothing left to do.
      const again = await t.mutation(internal.ttsMigrations.internalRelinkCodexSessionRuns, {});
      expect(again).toMatchObject({ totals: { relinked: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
