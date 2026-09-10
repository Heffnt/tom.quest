// The Convex half of the one context fixture. scripts/prelude.test.mjs runs the
// same cases against a git WikiTom; both read scripts/context-fixture.mjs, so
// the CLI's composition and this one cannot drift.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { assembleContext, joinContext, SESSION_SCAN_MAX } from "./ttsContext";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";
import { EXPAND_BUDGET } from "../worker/jobs/context-relevance.mjs";
import {
  CONTEXT_REPO_RULES,
  CONTEXT_TODAY,
  EXPECTED,
  IDS,
  MONDAY,
  OVERSIZE_PAGE,
  contextPublication,
  contextRecord,
  expectedPrefix,
} from "../scripts/context-fixture.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const COMMITTED_AT = Date.UTC(2026, 8, 9, 8, 0, 0);
/** Noon in New York on the fixture's "today" — the day key the record carries. */
const NOW = Date.UTC(2026, 8, 9, 16, 0, 0);
/** A calendar day at noon New York, so its NY day key is that day. */
const at = (day: string) => Date.parse(`${day}T16:00:00Z`);

type Ids = { todos: Record<string, Id<"dtsTodos">>; batches: Record<string, Id<"batches">> };

/** The fixture as rows: the publication, one ttsSkills row per page, the repo
 * rules, and the record the relevance table reads. */
async function seed(t: ReturnType<typeof convexTest>, { oversize = false } = {}): Promise<Ids> {
  const publication = contextPublication(COMMIT, { oversize });
  const record = contextRecord();
  return await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: COMMIT,
      committedAt: COMMITTED_AT,
      pushed: true,
      ...publication.layers,
      headers: publication.headers,
    });
    for (const file of publication.files) {
      await ctx.db.insert("ttsSkills", {
        name: file.path.slice("model-of-tom/".length).replace(/\.md$/, ""),
        body: file.body,
        sourcePath: file.path,
        bytes: file.bytes,
        commit: COMMIT,
        syncedAt: COMMITTED_AT,
        pushed: true,
      });
    }
    for (const rule of CONTEXT_REPO_RULES) {
      await ctx.db.insert("repoRules", {
        repo: rule.repo,
        path: rule.path,
        body: rule.body,
        bytes: rule.body.length,
        commit: COMMIT,
        syncedAt: COMMITTED_AT,
      });
    }
    const batches: Record<string, Id<"batches">> = {};
    for (const batch of record.batches) {
      batches[batch.id] = await ctx.db.insert("batches", {
        statement: batch.id,
        status: "active",
        repos: batch.repos,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    const todos: Record<string, Id<"dtsTodos">> = {};
    for (const todo of record.todos) {
      todos[todo.id] = await ctx.db.insert("dtsTodos", {
        statement: todo.id,
        readiness: "prepared",
        status: "active",
        timingClass: todo.timingClass === "dated" ? "dated" : "whenever",
        dueAt: todo.dueDay === undefined ? undefined : at(todo.dueDay),
        category: todo.category,
        brief: todo.brief,
        batchId: todo.batchId === undefined ? undefined : batches[todo.batchId],
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      });
    }
    for (const ruling of record.rulings) {
      await ctx.db.insert("dtsRulings", {
        subjectType: ruling.todoId === undefined ? "batch" : "life",
        todoId: ruling.todoId === undefined ? undefined : todos[ruling.todoId],
        batchId: ruling.batchId === undefined ? undefined : batches[ruling.batchId],
        verdict: ruling.verdict as "approve" | "revise" | "session" | "archive",
        sentence: ruling.sentence,
        ruledAt: at(ruling.ruledDay),
      });
    }
    for (const session of record.sessions) {
      await ctx.db.insert("claudeSessions", {
        title: session.outcomeSummary ?? "session",
        kind: "adhoc",
        repos: session.repos,
        repo: session.repos?.[0] ?? "none",
        batchId: session.batchId === undefined ? undefined : batches[session.batchId],
        status: session.outcome === "errored" ? "failed" : "ended",
        statusChangedAt: at(session.endedDay),
        outcome: session.outcome as "completed" | "errored",
        outcomeSummary: session.outcomeSummary,
        nextSeq: 0,
        createdAt: 1,
      });
    }
    return { todos, batches };
  });
}

/** The fixture's placeholder ids, swapped for the ones Convex minted. */
function withIds(expected: string, ids: Ids): string {
  let out = expected;
  for (const [key, id] of Object.entries(ids.todos)) out = out.split(key).join(id);
  for (const [key, id] of Object.entries(ids.batches)) out = out.split(key).join(id);
  return out;
}

const assemble = (t: ReturnType<typeof convexTest>, subject: Parameters<typeof assembleContext>[1], caller = "opener") =>
  t.run(async (ctx) => await assembleContext(ctx, subject, { reachesTom: true, caller, now: NOW }));

