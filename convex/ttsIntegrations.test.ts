// An integration Tom declines is an archived todo with his ruling on it — no
// integrations table, no enabled flag. These tests hold that sentence to its
// two halves: the statement shape that means "this is a ruling about an
// integration", and the pair (archived status, archive ruling) that means he
// declined it rather than something tidying a row away.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { integrationName, integrationStatement } from "./ttsIntegrations";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function declineable(
  t: ReturnType<typeof convexTest>,
  statement: string,
  status: "active" | "archived" = "archived",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement,
      readiness: "unprepared",
      status,
      timingClass: "whenever",
      source: "slack-capture",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

async function rule(
  t: ReturnType<typeof convexTest>,
  todoId: Id<"dtsTodos">,
  verdict: "approve" | "revise" | "session" | "archive",
  { sentence, ruledAt = 1_000 }: { sentence?: string; ruledAt?: number } = {},
) {
  await t.run(async (ctx) =>
    ctx.db.insert("dtsRulings", {
      subjectType: "life",
      todoId,
      verdict,
      sentence,
      ruledAt,
    }),
  );
}

const declined = (t: ReturnType<typeof convexTest>) =>
  t.query(internal.ttsIntegrations.internalDeclinedIntegrations, {});

describe("the statement that declines an integration", () => {
  it("is exactly the prefix and a name", () => {
    expect(integrationStatement("outlook")).toBe("integration: outlook");
    expect(integrationName("integration: outlook")).toBe("outlook");
  });

  it("reads the same ruling however Tom's phone capitalized it", () => {
    expect(integrationName("Integration: Outlook")).toBe("outlook");
    expect(integrationName("  integration:   Canvas  ")).toBe("canvas");
  });

  it("never turns a poller off from a todo that merely mentions one", () => {
    // A sentence about an integration is an ordinary todo.
    expect(integrationName("the outlook integration keeps timing out")).toBeNull();
    expect(integrationName("integration outlook")).toBeNull(); // no colon
    expect(integrationName("integration:")).toBeNull(); // names nothing
    expect(integrationName("integration: ")).toBeNull();
    expect(integrationName(undefined)).toBeNull();
    // A paragraph after the prefix is a note about an integration, not a
    // ruling on one.
    expect(integrationName("integration: outlook\nbecause the API is awful")).toBeNull();
  });
});

describe("internalDeclinedIntegrations", () => {
  it("returns the name, the date and his sentence", async () => {
    const t = convexTest(schema, modules);
    const id = await declineable(t, "integration: outlook");
    await rule(t, id, "archive", {
      sentence: "the WPI tenant will not give me a token worth the trouble",
      ruledAt: 1_757_000_000_000,
    });
    expect(await declined(t)).toEqual([
      {
        name: "outlook",
        todoId: id,
        ruledAt: 1_757_000_000_000,
        sentence: "the WPI tenant will not give me a token worth the trouble",
      },
    ]);
  });

  it("needs BOTH halves — an archived row alone is not a decision of his", async () => {
    const t = convexTest(schema, modules);
    // Archived by something else: a cleanup, a batch archive, an agent.
    await declineable(t, "integration: canvas");
    expect(await declined(t)).toEqual([]);

    // Ruled, but not archived: the ruling is history, the status is the fact.
    const active = await declineable(t, "integration: gmail", "active");
    await rule(t, active, "archive");
    expect(await declined(t)).toEqual([]);
  });

  it("ignores an archived row that is not about an integration", async () => {
    const t = convexTest(schema, modules);
    const id = await declineable(t, "buy a new laptop charger");
    await rule(t, id, "archive");
    expect(await declined(t)).toEqual([]);
  });

  it("lets a later ruling take the decline back, keeping the history", async () => {
    const t = convexTest(schema, modules);
    const id = await declineable(t, "integration: canvas");
    await rule(t, id, "archive", { ruledAt: 1_000 });
    expect((await declined(t)).map((d: { name: string }) => d.name)).toEqual([
      "canvas",
    ]);

    // He changed his mind. The archive ruling stays on the row; the newest one
    // decides, and only the newest.
    await rule(t, id, "approve", { ruledAt: 2_000 });
    expect(await declined(t)).toEqual([]);
  });

  it("carries no sentence when he gave none", async () => {
    const t = convexTest(schema, modules);
    const id = await declineable(t, "integration: canvas");
    await rule(t, id, "archive", { sentence: "   " });
    expect((await declined(t))[0].sentence).toBeNull();
  });
});

// The list rides the same read every poller already makes before it captures.
describe("GET /tts/capture-context declined integrations", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves what a poller checks its own name against", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const id = await declineable(t, "integration: outlook");
    await rule(t, id, "archive", { sentence: "not worth the credential" });

    const res = await t.fetch("/tts/capture-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.declinedIntegrations).toEqual([
      {
        name: "outlook",
        todoId: id,
        ruledAt: expect.any(Number),
        sentence: "not worth the credential",
      },
    ]);
    // The triage rules still ride the same payload.
    expect(typeof body.captureTriage).toBe("string");
  });

  it("is an empty list when he has declined nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await t.fetch("/tts/capture-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect((await res.json()).declinedIntegrations).toEqual([]);
  });
});
