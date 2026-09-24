// The /secrets mailbox (convex/secrets.ts) and its two daemon doors
// (GET /sessions/secrets, POST /sessions/secrets/taken in convex/http.ts).
// What must hold: only Tom sets and lists; no query returns a value; only the
// daemon's key reads one; a taken value is deleted while its name and dates
// stay; a value set during a delivery survives that delivery's report.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "sessions-key";
const VALUE = "hf_live_value_1234567890";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    tom: await ctx.db.insert("users", { name: "tom", role: "tom" }),
    admin: await ctx.db.insert("users", { name: "admin", role: "admin" }),
    agent: await ctx.db.insert("users", { name: "agent", role: "agent" }),
  }));
  return {
    t,
    tom: t.withIdentity({ subject: ids.tom }),
    admin: t.withIdentity({ subject: ids.admin }),
    agent: t.withIdentity({ subject: ids.agent }),
  };
}

async function pending(t: ReturnType<typeof convexTest>, key: string | null = KEY) {
  return await t.fetch("/sessions/secrets", {
    method: "GET",
    headers: key === null ? {} : { "X-Sessions-Key": key },
  });
}

async function taken(t: ReturnType<typeof convexTest>, body: Record<string, unknown>, key = KEY) {
  return await t.fetch("/sessions/secrets/taken", {
    method: "POST",
    headers: { "X-Sessions-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("secretMailbox").collect());
}

beforeEach(() => {
  vi.stubEnv("SESSIONS_WORKER_KEY", KEY);
  vi.stubEnv("TTS_WORKER_KEY", "tts-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("secrets.set and secrets.list", () => {
  it("stores a value Tom sets and lists only its name and date", async () => {
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: `${VALUE}\n` });
    const listed = await tom.query(api.secrets.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("HF_TOKEN");
    expect(typeof listed[0].setAt).toBe("number");
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    // The pasted trailing newline is gone: it would split the env-file line.
    expect((await rows(t))[0].value).toBe(VALUE);
  });

  it("refuses everyone but Tom, the agent account included", async () => {
    const { admin, agent } = await setup();
    for (const who of [admin, agent]) {
      await expect(who.mutation(api.secrets.set, { name: "HF_TOKEN", value: VALUE })).rejects.toThrow(
        /Secrets access is restricted to Tom/,
      );
      await expect(who.query(api.secrets.list, {})).rejects.toThrow(/Secrets access is restricted to Tom/);
    }
  });

  it("refuses a malformed name or value and never echoes the value", async () => {
    const { tom } = await setup();
    await expect(tom.mutation(api.secrets.set, { name: "hf-token", value: VALUE })).rejects.toThrow(/name must be/);
    await expect(tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: "   " })).rejects.toThrow(/HF_TOKEN: value is empty/);
    const split = `${VALUE}\nEVIL=1`;
    const err = await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: split }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HF_TOKEN: value contains a line break/);
    expect(String(err)).not.toContain(VALUE);
  });

  it("keeps one row per name: a second set replaces the value and clears the taken date", async () => {
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: "first-value" });
    const [first] = await rows(t);
    expect((await taken(t, { name: "HF_TOKEN", setAt: first.setAt })).status).toBe(200);
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: "second-value" });
    const after = await rows(t);
    expect(after).toHaveLength(1);
    expect(after[0].value).toBe("second-value");
    expect(after[0].takenAt).toBeUndefined();
  });
});

describe("the daemon's doors", () => {
  it("hands a waiting value to the daemon's key", async () => {
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: VALUE });
    const res = await pending(t);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secrets: { name: string; value: string; setAt: number }[] };
    expect(body.secrets).toEqual([{ name: "HF_TOKEN", value: VALUE, setAt: (await rows(t))[0].setAt }]);
  });

  it("refuses a read without the daemon's key: no key, a wrong key, and the TTS worker key", async () => {
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: VALUE });
    for (const key of [null, "wrong", "tts-key"]) {
      const res = await pending(t, key);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(VALUE);
    }
    const ttsDoor = await t.fetch("/sessions/secrets", { method: "GET", headers: { "X-TTS-Key": "tts-key" } });
    expect(ttsDoor.status).toBe(401);
  });

  it("refuses a taken report without the daemon's key and changes nothing", async () => {
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: VALUE });
    const [row] = await rows(t);
    expect((await taken(t, { name: "HF_TOKEN", setAt: row.setAt }, "wrong")).status).toBe(401);
    expect((await rows(t))[0].value).toBe(VALUE);
  });

  it("deletes the value on taken and keeps the name and both dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: VALUE });
    const [row] = await rows(t);
    vi.setSystemTime(new Date("2026-09-24T12:00:30Z"));
    const res = await taken(t, { name: "HF_TOKEN", setAt: row.setAt });
    expect(res.status).toBe(200);
    const [after] = await rows(t);
    expect(after).not.toHaveProperty("value");
    expect(after.name).toBe("HF_TOKEN");
    expect(after.setAt).toBe(Date.parse("2026-09-24T12:00:00Z"));
    expect(after.takenAt).toBe(Date.parse("2026-09-24T12:00:30Z"));
    expect(await tom.query(api.secrets.list, {})).toEqual([
      { name: "HF_TOKEN", setAt: after.setAt, takenAt: after.takenAt },
    ]);
    const again = (await (await pending(t)).json()) as { secrets: unknown[] };
    expect(again.secrets).toEqual([]);
  });

  it("keeps a value Tom set while the box was taking the previous one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    const { t, tom } = await setup();
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: "old-value" });
    const [read] = await rows(t);
    vi.setSystemTime(new Date("2026-09-24T12:00:05Z"));
    await tom.mutation(api.secrets.set, { name: "HF_TOKEN", value: "new-value" });
    const res = await taken(t, { name: "HF_TOKEN", setAt: read.setAt });
    expect(res.status).toBe(409);
    const [after] = await rows(t);
    expect(after.value).toBe("new-value");
    expect(after.takenAt).toBeUndefined();
  });
});