describe("assembleContext", () => {
  it("gives a caller with no subject the stable prefix and the whole index", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "none" }, "laptop");
    expect(context.prefix).toBe(expectedPrefix(COMMIT));
    expect(context.expanded).toBe(EXPECTED.laptop.expanded);
    expect(context.fetchable).toBe(EXPECTED.laptop.fetchable);
    expect(context.manifest).toEqual([]);
    expect(joinContext(context)).toBe(`${context.prefix}\n\n${EXPECTED.laptop.fetchable}`);
  });

  it("expands one area by name and leaves the other seven in the index", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "area", area: "climbing" });
    expect(context.expanded).toBe(EXPECTED.areaClimbing.expanded);
    expect(context.fetchable).toBe(EXPECTED.areaClimbing.fetchable);
  });

  it("expands a dated todo's area, its intent section, the corrections, and its own weekday", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.climb] });
    expect(context.expanded).toBe(withIds(EXPECTED.todoClimbing.expanded, ids));
    expect(context.fetchable).toBe(EXPECTED.todoClimbing.fetchable);
    expect(context.manifest).toEqual(EXPECTED.todoClimbing.manifest);
    // The day key comes off the stored instant through nyCalendarDayKey, so a
    // due date at noon New York on a Monday is a Monday here too.
    expect(MONDAY).toBe("2026-09-07");
    expect(CONTEXT_TODAY).toBe("2026-09-09");
    expect(context.expanded).not.toContain("Tuesday");
  });

  it("expands no area for a category no page claims, says so, and does not throw", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.nosuch] });
    expect(context.expanded).toBe(withIds(EXPECTED.todoNoMatch.expanded, ids));
    expect(context.fetchable).toBe(EXPECTED.todoNoMatch.fetchable);
  });

  it("expands the repo rules the brief's paths name, root first then deepest", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    expect(context.expanded).toBe(withIds(EXPECTED.todoPaths.expanded, ids));
    expect(context.fetchable).toBe(EXPECTED.todoPaths.fetchable);
  });

  it("expands a batch's areas by todo count then name, and indexes the third", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "batch", batchId: ids.batches[IDS.memberBatch] });
    expect(context.expanded).toBe(withIds(EXPECTED.batchMembers.expanded, ids));
    expect(context.fetchable).toBe(EXPECTED.batchMembers.fetchable);
  });

  it("shrinks an oversized area in the documented order, and indexes what it dropped", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t, { oversize: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: "areas/oversize",
        body: OVERSIZE_PAGE,
        sourcePath: "model-of-tom/areas/oversize.md",
        bytes: OVERSIZE_PAGE.length,
        commit: COMMIT,
        syncedAt: COMMITTED_AT,
        pushed: true,
      });
    });
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.oversize] });
    expect(context.manifest).toEqual(EXPECTED.oversize.manifest);
    expect(context.bytes.expanded).toBeLessThanOrEqual(EXPAND_BUDGET + 512);
    expect(context.fetchable).toContain(EXPECTED.oversize.fetchableLine);
  });

  it("assembles byte-identically twice at one commit and one day", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const first = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    const second = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    expect(joinContext(second)).toBe(joinContext(first));
  });

  it("expands a repo's area and its root rules, with nothing todo-shaped", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "repo", repo: "tom.quest" });
    expect(context.expanded).toBe(EXPECTED.repoTomQuest.expanded);
    expect(context.fetchable).toBe(EXPECTED.repoTomQuest.fetchable);
  });

  it("refuses a subject that names nothing, rather than expanding silently", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await expect(assemble(t, { kind: "area", area: "nosuch" })).rejects.toThrow(/no area page named nosuch/);
    await expect(assemble(t, { kind: "todo", todoId: "x".repeat(32) as Id<"dtsTodos"> })).rejects.toThrow();
    await expect(assemble(t, { kind: "none" }, "nobody")).rejects.toThrow(/unknown caller nobody/);
  });

  it("says on header line 2 when an area matched with no categories: frontmatter", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "area", area: "money" });
    expect(context.expanded).toBe(EXPECTED.areaMoneyFallback.expanded);
  });

  it("fails closed while no publication is stored", async () => {
    const t = convexTest({ schema, modules });
    await expect(assemble(t, { kind: "none" }, "laptop")).rejects.toThrow(/is not stored/);
  });

  it("drops the write layer for a run whose output does not reach Tom", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await t.run(async (ctx) =>
      await assembleContext(ctx, { kind: "none" }, { reachesTom: false, caller: "laptop", now: NOW }),
    );
    expect(context.prefix).toBe(expectedPrefix(COMMIT, { write: false }));
    expect(context.fetchable).toContain("--layers write");
  });
});

