// tom.quest/design's page and its read-only panel (convex/jarvis/design.ts):
// the newest registry with each part's state and the counts, a state cut by
// its byte budget shown as partial, and one part's panel: its sentences from
// the model-of-tom files the record holds, its state, and the rulings in its
// scope. The registry rows' routes and the diff view are
// convex/jarvisDesign.test.ts's.

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { evidenceEntry } from "./jarvis/design";
import { DAY, EVIDENCE, NOW, PARTS, post, registryBody, rulingRow, seed, tom } from "../test/fixtures/design";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the evidence entry a serves reference names", () => {
  it("finds the entry by its heading and first eight words, or its line number, with its said entries only", () => {
    const found = evidenceEntry(EVIDENCE, "Fixture entries#the ran part serves this fixture line, and");
    expect(found).toEqual({
      line: "the ran part serves this fixture line, and more words after.",
      said: [{ date: "2026-10-04", source: "session aaa9ae16", sentence: "the sentence the fixture said" }],
    });
    expect(evidenceEntry(EVIDENCE, "Fixture entries#8")?.said[0].sentence).toBe("another sentence");
    expect(evidenceEntry(EVIDENCE, "Other heading#another entry")).toBeNull();
  });
});

describe("the page", () => {
  it("answers no registry until the box posts one, then the newest, with each part's state and the counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    expect(await viewer.query(api.jarvis.design.page, {})).toEqual({ registry: null });
    await seed(t);

    expect((await post(t, "/jarvis/event", registryBody("aaaaaaa1", PARTS.slice(0, 2)))).status).toBe(200);
    vi.setSystemTime(NOW + 1000);
    const first = await (await post(t, "/jarvis/event", registryBody("bbbbbbb2"))).json();
    const again = await (await post(t, "/jarvis/event", registryBody("bbbbbbb2"))).json();
    expect(again).toMatchObject({ ok: true, id: first.id, duplicate: true });

    const page = await viewer.query(api.jarvis.design.page, {});
    expect(page.registry).toMatchObject({ subject: "Jarvis@bbbbbbb2", sha: "bbbbbbb2" });
    expect(page.registry?.parts.map((p) => p.id)).toEqual(PARTS.map((p) => p.id));
    expect(page.states).toEqual({ ran: "run", broken: "issue", gone: "unverified", "outcome-only": "unverified", idle: "unverified" });
    expect(page.counts).toEqual({ parts: 5, unverified: 3, issue: 1, partial: 0, removedStillRun: 1, noSentence: 1 });
  });

  it("shows a state whose rows filled the byte budget as partial, counted as partial and not as its state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    // "idle" carries more bytes of use rows than partStates reads for every
    // part together (8 MiB), so its state is not definitive.
    for (let i = 0; i < 10; i++) {
      await t.run((ctx) => ctx.db.insert("events", { kind: "use", at: NOW - DAY - i, provenance: { job: "x" }, subject: "idle", data: { part: "idle", by: "job", what: "x", pad: "x".repeat(950_000) } }));
    }
    const page = await viewer.query(api.jarvis.design.page, {});
    expect(page.states?.idle).toBe("partial");
    expect(page.counts).toMatchObject({ partial: 1, unverified: 4 });
  });

  it("refuses everyone but Tom", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const reader = t.withIdentity({ subject: userId });
    await expect(reader.query(api.jarvis.design.page, {})).rejects.toThrow("Design access is restricted to Tom");
    await expect(reader.query(api.jarvis.design.part, { id: "ran" })).rejects.toThrow("Design access is restricted to Tom");
  });
});

describe("one part's panel", () => {
  it("joins the sentences to the evidence the record holds, and marks what it does not hold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await seed(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const part = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(part?.serves).toEqual([
      {
        form: "evidence",
        ref: "intent.md#Fixture entries#the ran part serves this fixture line",
        file: "intent.md",
        line: null,
        said: [],
      },
      { form: "evidence", ref: "intent.md#No such heading#a line", file: "intent.md", line: null, said: [] },
      { form: "guarantee", label: "G4", line: "the fixture guarantee line." },
    ]);
    // The first reference names seven words of an eight-word key, so it
    // matches no entry; the eight-word reference does.
    const exact = PARTS.map((p) => (p.id === "ran" ? { ...p, serves: [{ evidence: "intent.md#Fixture entries#the ran part serves this fixture line, and" }] } : p));
    await post(t, "/jarvis/event", registryBody("ccccccc3", exact));
    const joined = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(joined?.serves[0]).toMatchObject({ form: "evidence", said: [{ date: "2026-10-04", sentence: "the sentence the fixture said" }] });
  });

  it("shows the state and the row behind it, the rulings in the part's scope standing first, and no cut", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await seed(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    await t.run(async (ctx) => {
      await ctx.db.insert("events", rulingRow("part:ran", "an older sentence", NOW - 3 * DAY, { standing: false, supersededBy: "x", supersededAt: NOW - 2 * DAY }));
      await ctx.db.insert("events", rulingRow("part:ran", "the standing sentence", NOW - 2 * DAY));
    });
    const part = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(part?.state).toMatchObject({ state: "run", partial: false, row: { kind: "job-ok", at: NOW - DAY }, inUseDays: 30, workingAfterDays: 7 });
    expect(part?.rulings.map((r) => [r.sentence, r.standing, r.supersededAt])).toEqual([
      ["the standing sentence", true, null],
      ["an older sentence", false, NOW - 2 * DAY],
    ]);
    expect(part?.cuts).toEqual([]);
    expect(await viewer.query(api.jarvis.design.part, { id: "not-a-part" })).toBeNull();
  });

  it("reads under one byte budget, and says which read the budget stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    // Rulings of the scope past their 1 MiB allotment: the read stops there.
    for (let i = 0; i < 3; i++) {
      await t.run((ctx) => ctx.db.insert("events", rulingRow("part:idle", `sentence ${i} ${"x".repeat(600_000)}`, NOW - DAY - i)));
    }
    const part = await viewer.query(api.jarvis.design.part, { id: "idle" });
    expect(part?.cuts.map((cut) => cut.what)).toContain("rulings in the part's scope");
  });
});
