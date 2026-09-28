// Which roles every Tom-gated Convex function admits, recorded before the gate
// code was refactored and required to hold unchanged after it.
//
// HOW IT DRIVES THE GATE: every public query and mutation of the modules below
// is called once per role (signed out, user, admin, agent, tom) through the
// real Convex runtime that convex-test provides, with its handler invoked
// directly so that no argument validator stands in front of the gate. Each
// handler's first act is its gate; a refused caller gets the gate's error, and
// any other outcome (a result, or a later error from the empty arguments)
// means the gate let the caller through. Every call is rolled back, so no
// call's writes reach the next one.
//
// WHAT IS RECORDED: per function and role, either "admitted" or the exact
// refusal message, so a change to who is admitted or to what a refused caller
// reads fails this test.
//
// The record is literal on purpose: a test that re-derives its expectation
// from the gate code would pass whatever the gate code did.

import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// Every module whose functions call the Tom gate or the agent read gate.
const GATED_MODULES = [
  "agents",
  "boxChanges",
  "claudeSessions",
  "dayLog",
  "forge",
  "intent",
  "jarvis/events",
  "jarvis/intent",
  "observe",
  "secrets",
  "sessionRows",
  "tts",
  "ttsCalendar",
  "ttsCode",
  "ttsRepeats",
  "ttsRulings",
  "ttsSignoff",
  "users",
  "vocabulary",
] as const;

const ROLES = ["guest", "user", "admin", "agent", "tom"] as const;
type Role = (typeof ROLES)[number];

const REFUSAL = /access is restricted to Tom$|^Authentication required$|^Only Tom can /;

class RollBack extends Error {}

type Registered = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
};

async function gatedFunctions(): Promise<Array<[string, Registered]>> {
  const out: Array<[string, Registered]> = [];
  for (const mod of GATED_MODULES) {
    const loaded = await modules[`./${mod}.ts`]!();
    for (const [name, value] of Object.entries(loaded)) {
      const fn = value as Partial<Registered> | null;
      if (!fn || typeof fn !== "function" && typeof fn !== "object") continue;
      if (!fn.isPublic || !(fn.isQuery || fn.isMutation)) continue;
      out.push([`${mod}:${name}`, fn as Registered]);
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

async function outcome(
  t: ReturnType<typeof convexTest>,
  userIds: Partial<Record<Role, string>>,
  role: Role,
  fn: Registered,
): Promise<string> {
  const as = role === "guest" ? t : t.withIdentity({ subject: userIds[role]! });
  let result = "admitted";
  try {
    await as.run(async (ctx) => {
      try {
        await fn._handler(ctx, {});
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (REFUSAL.test(message)) result = message;
      }
      throw new RollBack();
    });
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  }
  return result;
}

async function record(): Promise<Record<string, Record<Role, string>>> {
  const t = convexTest(schema, modules);
  const userIds: Partial<Record<Role, string>> = {};
  for (const role of ["user", "admin", "agent", "tom"] as const) {
    userIds[role] = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: role, email: `${role}@tom.quest`, role }),
    );
  }
  const out: Record<string, Record<Role, string>> = {};
  for (const [name, fn] of await gatedFunctions()) {
    const row = {} as Record<Role, string>;
    for (const role of ROLES) row[role] = await outcome(t, userIds, role, fn);
    out[name] = row;
  }
  return out;
}

const A = "admitted";
const AUTH = "Authentication required";
const tomOnly = (label: string) => {
  const refused = `${label} access is restricted to Tom`;
  return { guest: AUTH, user: refused, admin: refused, agent: refused, tom: A };
};
const tomOrAgent = (label: string) => {
  const refused = `${label} access is restricted to Tom`;
  return { guest: AUTH, user: refused, admin: refused, agent: A, tom: A };
};