describe("insertSession's context", () => {
  async function withTom(t: ReturnType<typeof convexTest>) {
    const tomId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
    );
    return t.withIdentity({ subject: tomId });
  }

  it("writes one header line 1, the expanded block before the body, and the index last", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "a climbing session",
      kind: "focus-item",
      repo: "none",
      todoId: ids.todos[IDS.climb],
      initialPrompt: "THE MISSION BODY",
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    const text = inbound[0].text ?? "";
    expect(text.split(MODEL_OF_TOM_HEADER)).toHaveLength(2); // one header, still
    expect(text.startsWith(expectedPrefix(COMMIT))).toBe(true);
    // Prompt order: prefix, expanded, the mission body, the index.
    const expanded = withIds(EXPECTED.todoClimbing.expanded, ids);
    expect(text.indexOf(expanded)).toBeGreaterThan(0);
    expect(text.indexOf(expanded)).toBeLessThan(text.indexOf("THE MISSION BODY"));
    expect(text.indexOf("THE MISSION BODY")).toBeLessThan(text.indexOf("MODEL-OF-TOM FETCHABLE"));
    expect(text.endsWith(EXPECTED.todoClimbing.fetchable)).toBe(true);
    // The know layer is never sent whole again.
    expect(text).not.toContain("── model-of-tom/areas/research.md ──");
  });

  it("records what the opener was given, for the delivery check to read", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "a climbing session",
      kind: "focus-item",
      repo: "none",
      todoId: ids.todos[IDS.climb],
      initialPrompt: "hello",
    });
    const row = await t.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row?.contextExpanded).toEqual(EXPECTED.todoClimbing.manifest);
    expect(row?.contextBytes?.prefix).toBe(Buffer.byteLength(expectedPrefix(COMMIT)));
    expect(row?.contextBytes?.expanded).toBeGreaterThan(0);
    expect(row?.contextBytes?.fetchable).toBe(Buffer.byteLength(EXPECTED.todoClimbing.fetchable));
  });

  it("strips a pasted stable prefix at the live commit and puts the live one back", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const tom = await withTom(t);
    const prefix = expectedPrefix(COMMIT);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "pasted opener",
      kind: "adhoc",
      repo: "none",
      initialPrompt: `${prefix}\n\ncarry on from here`,
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    const text = inbound[0].text ?? "";
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.split(MODEL_OF_TOM_HEADER)).toHaveLength(2);
    expect(text).toContain("carry on from here");
  });

  it("refuses a prefix read at another commit, and writes nothing", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.claudeSessions.createSession, {
        title: "another commit",
        kind: "adhoc",
        repo: "none",
        initialPrompt: `${MODEL_OF_TOM_HEADER} (WikiTom commit 0123abcd): model-of-tom/writing.md\n\nhello`,
      }),
    ).rejects.toThrow(/read at another commit/);
    const rows = await t.run(async (ctx) => ({
      sessions: await ctx.db.query("claudeSessions").collect(),
      inbound: await ctx.db.query("claudeInbound").collect(),
    }));
    // The three seeded outcome rows are all that is there; no session and no
    // opener came from the refusal.
    expect(rows.sessions).toHaveLength(3);
    expect(rows.inbound).toHaveLength(0);
  });

  it("keeps the per-session read count inside its documented bound", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    let reads = 0;
    const context = await t.run(async (ctx) => {
      const db = ctx.db;
      const counted = new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "get") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: Parameters<typeof db.get>) => {
            reads += 1;
            return await value.apply(target, args);
          };
        },
      });
      return await assembleContext({ ...ctx, db: counted } as typeof ctx, { kind: "todo", todoId: ids.todos[IDS.paths] }, {
        reachesTom: true, caller: "opener", now: NOW,
      });
    });
    expect(context.manifest.length).toBeGreaterThan(0);
    // Two `get`s (the todo and its batch); everything else is an indexed,
    // take()-bounded query.
    expect(reads).toBeLessThan(SESSION_SCAN_MAX + 20);
  });
});

describe("the repo layer's publication", () => {
  it("replaces one repo's rules and leaves the others alone", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "tom.quest",
      commit: "b".repeat(40),
      syncedAt: 2,
      files: [{ path: "AGENTS.md", body: "# new root\n", bytes: 11 }],
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("repoRules").collect());
    expect(rows.map((row) => row.path)).toEqual(["AGENTS.md"]);
    expect(rows[0].body).toBe("# new root\n");
  });

  it("refuses a repo nobody declared, an empty post, a duplicate path and a blank body", async () => {
    const t = convexTest({ schema, modules });
    const file = { path: "AGENTS.md", body: "# root\n", bytes: 7 };
    await expect(t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "not-a-repo", commit: "b".repeat(40), syncedAt: 2, files: [file],
    })).rejects.toThrow(/not a session repo/);
    await expect(t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "tom.quest", commit: "b".repeat(40), syncedAt: 2, files: [],
    })).rejects.toThrow(/no repo rules posted/);
    await expect(t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "tom.quest", commit: "b".repeat(40), syncedAt: 2, files: [file, file],
    })).rejects.toThrow(/posted twice/);
    await expect(t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "tom.quest", commit: "b".repeat(40), syncedAt: 2, files: [{ path: "AGENTS.md", body: "  \n", bytes: 3 }],
    })).rejects.toThrow(/must be non-empty/);
    await expect(t.mutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: "tom.quest", commit: "b".repeat(40), syncedAt: 2, files: [{ path: "../AGENTS.md", body: "x", bytes: 1 }],
    })).rejects.toThrow(/not a repo rules path/);
  });
});
