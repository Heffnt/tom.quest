// His sentence on a part of tom.quest/design (convex/jarvis/design.ts rule):
// a standing ruling in scope part:<id> with provenance { page: "design" },
// written through the route's own writer, which ends every ruling that stood
// in the scope; the worker-key routes refuse that provenance.

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { NOW, post, registryBody, rulingRow, tom } from "../test/fixtures/design";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("his sentence on a part", () => {
  it("is a standing ruling in scope part:<id>, and a later one supersedes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const { id: first } = await viewer.mutation(api.jarvis.design.rule, { part: "ran", sentence: "it runs every two minutes" });
    vi.setSystemTime(NOW + 60_000);
    const { id: second } = await viewer.mutation(api.jarvis.design.rule, { part: "ran", sentence: "it runs every minute" });
    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "ruling").eq("subject", "part:ran")).collect());
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r._id as string, r]));
    expect(byId.get(second)).toMatchObject({
      provenance: { user: "tom" },
      data: { sentence: "it runs every minute", scope: "part:ran", question: "what working well means for ran", provenance: { page: "design" }, standing: true },
    });
    expect(byId.get(first)?.data).toMatchObject({ standing: false, supersededBy: second });
    const part = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(part?.rulings.map((r) => [r.sentence, r.standing, r.supersededAt])).toEqual([
      ["it runs every minute", true, null],
      ["it runs every two minutes", false, NOW + 60_000],
    ]);
    // His first sentence typed again after the later one replaced it stands again.
    vi.setSystemTime(NOW + 120_000);
    const { id: third } = await viewer.mutation(api.jarvis.design.rule, { part: "ran", sentence: "it runs every two minutes" });
    expect(third).not.toBe(first);
    const standing = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "ruling").eq("subject", "part:ran")).collect());
    expect(standing.filter((r) => (r.data as { standing: boolean }).standing).map((r) => r._id)).toEqual([third]);
    await expect(viewer.mutation(api.jarvis.design.rule, { part: "not-a-part", sentence: "x" })).rejects.toThrow("no part not-a-part");
    await expect(viewer.mutation(api.jarvis.design.rule, { part: "ran", sentence: " " })).rejects.toThrow("a sentence is required");
  });

  it("is refused with the design page's provenance on both worker-key routes", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const standing = await post(t, "/jarvis/standing-ruling", { sentence: "x", scope: "part:ran", question: "q", provenance: { page: "design" } });
    expect(standing.status).toBe(400);
    const event = await post(t, "/jarvis/event", {
      kind: "ruling",
      subject: "part:ran",
      data: { id: `ruling:${"0".repeat(64)}`, sentence: "x", scope: "part:ran", question: "q", provenance: { page: "design" }, standing: true },
    });
    // The generic route refuses a well-formed ruling of any provenance.
    expect(event.status).toBe(403);
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toEqual([]);
  });

  it("ends every standing ruling of the scope, past the first hundred", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    await t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) await ctx.db.insert("events", rulingRow("part:ran", `sentence ${i}`, NOW - 1000 - i));
    });
    const { id } = await viewer.mutation(api.jarvis.design.rule, { part: "ran", sentence: "the one that stands" });
    const standing = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_kind_subject_standing_at", (q) => q.eq("kind", "ruling").eq("subject", "part:ran").eq("data.standing", true))
        .collect(),
    );
    expect(standing.map((r) => r._id)).toEqual([id]);
  });

  it("is refused to everyone but Tom", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const reader = t.withIdentity({ subject: userId });
    await expect(reader.mutation(api.jarvis.design.rule, { part: "ran", sentence: "x" })).rejects.toThrow("Design access is restricted to Tom");
  });
});
