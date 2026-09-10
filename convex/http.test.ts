import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const TTS_TODAY = "C0TTS";
const NEEDS_YOU = "C0NEEDSYOU";

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

async function aTodo(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement: "Reply to Sarah Chen about the lab meeting time",
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: "email",
      provenance: "gmail:message:18f0a1 https://mail.google.com/mail/u/0/#all/18f0a1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

// ── POST /tts/needs-tom picks its room, or posts nothing ─────────────────────
// The route used to omit `channel` when SLACK_TTS_NEEDS_YOU_CHANNEL_ID was
// unset, and the Slack door's default target is SLACK_TTS_CHANNEL_ID — so an
// unset variable did not silence the thread, it moved it into #tts-today, the
// one room the design says nothing but the morning message may write to.
describe("POST /tts/needs-tom: the needs-you room, or nothing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const KEY = "gmail:message:18f0a1";

  async function open(t: ReturnType<typeof convexTest>, todoId: string) {
    return await t.fetch("/tts/needs-tom", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ todoId, reason: "Sarah needs a reply", key: KEY }),
    });
  }

  it("opens the thread in #tts-needs-you when its variable is set", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
    const t = convexTest(schema, modules);
    const res = await open(t, await aTodo(t));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, opened: true, key: KEY });
    const drafts = await events(t, "slack-draft-request");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].data).toMatchObject({ channel: NEEDS_YOU });
    expect(await events(t, "job-failed")).toHaveLength(0);
  });

  it("posts nothing and reports a job failure when the variable is unset", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    // The morning's channel IS set: this is the room the drop used to land in.
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "");
    const t = convexTest(schema, modules);
    const res = await open(t, await aTodo(t));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, opened: false, reported: true });

    // Nothing was written towards a message, and nothing carries the morning's
    // channel: the thread was not moved, it was not opened at all.
    expect(await events(t, "slack-draft-request")).toHaveLength(0);
    expect(await events(t, "needs-tom")).toHaveLength(0);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(JSON.stringify(rows)).not.toContain(TTS_TODAY);

    // And the drop is not silent: one job-failed row, the kind the digest and
    // the hourly update carry to #tts-broken.
    const failed = await events(t, "job-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].key).toBe("tts/needs-tom:needs-you-channel");
    expect(failed[0].data).toMatchObject({ job: "tts/needs-tom" });
    expect(String((failed[0].data as { error: string }).error)).toContain(
      "SLACK_TTS_NEEDS_YOU_CHANNEL_ID",
    );
  });

  // ONE ROW PER CONDITION. The Gmail poller runs every half hour; an unset
  // variable must not become a row every half hour.
  it("reports the same standing drop once, however many threads are dropped", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_TODAY);
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    for (let i = 0; i < 3; i += 1) await open(t, id);
    expect(await events(t, "job-failed")).toHaveLength(1);
  });
});
