import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// From the convex root, as every other test: convex-test names modules by
// their path under convex/, so a glob from a subdirectory finds none of them.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = (t: ReturnType<typeof convexTest>, path: string, body: unknown, headers: Record<string, string>) =>
  t.fetch(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

const subscription = (endpoint: string, p256dh = `p256dh-${endpoint}`) => ({
  endpoint,
  keys: { p256dh, auth: `auth-${endpoint}` },
});

const { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE } = webpush.generateVAPIDKeys();

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

const pushRows = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => ctx.db.query("events").filter((q) => q.eq(q.field("kind"), "push-subscription")).collect());

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("push", () => {
  it("saveSubscription refuses a signed-out caller and succeeds for Tom, writing one event", async () => {
    const t = convexTest({ schema, modules });
    const sub = subscription("https://push.example/a");
    await expect(t.mutation(api.push.saveSubscription, { subscription: sub })).rejects.toThrow();
    expect(await pushRows(t)).toEqual([]);

    const tom = await withTom(t);
    await tom.mutation(api.push.saveSubscription, { subscription: sub });
    const rows = await pushRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "push-subscription", subject: sub.endpoint });
    expect(rows[0].data).toMatchObject({ live: true, subscription: sub });
  });

  it("liveSubscriptions returns the latest per endpoint and drops a marked-gone endpoint", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a1 = subscription("https://push.example/a");
    const a2 = subscription("https://push.example/a", "p256dh-a2");
    const b = subscription("https://push.example/b");
    await tom.mutation(api.push.saveSubscription, { subscription: a1 });
    await tom.mutation(api.push.saveSubscription, { subscription: b });
    await tom.mutation(api.push.saveSubscription, { subscription: a2 });

    const live = (await t.query(internal.push.liveSubscriptions, {})) as Array<{ endpoint: string }>;
    expect(live).toHaveLength(2);
    const aLive = live.find((s) => s.endpoint === a1.endpoint);
    expect(aLive).toEqual(a2);
    expect(live).toEqual(expect.arrayContaining([b]));

    await t.mutation(internal.push.markGone, { endpoint: a1.endpoint, reason: "push service answered 410" });
    const after = (await t.query(internal.push.liveSubscriptions, {})) as Array<{ endpoint: string }>;
    expect(after).toEqual([b]);
  });

  it("POST /jarvis/push answers 401 without the key, 400 without a title, and 503 when VAPID is unset", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    expect((await post(t, "/jarvis/push", { title: "hi" }, {})).status).toBe(401);

    const noTitle = await post(t, "/jarvis/push", {}, { "X-Jarvis-Key": "k" });
    expect(noTitle.status).toBe(400);
    expect((await noTitle.json()).ok).toBe(false);

    const unset = await post(t, "/jarvis/push", { title: "hi" }, { "X-Jarvis-Key": "k" });
    expect(unset.status).toBe(503);
    const unsetBody = await unset.json();
    expect(unsetBody.error).toContain("VAPID_PUBLIC_KEY");
    expect(unsetBody.error).toContain("VAPID_PRIVATE_KEY");
  });

  it("POST /jarvis/push sends to no subscriptions and answers an empty result", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    vi.stubEnv("VAPID_PUBLIC_KEY", VAPID_PUBLIC);
    vi.stubEnv("VAPID_PRIVATE_KEY", VAPID_PRIVATE);
    const res = await post(t, "/jarvis/push", { title: "hi" }, { "X-Jarvis-Key": "k" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 0, failed: 0, gone: 0, errors: [] });
  });

  it("POST /jarvis/event refuses a push-subscription kind and writes no event", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const res = await post(
      t,
      "/jarvis/event",
      { kind: "push-subscription", subject: "https://push.example/x", data: { live: true } },
      { "X-Jarvis-Key": "k" },
    );
    expect(res.status).not.toBe(200);
    expect(await pushRows(t)).toEqual([]);
  });

  it("sendTest refuses a signed-out caller", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.action(api.pushSend.sendTest, { endpoint: "https://push.example/a" })).rejects.toThrow();
  });

  it("sendTest returns an empty result for Tom with VAPID stubbed and no subscriptions", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("VAPID_PUBLIC_KEY", VAPID_PUBLIC);
    vi.stubEnv("VAPID_PRIVATE_KEY", VAPID_PRIVATE);
    const tom = await withTom(t);
    expect(await tom.action(api.pushSend.sendTest, { endpoint: "https://push.example/a" })).toEqual({
      sent: 0,
      failed: 0,
      gone: 0,
      errors: [],
    });
  });
});
