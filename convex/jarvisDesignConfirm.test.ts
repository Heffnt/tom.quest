// "This is right" on tom.quest/design's panel (convex/jarvis/design.ts
// confirm): one explanation-confirmed row, a type only Tom's mutation writes,
// for the part's newest explanation only, and the panel reads only that type.

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { NOW, post, registryBody, tom } from "../test/fixtures/design";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("this is right", () => {
  it("shows the newest explanation, and 'this is right' writes one use row of Tom's however often it is pressed", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const html = "<!doctype html><html><body><h1>idle</h1></body></html>";
    const written = await (await post(t, "/jarvis/event", { kind: "explanation", subject: "idle", provenance: { session: "s1" }, data: { title: "What idle is", html }, text: "What idle is" })).json();
    expect(written.ok).toBe(true);
    const before = await viewer.query(api.jarvis.design.part, { id: "idle" });
    expect(before?.explanation).toMatchObject({ id: written.id, title: "What idle is", html, session: "s1", confirmedAt: null });

    expect(await viewer.mutation(api.jarvis.design.confirm, { part: "idle", explanationId: written.id })).toEqual({ duplicate: false });
    expect(await viewer.mutation(api.jarvis.design.confirm, { part: "idle", explanationId: written.id })).toEqual({ duplicate: true });
    const confirmed = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "explanation-confirmed").eq("subject", "idle")).collect());
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ provenance: { user: "tom" }, data: { part: "idle", explanationId: written.id, id: `confirm:${written.id}` } });
    // Understanding an explanation is not a use of the part: no use row.
    expect(await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "use").eq("subject", "idle")).collect())).toEqual([]);
    expect((await viewer.query(api.jarvis.design.part, { id: "idle" }))?.explanation?.confirmedAt).toBe(confirmed[0].at);
    await expect(viewer.mutation(api.jarvis.design.confirm, { part: "ran", explanationId: written.id })).rejects.toThrow("no explanation");
  });

  it("refuses 'this is right' on an explanation a newer one has replaced, as from a panel opened before it arrived", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const explain = async (title: string) =>
      (await (await post(t, "/jarvis/event", { kind: "explanation", subject: "idle", provenance: { session: "s1" }, data: { title, html: `<!doctype html><h1>${title}</h1>` }, text: title })).json()).id as string;
    const older = await explain("What idle was");
    // The stale panel read the older explanation; a newer one arrives.
    const stale = await viewer.query(api.jarvis.design.part, { id: "idle" });
    expect(stale?.explanation?.id).toBe(older);
    vi.setSystemTime(NOW + 60_000);
    const newer = await explain("What idle is");

    await expect(viewer.mutation(api.jarvis.design.confirm, { part: "idle", explanationId: older })).rejects.toThrow("is not the newest explanation of idle");
    const none = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "explanation-confirmed").eq("subject", "idle")).collect());
    expect(none).toEqual([]);
    expect(await viewer.mutation(api.jarvis.design.confirm, { part: "idle", explanationId: newer })).toEqual({ duplicate: false });
    const part = await viewer.query(api.jarvis.design.part, { id: "idle" });
    expect(part?.explanation).toMatchObject({ id: newer, confirmedAt: NOW + 60_000 });
  });

  it("reads a confirmation only from Tom's own row: a worker's use row with a confirm id is ignored, and a worker cannot post his row", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const written = await (await post(t, "/jarvis/event", { kind: "explanation", subject: "idle", provenance: { session: "s1" }, data: { title: "What idle is", html: "<!doctype html><h1>idle</h1>" }, text: "What idle is" })).json();
    const confirmId = `confirm:${written.id}`;
    // A worker posts a use row carrying the confirm id, under Tom's name.
    const forged = await post(t, "/jarvis/event", { kind: "use", subject: "idle", provenance: { user: "tom" }, data: { part: "idle", by: "tom", what: "this is right", explanationId: written.id, id: confirmId } });
    expect(forged.status).toBe(200);
    expect((await viewer.query(api.jarvis.design.part, { id: "idle" }))?.explanation?.confirmedAt).toBeNull();
    // Neither worker-key route takes his confirmation row.
    const row = { kind: "explanation-confirmed", subject: "idle", provenance: { user: "tom" }, data: { part: "idle", explanationId: written.id, id: confirmId } };
    expect((await post(t, "/jarvis/event", row)).status).toBe(403);
    expect((await post(t, "/tts/event", { kind: "explanation-confirmed", key: "idle", data: row.data })).status).toBe(403);
    // His press still writes his row, and the panel reads it.
    expect(await viewer.mutation(api.jarvis.design.confirm, { part: "idle", explanationId: written.id })).toEqual({ duplicate: false });
    const part = await viewer.query(api.jarvis.design.part, { id: "idle" });
    expect(part?.explanation?.confirmedAt).not.toBeNull();
  });
});
