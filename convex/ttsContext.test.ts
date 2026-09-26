// The Convex half of the context fixture, scripts/context-fixture.mjs. Every
// expected prompt below is written out by hand from the fixture's pages.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  assembleContext,
  joinContext,
  OUTCOMES_BYTES,
  RULINGS_BYTES,
  SESSION_SCAN_MAX,
  SKILLS_LINE,
} from "./ttsContext";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";
import {
  CONTEXT_REPO_RULES,
  IDS,
  contextPublication,
  contextRecord,
  expectedPrefix,
} from "../scripts/context-fixture.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const COMMITTED_AT = Date.UTC(2026, 8, 9, 8, 0, 0);
/** A calendar day at noon New York, so its NY day key is that day. */
const at = (day: string) => Date.parse(`${day}T16:00:00Z`);

/** Header line 1, the map and the operate rules: the base, the same for every run. */
const PREFIX = expectedPrefix(COMMIT, { write: false });
/** The two write pages, rendered the way the prelude renders every file. */
const WRITE = "── model-of-tom/writing.md ──\n# Writing\n\nBe plain.\n\n\n── model-of-tom/ground.md ──\n# Ground\n\nStart here.\n";
const OUTCOMES = "RECENT SESSION OUTCOMES\n- 2026-09-08 completed: the prelude landed\n- 2026-09-07 errored: the daemon died\n- 2026-09-06 completed: the search tool landed";

type Ids = { todos: Record<string, Id<"dtsTodos">> };

/** The fixture as rows: the base publication (operate alone), one
 * modelOfTomFiles row per page, the repo rules, and the record. */
async function seed(t: ReturnType<typeof convexTest>, { without = [] as string[] } = {}): Promise<Ids> {
  const publication = contextPublication(COMMIT);
  const record = contextRecord();
  return await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: COMMIT,
      committedAt: COMMITTED_AT,
      pushed: true,
      operate: publication.layers.operate,
      headers: publication.headers.filter(
        (header: { layers: string[] }) => header.layers.join(",") === "operate",
      ),
    });
    for (const file of publication.files) {
      if (without.includes(file.path)) continue;
      await ctx.db.insert("modelOfTomFiles", {
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
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      });
    }
    for (const ruling of record.rulings) {
      await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId: todos[ruling.todoId],
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
        status: session.outcome === "errored" ? "failed" : "ended",
        statusChangedAt: at(session.endedDay),
        outcome: session.outcome as "completed" | "errored",
        outcomeSummary: session.outcomeSummary,
        nextSeq: 0,
        createdAt: 1,
      });
    }
    return { todos };
  });
}

const assemble = (
  t: ReturnType<typeof convexTest>,
  subject: Parameters<typeof assembleContext>[1],
  reachesTom = true,
) => t.run(async (ctx) => await assembleContext(ctx, subject, { reachesTom }));

