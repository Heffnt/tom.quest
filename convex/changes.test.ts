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
// Each push is stamped later than the one before, as the box's hook stamps them.
let clock = 1_000;
const open = (head: string, extra: Record<string, unknown> = {}) => ({
  repo: "Jarvis", branch: "feature", head, state: "checking", author: "Jarvis <jarvis@box>",
  title: "docs: a comment line", description: "Why it changes.", complex: false, pushedAt: (clock += 1_000), ...extra,
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

  it("changes nothing for a head any row of the branch landed, not only the newest", async () => {
    const t = setup();
    await post(t, open(A));
    await post(t, { repo: "Jarvis", branch: "feature", head: A, state: "landed" });
    await post(t, open(B));
    await post(t, { repo: "Jarvis", branch: "feature", head: B, state: "landed" });
    const again = await post(t, open(A));
    expect(again.body).toMatchObject({ applied: false, why: `${A.slice(0, 7)} already landed` });
    expect((await rows(t)).map((r: { head: string; state: string }) => [r.head, r.state])).toEqual([[B, "landed"], [A, "landed"]]);
  });

  it("keeps the newer head when two pushes' posts arrive out of order", async () => {
    const t = setup();
    const older = open(A);
    const newer = open(B);
    await post(t, newer);
    const late = await post(t, older);
    expect(late.body).toMatchObject({ applied: false, why: `${A.slice(0, 7)} was pushed before the row's ${B.slice(0, 7)}` });
    expect((await rows(t))[0]).toMatchObject({ head: B, state: "checking", pushedAt: newer.pushedAt });
    // The gate job's re-post of the same head with its queue's stamp keeps the row.
    expect((await post(t, { ...newer, pushedAt: newer.pushedAt - 1 })).body.applied).toBe(true);
    expect((await rows(t))[0]).toMatchObject({ head: B, pushedAt: newer.pushedAt });
    // An outcome for the older head does not apply.
    expect((await post(t, { repo: "Jarvis", branch: "feature", head: A, state: "landed" })).body.applied).toBe(false);
  });

  it("keeps a blocked row's outcome against a duplicate post, and reopens it for a later push of the same head", async () => {
    const t = setup();
    const first = open(A);
    await post(t, first);
    await post(t, { repo: "Jarvis", branch: "feature", head: A, state: "blocked", reason: "tests failed: one test" });
    const duplicate = await post(t, { ...first });
    expect(duplicate.body).toMatchObject({ applied: false, why: `${A.slice(0, 7)} was already checked: blocked` });
    expect((await rows(t))[0]).toMatchObject({ head: A, state: "blocked", reason: "tests failed: one test" });
    // A later push of the same head (a later stamp) runs its checks again.
    expect((await post(t, open(A))).body.applied).toBe(true);
    expect((await rows(t))[0]).toMatchObject({ head: A, state: "checking" });
    expect((await rows(t))[0].reason).toBeUndefined();
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

  it("reads one repository's rows past newer rows of others, and refuses a branch without a repository", async () => {
    const t = setup();
    await post(t, open(A));
    for (let i = 0; i < 105; i++) {
      await post(t, { ...open(A), repo: "tom.quest", branch: `other-${i}` });
    }
    const jarvis = await rows(t, "repo=Jarvis&limit=5");
    expect(jarvis.map((r: { repo: string; branch: string }) => [r.repo, r.branch])).toEqual([["Jarvis", "feature"]]);
    const branchOnly = await t.fetch("/jarvis/changes?branch=feature", { headers: HEADERS });
    expect(branchOnly.status).toBe(400);
  });

  it("refuses a malformed body and a caller without the key", async () => {
    const t = setup();
    expect((await post(t, open("abc"))).status).toBe(400);
    expect((await post(t, open(A, { state: "merged" }))).status).toBe(400);
    expect((await post(t, open(A, { branch: "main" }))).status).toBe(400);
    expect((await post(t, open(A, { title: "" }))).status).toBe(400);
    expect((await post(t, open(A, { pushedAt: undefined }))).status).toBe(400);
    expect((await post(t, open(A, { pushedAt: "soon" }))).status).toBe(400);
    const anon = await t.fetch("/jarvis/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(open(A)) });
    expect(anon.status).toBe(401);
  });
});
