import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

// The changes table (convex/jarvis/changes.ts): the box's receiving hook opens
// a branch's change (checking), the box's gate job writes its outcome.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": "k" };
const A = "a".repeat(40);
const B = "b".repeat(40);
const MAIN = "c".repeat(40);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/changes");
}, 60_000);

afterEach(() => vi.unstubAllEnvs());

function setup() {
  vi.stubEnv("JARVIS_KEY", "k");
  return convexTest({ schema, modules });
}
const post = async (t: ReturnType<typeof convexTest>, body: unknown) => {
  const response = await t.fetch("/jarvis/change", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const rows = async (t: ReturnType<typeof convexTest>, query = "repo=Jarvis&branch=feature") =>
  (await (await t.fetch(`/jarvis/changes?${query}`, { headers: HEADERS })).json()).changes;
const open = (head: string, extra: Record<string, unknown> = {}) => ({
  repo: "Jarvis", branch: "feature", head, state: "checking", author: "Jarvis <jarvis@box>",
  title: "docs: a comment line", description: "Why it changes.", complex: false, ...extra,
});

describe("POST /jarvis/change", () => {
  it("opens a change, writes its outcome, and keeps a landed row as history", async () => {
    const t = setup();
    expect((await post(t, open(A))).body.applied).toBe(true);
    let [row] = await rows(t);
    expect(row).toMatchObject({ repo: "Jarvis", branch: "feature", head: A, state: "checking", complex: false, title: "docs: a comment line" });

    expect((await post(t, { repo: "Jarvis", branch: "feature", head: A, state: "blocked", base: MAIN, reason: "tests failed: one test" })).body.applied).toBe(true);
    [row] = await rows(t);
    expect(row).toMatchObject({ state: "blocked", reason: "tests failed: one test", base: MAIN });

    // The next push of the branch re-opens the same row at the new head.
    await post(t, open(B, { complex: true }));
    const after = await rows(t);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ head: B, state: "checking", complex: true });
    expect(after[0].reason).toBeUndefined();
    expect(after[0].base).toBeUndefined();

    expect((await post(t, { repo: "Jarvis", branch: "feature", head: B, state: "landed", base: MAIN, auditRequired: true, auditWhy: "marked complex" })).body.applied).toBe(true);
    [row] = await rows(t);
    expect(row).toMatchObject({ state: "landed", auditRequired: true });
    expect(typeof row.landedAt).toBe("number");

    // Checking again for the landed head changes nothing; a new head opens a new row.
    expect((await post(t, open(B))).body.applied).toBe(false);
    await post(t, open(A));
    const both = await rows(t);
    expect(both.map((r: { head: string; state: string }) => [r.head, r.state])).toEqual([[A, "checking"], [B, "landed"]]);
  });

  it("refuses an outcome for a head the row no longer holds", async () => {
    const t = setup();
    await post(t, open(A));
    await post(t, open(B));
    const late = await post(t, { repo: "Jarvis", branch: "feature", head: A, state: "landed" });
    expect(late.body).toMatchObject({ ok: true, applied: false });
    const [row] = await rows(t);
    expect(row).toMatchObject({ head: B, state: "checking" });
  });

  it("refuses a malformed body and a caller without the key", async () => {
    const t = setup();
    expect((await post(t, open("abc"))).status).toBe(400);
    expect((await post(t, open(A, { state: "merged" }))).status).toBe(400);
    expect((await post(t, open(A, { branch: "main" }))).status).toBe(400);
    expect((await post(t, open(A, { title: "" }))).status).toBe(400);
    const anon = await t.fetch("/jarvis/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(open(A)) });
    expect(anon.status).toBe(401);
  });
});