describe("assembleContext", () => {
  it("gives a run whose output reaches Tom the base, the write pages and the skills line", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "none" });
    expect(context).toEqual({ prefix: PREFIX, write: WRITE, skills: SKILLS_LINE, facts: "" });
    expect(joinContext(context)).toBe(`${PREFIX}\n\n${WRITE}\n\n${SKILLS_LINE}`);
    expect(SKILLS_LINE).toBe("Skills: `tts-search skills` lists them; `tts-search skills <name>` prints one.");
    // No other page rides along: the rest is read on demand.
    expect(joinContext(context)).not.toContain("On the WPI team.");
    expect(joinContext(context)).not.toContain("── model-of-tom/intent.md ──");
  });

  it("gives a run whose output does not reach Tom the same base and the skills line, no write pages", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "none" }, false);
    expect(context).toEqual({ prefix: PREFIX, write: "", skills: SKILLS_LINE, facts: "" });
    expect(joinContext(context)).toBe(`${PREFIX}\n\n${SKILLS_LINE}`);
  });

  it("carries a todo's repositories' prior outcomes after the skills line", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] });
    expect(context.facts).toBe(OUTCOMES);
    expect(joinContext(context)).toBe(`${PREFIX}\n\n${WRITE}\n\n${SKILLS_LINE}\n\n${OUTCOMES}`);
  });

  it("carries his rulings on a todo, newest first", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.oversize] });
    expect(context.facts).toBe(
      "RULINGS ON THIS SUBJECT\n- 2026-09-05 revise: narrow it first\n- 2026-09-04 session: talk it through",
    );
  });

  it("carries a repository subject's prior outcomes", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "repo", repo: "tom.quest" });
    expect(context.facts).toBe(OUTCOMES);
  });

  it("fills repository outcome slots by recency across terminal statuses", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await t.run(async (ctx) => {
      for (const [endedDay, status, outcome, outcomeSummary] of [
        ["2026-09-09", "ended", "completed", "oldest ended"],
        ["2026-09-10", "ended", "completed", "middle ended"],
        ["2026-09-11", "ended", "completed", "newest ended"],
        ["2026-09-12", "failed", "errored", "newer failed"],
      ] as const) {
        await ctx.db.insert("claudeSessions", {
          title: outcomeSummary,
          kind: "adhoc",
          repo: "tom.quest",
          repos: ["tom.quest"],
          status,
          statusChangedAt: at(endedDay),
          outcome,
          outcomeSummary,
          nextSeq: 0,
          createdAt: 1,
        });
      }
    });

    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.member1], repos: ["tom.quest"] });
    expect(context.facts.split("RECENT SESSION OUTCOMES\n")[1].split("\n")).toEqual([
      "- 2026-09-12 errored: newer failed",
      "- 2026-09-11 completed: newest ended",
      "- 2026-09-10 completed: middle ended",
    ]);
  });

  it("caps an over-long ruling and outcome summary before either reaches an opener", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const ruling = `OVERLONG-RULING-${"r".repeat(RULINGS_BYTES)}`;
    const outcome = `OVERLONG-OUTCOME-${"o".repeat(OUTCOMES_BYTES)}`;
    await t.run(async (ctx) => {
      await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId: ids.todos[IDS.paths],
        verdict: "revise",
        sentence: ruling,
        ruledAt: at("2026-09-09"),
      });
      await ctx.db.insert("claudeSessions", {
        title: outcome,
        kind: "adhoc",
        repo: "tom.quest",
        repos: ["tom.quest"],
        status: "ended",
        statusChangedAt: at("2026-09-09"),
        outcome: "completed",
        outcomeSummary: outcome,
        nextSeq: 0,
        createdAt: 1,
      });
    });
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] });
    expect(context.facts).not.toContain("OVERLONG-RULING-");
    expect(context.facts).not.toContain("OVERLONG-OUTCOME-");
  });

  it("assembles byte-identically twice, and the base is the same whatever the subject", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const first = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] });
    const second = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] });
    expect(joinContext(second)).toBe(joinContext(first));
    const none = await assemble(t, { kind: "none" }, false);
    expect(none.prefix).toBe(first.prefix);
  });

  it("refuses a todo subject that does not exist", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await expect(assemble(t, { kind: "todo", todoId: "x".repeat(32) as Id<"dtsTodos"> })).rejects.toThrow();
  });

  it("fails closed while no publication is stored", async () => {
    const t = convexTest({ schema, modules });
    await expect(assemble(t, { kind: "none" }, false)).rejects.toThrow(/is not stored/);
  });

  it("carries the write pages the last post stored", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, { without: ["model-of-tom/ground.md"] });
    expect((await assemble(t, { kind: "none" })).write).toBe("── model-of-tom/writing.md ──\n# Writing\n\nBe plain.\n");
  });

  it("serves the HTTP doors the prompt of a run that reaches Tom, and refuses a door nobody declared", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    expect(await t.query(internal.ttsContext.internalContextPrelude, { caller: "time-notes" }))
      .toBe(`${PREFIX}\n\n${WRITE}\n\n${SKILLS_LINE}`);
    await expect(t.query(internal.ttsContext.internalContextPrelude, { caller: "nobody" }))
      .rejects.toThrow(/unknown context caller nobody/);
  });
});

