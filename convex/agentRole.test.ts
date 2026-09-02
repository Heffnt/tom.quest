import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { AGENT_READABLE_SURFACES, isAgentReadableSurface } from "./agentSurfaces";
import { roleAccess } from "./authRoles";

// The `agent` role: what a TTS session's headless browser signs in as. The
// bug these tests exist to keep out is the one that made the role necessary —
// an account that may LOOK at a page also being able to change what it looks
// at. Every assertion below is of the shape "reads yes, writes no".

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withRole(
  t: ReturnType<typeof convexTest>,
  role: "user" | "admin" | "tom" | "agent",
) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: role,
      email: `${role}@tom.quest`,
      role,
    }),
  );
  return { id, as: t.withIdentity({ subject: id }) };
}

describe("roleAccess for agent", () => {
  it("fails closed: neither admin nor Tom", () => {
    const access = roleAccess("agent");
    expect(access.role).toBe("agent");
    expect(access.isAdmin).toBe(false);
    expect(access.isTom).toBe(false);
    expect(access.isAgent).toBe(true);
  });

  // The whole security argument rests on this: ~217 existing gates ask
  // isAdmin or isTom and were never touched, so if either ever became true
  // for `agent` the role would silently acquire all of them at once.
  it("leaves the other three roles' answers exactly as they were", () => {
    expect(roleAccess("tom")).toMatchObject({ isAdmin: true, isTom: true, isAgent: false });
    expect(roleAccess("admin")).toMatchObject({ isAdmin: true, isTom: false, isAgent: false });
    expect(roleAccess("user")).toMatchObject({ isAdmin: false, isTom: false, isAgent: false });
    expect(roleAccess(undefined)).toMatchObject({ role: "user", isAdmin: false, isTom: false, isAgent: false });
  });
});

describe("agent-readable surfaces", () => {
  it("names TTS and Turing and nothing else", () => {
    expect([...AGENT_READABLE_SURFACES]).toEqual(["TTS", "Turing"]);
  });

  // These are labels requireTom already passes elsewhere in the codebase; the
  // point of naming them here is that they are NOT readable by `agent`.
  it.each(["Sessions", "Forge", "Jarvis", "User roles", ""])(
    "refuses %j",
    (label) => {
      expect(isAgentReadableSurface(label)).toBe(false);
    },
  );
});

describe("TTS reads admit agent", () => {
  it("serves every query the /tts page renders from", async () => {
    const t = convexTest(schema, modules);
    const { as: agent } = await withRole(t, "agent");

    await expect(agent.query(api.tts.listTodos, {})).resolves.toEqual([]);
    await expect(agent.query(api.tts.listMirror, {})).resolves.toEqual([]);
    await expect(agent.query(api.tts.listBatches, {})).resolves.toEqual([]);
    await expect(agent.query(api.tts.getToday, {})).resolves.toBeDefined();
    await expect(agent.query(api.tts.listRecentEvents, {})).resolves.toEqual([]);
    await expect(
      agent.query(api.tts.listBlocks, { start: 0, end: 1 }),
    ).resolves.toEqual([]);
    await expect(agent.query(api.tts.listTimeNotes, {})).resolves.toBeTruthy();
    await expect(
      agent.query(api.ttsCalendar.listCalendarEvents, { start: 0, end: 1 }),
    ).resolves.toEqual([]);
    await expect(agent.query(api.ttsCode.listCodeBriefs, {})).resolves.toEqual([]);
    await expect(agent.query(api.ttsRepeats.listRepeats, {})).resolves.toEqual([]);
    await expect(agent.query(api.ttsRulings.listRulings, {})).resolves.toEqual([]);
    await expect(
      agent.query(api.ttsSkills.getSkill, { name: "writing" }),
    ).resolves.toBeNull();
  });

  // The read gate widened for `agent` ONLY. Signed-out, `user` and `admin`
  // callers must be refused exactly as before — widening a gate one role too
  // far is the easy version of this mistake.
  it("still refuses anonymous, user and admin callers", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.tts.listTodos, {})).rejects.toThrow();
    const { as: user } = await withRole(t, "user");
    await expect(user.query(api.tts.listTodos, {})).rejects.toThrow(/restricted to Tom/);
    await expect(user.query(api.ttsRulings.listRulings, {})).rejects.toThrow(/restricted to Tom/);
    const { as: admin } = await withRole(t, "admin");
    await expect(admin.query(api.tts.listTodos, {})).rejects.toThrow(/restricted to Tom/);
    await expect(admin.query(api.ttsCode.listCodeBriefs, {})).rejects.toThrow(/restricted to Tom/);
  });
});

