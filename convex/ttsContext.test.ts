// The Convex half of the context fixture, scripts/context-fixture.mjs. The
// Jarvis repository's scripts/prelude.test.mjs runs its own copy of the same
// pages and record against a git WikiTom.
//
// EVERY GRANT BLOCK BELOW IS WRITTEN OUT BY HAND. An expectation rendered by
// calling renderGrants would assert only that the renderer is itself.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { assembleContext, joinContext, OUTCOMES_BYTES, RULINGS_BYTES, SESSION_SCAN_MAX } from "./ttsContext";
import { MODEL_OF_TOM_HEADER, SESSION_REPO_NAMES } from "./ttsShared";
import { CLAUDE_SKILL_NAME, repoSkillName } from "../shared/skills.mjs";
import {
  AREA_NAMES,
  CONTEXT_REPO_RULES,
  CONTEXT_TODAY,
  IDS,
  MONDAY,
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

/** THE PREFIX IS ONE SELECTION NOW: header line 1, the map and the operate
 * rules, whoever the caller is. The write layer left it when `write` became a
 * skill, which is what `{ write: false }` spells in the fixture. */
const PREFIX = expectedPrefix(COMMIT, { write: false });

/** The catalog the nightly publishes from these pages: `write`, the two fixed
 * know skills, one per area page, and one per repository. */
const CATALOG = [
  "write",
  "know-intent",
  "know-week",
  ...AREA_NAMES.map((name: string) => `know-${name}`),
  "repo-tom-quest",
];

/** The grant block, written out: the header line, the granted names in the
 * router's fixed order, an optional refused line, and the closing sentence. */
function grantBlock(granted: string[], refused: string[] = []): string {
  return [
    `SKILLS (WikiTom commit ${COMMIT})`,
    `granted: ${granted.length === 0 ? "—" : granted.join(", ")}`,
    ...(refused.length === 0 ? [] : [`refused: ${refused.join("; ")}`]),
    "Load each granted skill before you act on what it covers. `tts-search skills` lists the rest.",
  ].join("\n");
}

const NO_BODY = "no published body at this commit";

type Ids = { todos: Record<string, Id<"todos">> };

/** The fixture as rows: the base publication (operate alone), one
 * modelOfTomFiles row per page, the catalog, the repo rules, and the record the
 * routing table reads. */
async function seed(
  t: ReturnType<typeof convexTest>,
  {
    catalog = CATALOG,
    fileStore = "modelOfTomFiles",
  }: { catalog?: string[]; fileStore?: "modelOfTomFiles" | "legacyTtsSkills" } = {},
): Promise<Ids> {
  const publication = contextPublication(COMMIT);
  const record = contextRecord();
  return await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: COMMIT,
      committedAt: COMMITTED_AT,
      pushed: true,
      // `operate` alone, and its header alone — exactly what the door stores
      // now that `write` and `know` are skills.
      operate: publication.layers.operate,
      headers: publication.headers.filter(
        (header: { layers: string[] }) => header.layers.join(",") === "operate",
      ),
    });
    for (const file of publication.files) {
      const row = {
        name: file.path.slice("model-of-tom/".length).replace(/\.md$/, ""),
        body: file.body,
        sourcePath: file.path,
        bytes: file.bytes,
        commit: COMMIT,
        syncedAt: COMMITTED_AT,
        pushed: true,
      };
      if (fileStore === "modelOfTomFiles") await ctx.db.insert("modelOfTomFiles", row);
      else await ctx.db.insert("ttsSkills", row);
    }
    for (const name of catalog) {
      await ctx.db.insert("ttsSkills", {
        name,
        group: name === "write" ? "write" : name.startsWith("repo-") ? "repo" : "know",
        description: `what ${name} covers`,
        body: `the body of ${name}`,
        references: [],
        sourcePaths: [`model-of-tom/${name}.md`],
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
    const todos: Record<string, Id<"todos">> = {};
    for (const todo of record.todos) {
      todos[todo.id] = await ctx.db.insert("todos", {
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

const assemble = (t: ReturnType<typeof convexTest>, subject: Parameters<typeof assembleContext>[1], caller = "opener") =>
  t.run(async (ctx) => await assembleContext(ctx, subject, { reachesTom: true, caller, now: NOW }));

describe("assembleContext", () => {
  it("gives a caller with no subject the stable prefix and one grant", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "none" }, "laptop");
    expect(context.prefix).toBe(PREFIX);
    expect(context.granted).toEqual(["write"]);
    expect(context.refused).toEqual([]);
    expect(context.grants).toBe(grantBlock(["write"]));
    expect(joinContext(context)).toBe(`${PREFIX}\n\n${context.grants}`);
    // The know layer is never sent whole again, and no page body rides along.
    expect(joinContext(context)).not.toContain("On the WPI team.");
  });

  it("grants one area's skill for an area subject", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await assemble(t, { kind: "area", area: "climbing" });
    expect(context.granted).toEqual(["write", "know-climbing", "know-intent"]);
    expect(context.grants).toBe(grantBlock(["write", "know-climbing", "know-intent"]));
    expect(context.prefix).toBe(PREFIX);
  });

  it("grants a dated todo's area and, for a judging caller, his intent", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.climb] });
    expect(context.granted).toEqual(["write", "know-climbing", "know-intent", "know-week"]);
    // The day key comes off the stored instant through nyCalendarDayKey, so a
    // due date at noon New York on a Monday is a Monday here too.
    expect(MONDAY).toBe("2026-09-07");
    expect(CONTEXT_TODAY).toBe("2026-09-09");
  });

  it("grants no know-<area> for a category no page claims, and does not throw", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.nosuch] });
    expect(context.granted).toEqual(["write", "know-intent"]);
    expect(context.granted.some((name) => name.startsWith("know-") && name !== "know-intent")).toBe(false);
    expect(context.refused).toEqual([]);
  });

  it("grants a repo skill when the brief names paths in it, with its rulings and prior outcomes", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    // The repositories come from the caller (a session's repos): a todo
    // declares none of its own since batches went.
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] });
    const granted = ["write", "know-agent-systems", "know-intent", "repo-tom-quest"];
    expect(context.granted).toEqual(granted);
    expect(context.grants).toBe(`${grantBlock(granted)}\n\nRECENT SESSION OUTCOMES\n- 2026-09-08 completed: the prelude landed\n- 2026-09-07 errored: the daemon died\n- 2026-09-06 completed: the search tool landed`);
    // Convex has no cwd, so the native-rules rule is inert here — see the cwd
    // gap at assembleContext.
    expect(context.repoRulesSource).toBeNull();
  });

  /**
   * THE CROSS-CHECK, over the catalog fixture. A grant block is a list of
   * names a run will go and load a body by; a name the publisher never wrote
   * is a grant that resolves to nothing, and the run finds that out only when
   * it reaches for the body. This asserts the two halves agree for EVERY repo
   * a session may check out, not just the one the record fixture names:
   * the catalog is seeded with the publisher's spelling and every repo subject
   * must come back GRANTED, never refused for want of a body.
   *
   * It is one function on both sides — shared/skills.mjs repoSkillName, which
   * shared/skill-router.mjs and shared/skills.mjs buildSkills each call —
   * and this fails the day a second spelling appears on either path.
   */
  it("grants every session repository the exact skill name the publisher produces", async () => {
    const published = SESSION_REPO_NAMES.map((repo) => repoSkillName(repo));
    // The hand-written catalog above is the fixture's claim about what the
    // publisher makes; this pins that claim to the function that makes it.
    expect(CATALOG.filter((name) => name.startsWith("repo-"))).toEqual([repoSkillName("tom.quest")]);
    const t = convexTest({ schema, modules });
    await seed(t, { catalog: [...CATALOG.filter((name) => !name.startsWith("repo-")), ...published] });
    for (const repo of SESSION_REPO_NAMES) {
      const context = await assemble(t, { kind: "repo", repo });
      expect(context.granted, repo).toContain(repoSkillName(repo));
      expect(context.refused.filter((entry) => entry.name.startsWith("repo-")), repo).toEqual([]);
      // Nothing the block names may be unpublishable as a directory or as a
      // frontmatter name under either runner's rule.
      for (const name of context.granted) expect(CLAUDE_SKILL_NAME.test(name), name).toBe(true);
    }
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
    const outcomes = context.grants.split("RECENT SESSION OUTCOMES\n")[1].split("\n");
    expect(outcomes).toEqual([
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
    const context = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    expect(context.grants).not.toContain("OVERLONG-RULING-");
    expect(context.grants).not.toContain("OVERLONG-OUTCOME-");
  });

  it("assembles byte-identically twice at one commit and one day", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const first = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    const second = await assemble(t, { kind: "todo", todoId: ids.todos[IDS.paths] });
    expect(joinContext(second)).toBe(joinContext(first));
    expect(second.bytes).toEqual(first.bytes);
  });

  it("refuses a subject that names nothing, rather than granting silently", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await expect(assemble(t, { kind: "area", area: "nosuch" })).rejects.toThrow(/no area page named nosuch/);
    await expect(assemble(t, { kind: "todo", todoId: "x".repeat(32) as Id<"todos"> })).rejects.toThrow();
    await expect(assemble(t, { kind: "none" }, "nobody")).rejects.toThrow(/unknown caller nobody/);
  });

  it("fails closed while no publication is stored", async () => {
    const t = convexTest({ schema, modules });
    await expect(assemble(t, { kind: "none" }, "laptop")).rejects.toThrow(/is not stored/);
  });

  it("drops the write grant for a run whose output does not reach Tom, and keeps the same prefix", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const context = await t.run(async (ctx) =>
      await assembleContext(ctx, { kind: "none" }, { reachesTom: false, caller: "laptop", now: NOW }),
    );
    expect(context.granted).toEqual([]);
    expect(context.grants).toBe(grantBlock([]));
    // THE CASE THAT CHANGED: the prefix no longer varies by caller.
    expect(context.prefix).toBe(PREFIX);
  });

  it("refuses a wanted skill the catalog does not carry, and still returns", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, { catalog: ["write", "know-intent"] });
    const context = await assemble(t, { kind: "area", area: "climbing" });
    expect(context.granted).toEqual(["write", "know-intent"]);
    expect(context.refused).toEqual([{ name: "know-climbing", why: NO_BODY }]);
    expect(context.grants).toBe(grantBlock(["write", "know-intent"], [`know-climbing — ${NO_BODY}`]));
    expect(context.prefix).toBe(PREFIX);
  });

  it("routes area categories from old per-file rows before the clean nightly replacement", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, { catalog: [], fileStore: "legacyTtsSkills" });
    expect(await t.run(async (ctx) => await ctx.db.query("modelOfTomFiles").collect())).toEqual([]);

    // The base half fails first, so it leaves the new source table empty. The
    // nightly still publishes the independent catalog half: that must not
    // erase the legacy source pages the area router still needs.
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, {
      commit: COMMIT,
      committedAt: COMMITTED_AT + 1,
      pushed: true,
      layers: { operate: "replacement operate" },
      headers: [{ layers: ["operate"], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit ${COMMIT}): model-of-tom/agent-rules.md` }],
      files: [],
    })).rejects.toThrow(/no files posted/);
    await t.mutation(internal.ttsSkills.internalReplaceSkills, {
      commit: COMMIT,
      syncedAt: COMMITTED_AT + 1,
      pushed: true,
      skills: [{
        name: "know-climbing",
        group: "know",
        description: "what know-climbing covers",
        body: "the body of know-climbing",
        references: [],
        sourcePaths: ["model-of-tom/areas/climbing.md"],
      }],
    });
    expect((await t.run(async (ctx) => await ctx.db.query("ttsSkills").collect()))
      .some((row) => row.sourcePath === "model-of-tom/areas/climbing.md")).toBe(true);

    const context = await assemble(t, { kind: "area", area: "climbing" });
    // The legacy page gets the area request to the router, while the fresh
    // catalog supplies climbing's body; only catalog entries not posted here
    // are refused.
    expect(context.granted).toEqual(["know-climbing"]);
    expect(context.refused.map((entry) => entry.name)).toEqual(["write", "know-intent"]);
  });

  it("treats an old per-file ttsSkills row as absent from the catalog", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, { catalog: [] });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: "areas/climbing",
        body: "old private page body",
        sourcePath: "model-of-tom/areas/climbing.md",
        syncedAt: COMMITTED_AT,
      });
    });
    const context = await assemble(t, { kind: "area", area: "climbing" });
    expect(context.granted).toEqual([]);
    expect(context.refused.map((entry) => entry.name)).toEqual([
      "write",
      "know-climbing",
      "know-intent",
    ]);
    expect(context.grants).toContain(`SKILLS (WikiTom commit ${COMMIT})`);
  });

  it("names the catalog's commit, not the base's, when the two posts disagree", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const later = "b".repeat(40);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("ttsSkills").collect()) {
        await ctx.db.patch(row._id, { commit: later });
      }
    });
    const context = await assemble(t, { kind: "none" }, "laptop");
    expect(context.grants).toContain(`SKILLS (WikiTom commit ${later})`);
    // The base's own header still names the base's commit.
    expect(context.prefix).toContain(COMMIT);
  });

  it("keeps the grant block small whatever the subject", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    for (const subject of [
      { kind: "none" } as const,
      { kind: "todo", todoId: ids.todos[IDS.paths], repos: ["tom.quest"] } as const,
    ]) {
      const context = await assemble(t, subject);
      expect(context.bytes.grants).toBeLessThan(512);
      expect(context.bytes.prefix).toBe(Buffer.byteLength(PREFIX));
    }
  });
});

describe("POST /tts/skills", () => {
  afterEach(() => vi.unstubAllEnvs());
  const KEY = "s3cret";
  const SKILL = {
    name: "know-research",
    group: "know",
    description: "Tom's research: research-one, research-two, research-three.",
    body: "# Research\n\nThe September campaign.\n",
    references: [],
    sourcePaths: ["model-of-tom/areas/research.md"],
    bytes: 40,
  };
  const body = (overrides: Record<string, unknown> = {}) => ({
    commit: COMMIT, syncedAt: COMMITTED_AT, pushed: true, skills: [SKILL], ...overrides,
  });
  const post = (t: ReturnType<typeof convexTest>, payload: unknown, key = KEY) =>
    t.fetch("/tts/skills", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("replaces every row with the posted set", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await seed(t);
    const response = await post(t, body());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, skills: 1, deleted: CATALOG.length, commit: COMMIT, refused: 0,
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("ttsSkills").collect());
    expect(rows.map((row) => row.name)).toEqual(["know-research"]);
    expect(rows[0].body).toBe(SKILL.body);
    expect(rows[0].pushed).toBe(true);
  });

  it("leaves the base publication alone — two posts, two failures", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await seed(t);
    await post(t, body());
    const files = await t.run(async (ctx) => await ctx.db.query("modelOfTomFiles").collect());
    expect(files.length).toBeGreaterThan(0);
    const context = await assemble(t, { kind: "none" }, "laptop");
    expect(context.prefix).toBe(PREFIX);
  });

  it("refuses an empty post, a duplicate name, a blank body, a long description and a bad group", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await seed(t);
    const before = await t.run(async (ctx) => await ctx.db.query("ttsSkills").collect());
    expect((await post(t, body({ skills: [] }))).status).toBe(400);
    expect((await post(t, body({ skills: [SKILL, SKILL] }))).status).toBe(400);
    expect((await post(t, body({ skills: [{ ...SKILL, body: "  \n" }] }))).status).toBe(400);
    expect((await post(t, body({ skills: [{ ...SKILL, description: "x".repeat(201) }] }))).status).toBe(400);
    expect((await post(t, body({ skills: [{ ...SKILL, group: "operate" }] }))).status).toBe(400);
    expect((await post(t, body({ commit: "0123abcd" }))).status).toBe(400);
    expect((await post(t, body(), "wrong")).status).toBe(401);
    // Every refusal left the store exactly as it was.
    const after = await t.run(async (ctx) => await ctx.db.query("ttsSkills").collect());
    expect(after.map((row) => row.name).sort()).toEqual(before.map((row) => row.name).sort());
  });
});

describe("insertSession's context", () => {
  async function withTom(t: ReturnType<typeof convexTest>) {
    const tomId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
    );
    return t.withIdentity({ subject: tomId });
  }

  it("writes one header line 1, the grant block before the body, and the task last", async () => {
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
    expect(text.startsWith(PREFIX)).toBe(true);
    // Prompt order: prefix, grants, the mission body. Nothing after the task.
    const grants = grantBlock(["write", "know-climbing", "know-intent", "know-week"]);
    expect(text.indexOf(grants)).toBeGreaterThan(0);
    expect(text.indexOf(grants)).toBeLessThan(text.indexOf("THE MISSION BODY"));
    expect(text).not.toContain("MODEL-OF-TOM FETCHABLE");
    // The know layer is never sent whole again.
    expect(text).not.toContain("── model-of-tom/areas/research.md ──");
    expect(text).not.toContain("── model-of-tom/areas/climbing.md ──");
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
    // The two fields keep their phase-4 names until phase 9: the granted names
    // where the expanded manifest was, the grant block's bytes in `expanded`,
    // and 0 where a fetchable block used to be.
    expect(row?.contextExpanded).toEqual(["write", "know-climbing", "know-intent", "know-week"]);
    expect(row?.contextBytes?.prefix).toBe(Buffer.byteLength(PREFIX));
    expect(row?.contextBytes?.expanded).toBe(
      Buffer.byteLength(grantBlock(["write", "know-climbing", "know-intent", "know-week"])),
    );
    expect(row?.contextBytes?.fetchable).toBe(0);
  });

  // Tom's ruling 2026-09-25: a therapy session's subject is the
  // mental-health area whatever todo it was opened on, and it opens on no
  // repo. Opened here on the climbing todo, so a subject taken from the todo
  // would grant know-climbing and know-week instead.
  it("opens a therapy session on the mental-health area, whatever its todo", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    // A statement the word guess would read a repo out of.
    await t.run(async (ctx) =>
      ctx.db.patch(ids.todos[IDS.climb], { statement: "talk about the tom.quest work" }),
    );
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "therapy",
      kind: "therapy",
      todoId: ids.todos[IDS.climb],
      initialPrompt: "hello",
    });
    const row = await t.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row?.contextExpanded).toEqual(["write", "know-intent", "know-mental-health"]);
    // No repo, and no word guess over the todo supplied one.
    expect(row?.repos).toEqual([]);
    expect(row?.repo).toBe("none");
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    expect(inbound[0].text).toContain(grantBlock(["write", "know-intent", "know-mental-health"]));
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

  it("strips a pasted stable prefix at the live commit and puts the live one back", async () => {
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
        reachesTom: true, caller: "opener", now: NOW,
      });
    });
    expect(context.granted.length).toBeGreaterThan(0);
    // One `get` (the todo); everything else is an indexed,
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
