import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { newYorkInstant } from "../shared/clock.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const RANGE = { from: "2026-10-01", to: "2026-10-07" };

type T = ReturnType<typeof convexTest>;

async function as(t: T, role: "tom" | "agent" | "user") {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: role, email: `${role}@example.test`, role }));
  return t.withIdentity({ subject: id });
}

function at(day: string, hour: number, minute = 0) {
  return newYorkInstant(day, hour, minute);
}

async function event(t: T, row: { kind: string; at: number; data?: unknown; text?: string; subject?: string; provenance?: Record<string, string> }) {
  return await t.run((ctx) => ctx.db.insert("events", {
    kind: row.kind,
    at: row.at,
    provenance: row.provenance ?? {},
    data: row.data ?? {},
    ...(row.text === undefined ? {} : { text: row.text }),
    ...(row.subject === undefined ? {} : { subject: row.subject }),
  }));
}

async function dayLog(t: T, day: string, text: string, items: Array<Record<string, unknown>>) {
  await t.run(async (ctx) => {
    const entryId = await ctx.db.insert("dayLogEntries", { text, createdAt: at(day, 9), day, status: "applied" });
    for (const item of items) {
      await ctx.db.insert("dayLogItems", { entryId, day, quote: text, summary: "s", createdAt: at(day, 9), ...item } as never);
    }
  });
}