const EXPECTED: Record<string, Record<Role, string>> = {
  "agents:children": tomOnly("Agents"),
  "agents:entry": tomOnly("Agents"),
  "agents:get": tomOnly("Agents"),
  "agents:labels": tomOnly("Agents"),
  "agents:markOpened": tomOnly("Agents"),
  "agents:materializeStatus": tomOnly("Agents"),
  "agents:requestMaterialize": tomOnly("Agents"),
  "agents:roots": tomOnly("Agents"),
  "agents:rows": tomOnly("Agents"),
  "boxChanges:forAgent": tomOnly("Agents"),
  "claudeSessions:createSession": tomOnly("Sessions"),
  "claudeSessions:forceClose": tomOnly("Sessions"),
  "claudeSessions:forkSessionAs": tomOnly("Sessions"),
  "claudeSessions:getDaemonHealth": tomOnly("Sessions"),
  "claudeSessions:getMessageOverflow": tomOnly("Sessions"),
  "claudeSessions:getMessages": tomOnly("Sessions"),
  "claudeSessions:getPendingInbound": tomOnly("Sessions"),
  "claudeSessions:getSession": tomOnly("Sessions"),
  "claudeSessions:getStreamBuf": tomOnly("Sessions"),
  "claudeSessions:listSessions": tomOnly("Sessions"),
  "claudeSessions:renameSession": tomOnly("Sessions"),
  "claudeSessions:reopenSession": tomOnly("Sessions"),
  "claudeSessions:sendControl": tomOnly("Sessions"),
  "claudeSessions:sendMessage": tomOnly("Sessions"),
  "claudeSessions:setSessionModel": tomOnly("Sessions"),
  "dayLog:page": tomOnly("Log"),
  "dayLog:series": tomOnly("Log"),
  "dayLog:submit": tomOnly("Log"),
  "dayLog:trainingDay": tomOnly("Log"),
  "forge:appendMessage": tomOnly("Forge"),
  "forge:createJob": tomOnly("Forge"),
  "forge:getJob": tomOnly("Forge"),
  "forge:listMessages": tomOnly("Forge"),
  "forge:listMine": tomOnly("Forge"),
  "forge:setServe": tomOnly("Forge"),
  "forge:updateJobStatus": tomOnly("Forge"),
  "intent:agentView": tomOnly("Intent"),
  "intent:lines": tomOnly("Intent"),
  "jarvis/events:forAgent": tomOnly("Agents"),
  "jarvis/events:recent": tomOnly("Agents"),
  "jarvis/intent:decisions": tomOnly("Intent"),
  "jarvis/intent:evalItems": tomOnly("Intent"),
  "jarvis/intent:settle": tomOnly("Intent"),
  "observe:approveChange": tomOnly("Agents"),
  "observe:changesWaiting": tomOnly("Agents"),
  "observe:define": tomOnly("Agents"),
  "observe:eventsInWindow": tomOnly("Agents"),
  "observe:gateRows": tomOnly("Agents"),
  "observe:recordInWindow": tomOnly("Agents"),
  "observe:rulingsInWindow": tomOnly("Agents"),
  "observe:runsInWindow": tomOnly("Agents"),
  "observe:waitingOnTom": tomOnly("Agents"),
  "secrets:list": tomOnly("Secrets"),
  "secrets:set": tomOnly("Secrets"),
  "sessionRows:notes": tomOnly("Sessions"),
  "tts:createBlock": tomOnly("TTS"),
  "tts:createTimeNote": tomOnly("TTS"),
  "tts:createTodo": tomOnly("TTS"),
  "tts:deleteBlock": tomOnly("TTS"),
  "tts:deleteTimeNote": tomOnly("TTS"),
  "tts:listBlocks": tomOrAgent("TTS"),
  "tts:listMirror": tomOrAgent("TTS"),
  "tts:listRecentEvents": tomOrAgent("TTS"),
  "tts:listTimeNotes": tomOrAgent("TTS"),
  "tts:listTodos": tomOrAgent("TTS"),
  "tts:recordDateOutcome": tomOnly("TTS"),
  "tts:recordEvent": tomOnly("TTS"),
  "tts:setStatus": tomOnly("TTS"),
  "tts:updateBlock": tomOnly("TTS"),
  "tts:updateTodo": tomOnly("TTS"),
  "ttsCalendar:listCalendarEvents": tomOrAgent("TTS"),
  "ttsCode:listCodeBriefs": tomOrAgent("TTS"),
  "ttsRepeats:createRepeat": tomOnly("TTS"),
  "ttsRepeats:deleteRepeat": tomOnly("TTS"),
  "ttsRepeats:listRepeats": tomOrAgent("TTS"),
  "ttsRepeats:updateRepeat": tomOnly("TTS"),
  "ttsRulings:listRulings": tomOrAgent("TTS"),
  "ttsRulings:recordRuling": tomOnly("TTS"),
  "ttsSignoff:decline": tomOnly("TTS"),
  "ttsSignoff:listProposals": tomOnly("TTS"),
  "ttsSignoff:signAndSend": tomOnly("TTS"),
  "users:promoteToAdmin": { guest: "Only Tom can promote admins", user: "Only Tom can promote admins", admin: "Only Tom can promote admins", agent: "Only Tom can promote admins", tom: "admitted" },
  "users:setRoleByUsername": tomOnly("User roles"),
  "users:setTomByUsername": { guest: "admitted", user: "admitted", admin: "admitted", agent: "admitted", tom: "admitted" },
  "users:viewer": { guest: "admitted", user: "admitted", admin: "admitted", agent: "admitted", tom: "admitted" },
  "vocabulary:current": tomOnly("Vocabulary"),
};

describe("the admitted roles of every Tom-gated Convex function", () => {
  beforeAll(() => {
    // A handler that gets through may schedule work; fake timers keep a
    // scheduled function from running after its call was rolled back.
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("match the record taken before the gate refactor", async () => {
    const actual = await record();
    expect(actual).toEqual(EXPECTED);
  }, 120_000);
});