describe("insertSession's context", () => {
  async function withTom(t: ReturnType<typeof convexTest>) {
    const tomId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
    );
    return t.withIdentity({ subject: tomId });
  }

  it("writes one header line 1, then the write pages, the skills line, and the task last", async () => {
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
    expect(text.split(MODEL_OF_TOM_HEADER)).toHaveLength(2); // one header
    expect(text.startsWith(`${PREFIX}\n\n${WRITE}\n\n${SKILLS_LINE}\n\n`)).toBe(true);
    expect(text.indexOf(SKILLS_LINE)).toBeLessThan(text.indexOf("THE MISSION BODY"));
    // No other page is sent whole.
    expect(text).not.toContain("── model-of-tom/areas/climbing.md ──");
  });

  it("records no grant on the session row", async () => {
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
    expect(row?.contextExpanded).toBeUndefined();
    expect(row?.contextBytes).toBeUndefined();
  });

  it("delivers the subject's rulings and prior outcomes to the opened session", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "a session with prior work",
      kind: "focus-item",
      // The session's repos reach its context: the prior outcomes in them.
      repos: ["tom.quest"],
      todoId: ids.todos[IDS.oversize],
      initialPrompt: "THE MISSION BODY",
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    const text = inbound[0].text ?? "";
    expect(text).toContain("RULINGS ON THIS SUBJECT\n- 2026-09-05 revise: narrow it first");
    expect(text).toContain("RECENT SESSION OUTCOMES\n- 2026-09-08 completed: the prelude landed");
    expect(text.indexOf("RECENT SESSION OUTCOMES")).toBeLessThan(text.indexOf("THE MISSION BODY"));
  });

  // Tom's ruling 2026-09-25: a therapy session is about the mental-health
  // area whatever todo it was opened on, and it opens on no repo. Opened here
  // on a todo he has ruled on, so a subject taken from the todo would carry
  // those rulings.
  it("opens a therapy session with no todo's rulings, whatever its todo", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    // A statement the word guess would read a repo out of.
    await t.run(async (ctx) =>
      ctx.db.patch(ids.todos[IDS.oversize], { statement: "talk about the tom.quest work" }),
    );
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "therapy",
      kind: "therapy",
      todoId: ids.todos[IDS.oversize],
      initialPrompt: "hello",
    });
    const row = await t.run(async (ctx) => await ctx.db.get(sessionId));
    // No repo, and no word guess over the todo supplied one.
    expect(row?.repos).toEqual([]);
    expect(row?.repo).toBe("none");
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    expect(inbound[0].text).toContain(`${PREFIX}\n\n${WRITE}\n\n${SKILLS_LINE}`);
    expect(inbound[0].text).not.toContain("RULINGS ON THIS SUBJECT");
  });

  it("refuses a therapy session that names a repo, and inserts nothing", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.claudeSessions.createSession, {
        title: "therapy",
        kind: "therapy",
        repos: ["tom.quest"],
        initialPrompt: "hello",
      }),
    ).rejects.toThrow(/a therapy session opens on no repo; this one named tom\.quest/);
    // The fixture's record holds sessions of its own; none of them is this.
    const sessions = await t.run(async (ctx) => await ctx.db.query("claudeSessions").collect());
    expect(sessions.filter((s) => s.kind === "therapy")).toHaveLength(0);
  });

  it("strips a pasted base at the live commit and puts the live one back", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "pasted opener",
      kind: "adhoc",
      repo: "none",
      initialPrompt: `${PREFIX}\n\ncarry on from here`,
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    const text = inbound[0].text ?? "";
    expect(text.startsWith(PREFIX)).toBe(true);
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
        reachesTom: true,
      });
    });
    expect(context.write).not.toBe("");
    // One `get` (the todo); everything else is an indexed, take()-bounded query.
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