describe("TTS writes refuse agent", () => {
  it("refuses every mutation the /tts page can fire", async () => {
    const t = convexTest(schema, modules);
    const { as: tom } = await withRole(t, "tom");
    const { as: agent } = await withRole(t, "agent");
    // A real row to aim the id-taking mutations at, so a refusal is the gate
    // talking and not a "not found" from an invented id.
    const todoId = (await tom.mutation(api.tts.createTodo, {
      statement: "a real todo",
    })) as Id<"dtsTodos">;

    const denied = /restricted to Tom/;
    await expect(
      agent.mutation(api.tts.createTodo, { statement: "no" }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.tts.updateTodo, { id: todoId, statement: "no" }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.tts.setStatus, { id: todoId, status: "archived" }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.tts.createBlock, { start: 1, end: 2 }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.tts.createTimeNote, { text: "no", todoId }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.ttsRepeats.createRepeat, {
        statement: "no",
        daysOfWeek: ["monday"],
      }),
    ).rejects.toThrow(denied);
    await expect(
      agent.mutation(api.ttsRulings.recordRuling, {
        todoId,
        verdict: "approve",
      }),
    ).rejects.toThrow(denied);
  });

  // The specific write that used to fire on ARRIVAL, before any click. It is
  // refused here AND suppressed client-side (tts-client.tsx gates it on
  // isTom), because a refused mutation prints a console error that tts-browse
  // reports as page breakage — a false positive on every /tts screenshot.
  it("refuses the instrumentation mutation /tts fires on load", async () => {
    const t = convexTest(schema, modules);
    const { as: agent } = await withRole(t, "agent");
    await expect(
      agent.mutation(api.tts.recordEvent, { kind: "tts-opened" }),
    ).rejects.toThrow(/restricted to Tom/);
    await expect(
      agent.mutation(api.tts.recordEvent, { kind: "engaged" }),
    ).rejects.toThrow(/restricted to Tom/);
  });
});

describe("surfaces outside the list refuse agent entirely", () => {
  it("refuses the Sessions surface, reads included", async () => {
    const t = convexTest(schema, modules);
    const { as: agent } = await withRole(t, "agent");
    await expect(agent.query(api.claudeSessions.listSessions, {})).rejects.toThrow(
      /restricted to Tom/,
    );
  });

  it("refuses the Forge surface, reads included", async () => {
    const t = convexTest(schema, modules);
    const { as: agent } = await withRole(t, "agent");
    await expect(agent.query(api.forge.listMine, {})).rejects.toThrow(
      /restricted to Tom/,
    );
  });
});

describe("users.setRoleByUsername", () => {
  it("lets Tom grant the agent role by the name typed at sign-up", async () => {
    const t = convexTest(schema, modules);
    const { as: tom } = await withRole(t, "tom");
    const { id: userId } = await withRole(t, "user");
    await tom.mutation(api.users.setRoleByUsername, {
      username: "user",
      role: "agent",
    });
    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after?.role).toBe("agent");
  });

  // The missing half before this mutation existed: promoteToAdmin could only
  // ever raise a role, and nothing could lower one.
  it("takes a role back as well as granting one", async () => {
    const t = convexTest(schema, modules);
    const { as: tom } = await withRole(t, "tom");
    const { id: agentId } = await withRole(t, "agent");
    await tom.mutation(api.users.setRoleByUsername, {
      username: "agent",
      role: "user",
    });
    expect((await t.run(async (ctx) => ctx.db.get(agentId)))?.role).toBe("user");
  });

  it("refuses a caller who is not Tom — including the agent role itself", async () => {
    const t = convexTest(schema, modules);
    await withRole(t, "tom");
    const { as: agent } = await withRole(t, "agent");
    const { as: admin } = await withRole(t, "admin");
    await expect(
      agent.mutation(api.users.setRoleByUsername, { username: "user", role: "admin" }),
    ).rejects.toThrow(/restricted to Tom/);
    await expect(
      admin.mutation(api.users.setRoleByUsername, { username: "user", role: "admin" }),
    ).rejects.toThrow(/restricted to Tom/);
  });

  // A typo'd username must not be able to lock Tom out of his own site.
  it("refuses to touch an account already at tom", async () => {
    const t = convexTest(schema, modules);
    const { as: tom, id: tomId } = await withRole(t, "tom");
    await expect(
      tom.mutation(api.users.setRoleByUsername, { username: "tom", role: "user" }),
    ).rejects.toThrow(/cannot be changed/);
    expect((await t.run(async (ctx) => ctx.db.get(tomId)))?.role).toBe("tom");
  });

  it("reports an unknown username instead of silently doing nothing", async () => {
    const t = convexTest(schema, modules);
    const { as: tom } = await withRole(t, "tom");
    await expect(
      tom.mutation(api.users.setRoleByUsername, { username: "nobody", role: "agent" }),
    ).rejects.toThrow(/User not found/);
  });
});

// A source-level invariant, because the enumerated mutation tests above can
// only cover mutations that exist today. This one fails the moment someone
// puts the READ gate in front of a write — the single mistake that would undo
// the whole split — no matter which mutation it is or when it is added.
describe("the read gate never guards a write", () => {
  const TTS_MODULES = [
    "tts.ts",
    "ttsCalendar.ts",
    "ttsCode.ts",
    "ttsRepeats.ts",
    "ttsRulings.ts",
    "ttsSkills.ts",
  ];

  it.each(TTS_MODULES)("%s: requireTomOrAgent appears only inside query()", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8");
    // Split on every top-level export so each chunk is one function, then
    // check the chunks that are NOT queries.
    const chunks = source.split(/\nexport const /).slice(1);
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf(" "));
      const isQuery = /^\S+ = (?:internalQuery|query)\(/.test(chunk);
      if (isQuery) continue;
      expect(
        chunk.includes("requireTomOrAgent"),
        `${file}: ${name} is not a query but reaches for the read gate`,
      ).toBe(false);
    }
  });
});