describe("history.page", () => {
  it("is Tom's and the read-only agent's, and refused to anyone else", async () => {
    const t = convexTest({ schema, modules });
    await expect((await as(t, "user")).query(api.history.page, RANGE)).rejects.toThrow("History access is restricted to Tom");
    await expect((await as(t, "tom")).query(api.history.page, RANGE)).resolves.toMatchObject({ from: RANGE.from });
    await expect((await as(t, "agent")).query(api.history.page, RANGE)).resolves.toMatchObject({ to: RANGE.to });
  });

  it("draws an empty record as empty series over every day of the range", async () => {
    const t = convexTest({ schema, modules });
    const page = await (await as(t, "tom")).query(api.history.page, RANGE);
    expect(page.days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(page).toMatchObject({ weights: [], meals: [], trainings: [], told: [], actions: [], cuts: [] });
  });

  it("refuses a range that is backwards, malformed or over a year", async () => {
    const t = convexTest({ schema, modules });
    const tom = await as(t, "tom");
    await expect(tom.query(api.history.page, { from: "2026-10-07", to: "2026-10-01" })).rejects.toThrow("from is on or before to");
    await expect(tom.query(api.history.page, { from: "2026-10-1", to: "2026-10-07" })).rejects.toThrow("calendar days");
    await expect(tom.query(api.history.page, { from: "2025-01-01", to: "2026-10-07" })).rejects.toThrow("at most 366 days");
  });

  it("reads his facts by kind and by the day they belong to, with the numbers the charts need", async () => {
    const t = convexTest({ schema, modules });
    // The fields are shared/jarvis-events.mjs factProblem's (tom.quest #374).
    await event(t, { kind: "weight", at: at("2026-10-02", 7), data: { day: "2026-10-02", summary: "weighed in", metric: "weight", value: 181.4, unit: "lb", partOfDay: "morning" } });
    await event(t, { kind: "weight", at: at("2026-10-03", 7), data: { day: "2026-10-03", summary: "waist", metric: "waist", value: 33, unit: "in" } });
    await event(t, { kind: "meal", at: at("2026-10-02", 12, 30), data: { day: "2026-10-02", summary: "chicken and rice", quote: "had chicken and rice, about 45 g protein", proteinG: 45, calories: 650 } });
    await event(t, { kind: "meal", at: at("2026-10-02", 19), data: { day: "2026-10-02", summary: "pasta" } });
    await event(t, { kind: "training", at: at("2026-10-03", 18), data: { day: "2026-10-03", summary: "hangboard", activity: "climb", bodyParts: ["fingers", "forearms"], durationMin: 40 } });
    await event(t, { kind: "training", at: at("2026-10-03", 18, 5), data: { day: "2026-10-03", summary: "20 mm hang", metric: "hang_20mm", value: 12, unit: "s" } });
    // Said on the 8th, outside the range, about the 5th, inside it.
    await event(t, { kind: "training", at: at("2026-10-08", 9), data: { day: "2026-10-05", summary: "ran 3 miles", activity: "run", distanceMi: 3, quote: "on monday i ran 3 miles" } });
    await event(t, { kind: "did", at: at("2026-10-03", 21), data: { day: "2026-10-03", summary: "slept badly", quote: "slept badly last night" } });
    await event(t, { kind: "thread-message", at: at("2026-10-04", 8), text: "remind me to call the dentist" });
    // Said and belonging outside the range: not read.
    await event(t, { kind: "weight", at: at("2026-10-08", 7), data: { day: "2026-10-08", summary: "weighed in", metric: "weight", value: 180, unit: "lb" } });

    const page = await (await as(t, "tom")).query(api.history.page, RANGE);
    expect(page.weights.map((w) => [w.day, w.lb])).toEqual([["2026-10-02", 181.4]]);
    expect(page.meals).toMatchObject([
      { day: "2026-10-02", text: "chicken and rice", proteinG: 45, calories: 650 },
      { day: "2026-10-02", text: "pasta" },
    ]);
    expect(page.meals[1]).not.toHaveProperty("proteinG");
    expect(page.trainings).toMatchObject([
      { day: "2026-10-03", text: "hangboard", activity: "climb", bodyParts: ["fingers", "forearms"], durationMin: 40 },
      { day: "2026-10-05", text: "ran 3 miles", activity: "run", distanceMi: 3, bodyParts: [] },
    ]);
    expect(page.told.map((row) => [row.day, row.text])).toEqual([
      ["2026-10-02", "had chicken and rice, about 45 g protein"],
      ["2026-10-03", "slept badly last night"],
      ["2026-10-04", "remind me to call the dentist"],
      ["2026-10-05", "on monday i ran 3 miles"],
    ]);
  });

  it("draws a fact's words once when the day log's entry already holds them", async () => {
    const t = convexTest({ schema, modules });
    await dayLog(t, "2026-10-01", "weighed 182 and had oatmeal", []);
    await event(t, { kind: "meal", at: at("2026-10-01", 9), data: { day: "2026-10-01", summary: "oatmeal", quote: "had oatmeal", dayLogType: "food" } });
    const page = await (await as(t, "tom")).query(api.history.page, RANGE);
    expect(page.told.map((row) => row.text)).toEqual(["weighed 182 and had oatmeal"]);
    expect(page.meals.map((row) => row.text)).toEqual(["oatmeal"]);
  });

  it("reads the day log for the days the events table has none of that kind, and his entries as his sentences", async () => {
    const t = convexTest({ schema, modules });
    await dayLog(t, "2026-10-01", "weighed 182, ran 3 miles, oatmeal", [
      { type: "measurement", metric: "weight", value: 182, unit: "lb", partOfDay: "morning" },
      { type: "measurement", metric: "waist", value: 33, unit: "in", partOfDay: "morning" },
      { type: "workout", activity: "run", distanceMi: 3, summary: "ran 3 miles" },
      { type: "food", summary: "oatmeal" },
    ]);
    await dayLog(t, "2026-10-02", "weighed 181", [{ type: "measurement", metric: "weight", value: 181, unit: "lb", partOfDay: "morning" }]);
    // The same day's weight is in events: the day log's is not drawn again.
    await event(t, { kind: "weight", at: at("2026-10-02", 9), data: { day: "2026-10-02", summary: "weight", metric: "weight", value: 181, unit: "lb", dayLogType: "measurement" } });

    const page = await (await as(t, "tom")).query(api.history.page, RANGE);
    expect(page.weights.map((w) => [w.day, w.lb])).toEqual([["2026-10-01", 182], ["2026-10-02", 181]]);
    expect(page.trainings).toMatchObject([{ day: "2026-10-01", activity: "run", distanceMi: 3, bodyParts: [] }]);
    expect(page.meals).toMatchObject([{ day: "2026-10-01", text: "oatmeal" }]);
    expect(page.told.map((row) => row.text)).toEqual(["weighed 182, ran 3 miles, oatmeal", "weighed 181"]);
  });

  it("reads what Jarvis did as one line each, linked, with machine changes folded per day and failures only where they opened", async () => {
    const t = convexTest({ schema, modules });
    await event(t, {
      kind: "merge",
      at: at("2026-10-05", 15),
      subject: "Jarvis:abc",
      data: { repo: "Jarvis", sha: "abc1234def", subject: "scripts: the laptop mirrors sessions", mainCheck: "abc1234 is the head of pull request #220, merged into main as b51f8ba" },
    });
    await event(t, { kind: "deploy", at: at("2026-10-05", 15, 5), data: { repo: "Jarvis", from: "aaa", to: "bbb", commits: ["scripts: the laptop mirrors sessions (#220)"] } });
    await event(t, { kind: "job-failed", at: at("2026-10-05", 9), provenance: { job: "poll-gmail" }, text: "Google refused the refresh token", data: { job: "poll-gmail" } });
    await event(t, { kind: "job-failed", at: at("2026-10-05", 9, 2), provenance: { job: "poll-gmail" }, text: "Google refused the refresh token", data: { job: "poll-gmail", standingSince: 1 } });
    await event(t, { kind: "work-run", at: at("2026-10-05", 10), provenance: { agentId: "codex:box:1" }, text: "work-run e2e-origin: check passed" });
    await event(t, { kind: "landed", at: at("2026-10-06", 11), data: { repo: "tom.quest", sha: "fff0000", subject: "history: the page draws his facts" } });
    for (const minute of [0, 1, 2]) {
      await event(t, { kind: "box-change", at: at("2026-10-05", 12, minute), data: { source: "state", why: "state", user: "unknown", at: at("2026-10-05", 12, minute), change: { what: "etc", before: "a", after: `b${minute}` } } });
    }
    await event(t, { kind: "job-ok", at: at("2026-10-05", 9), provenance: { job: "sweep" } });

    const page = await (await as(t, "tom")).query(api.history.page, RANGE);
    const lines = page.actions.map((a) => [a.day, a.kind, a.text, a.href]);
    expect(lines).toContainEqual(["2026-10-05", "merge", "Landed in Jarvis (#220): scripts: the laptop mirrors sessions", "https://github.com/Heffnt/Jarvis/pull/220"]);
    expect(lines).toContainEqual(["2026-10-05", "deploy", "Deployed Jarvis bbb: scripts: the laptop mirrors sessions (#220)", "https://github.com/Heffnt/Jarvis/compare/aaa...bbb"]);
    expect(lines).toContainEqual(["2026-10-05", "job-failed", "poll-gmail failed: Google refused the refresh token", null]);
    expect(lines).toContainEqual(["2026-10-05", "work-run", "work-run e2e-origin: check passed", "/agents?agent=codex%3Abox%3A1"]);
    expect(lines).toContainEqual(["2026-10-06", "landed", "Landed in tom.quest: history: the page draws his facts", "https://github.com/Heffnt/tom.quest/commit/fff0000"]);
    expect(page.actions.filter((a) => a.kind === "job-failed")).toHaveLength(1);
    const box = page.actions.filter((a) => a.kind === "box-change");
    expect(box).toHaveLength(1);
    expect(box[0]!.text).toMatch(/etc/);
    expect(page.actions.some((a) => a.kind === "job-ok")).toBe(false);
  });
});
