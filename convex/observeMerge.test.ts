// The record's landing: the mirror of open pull requests, and that the landing
// merges only an approved change whose gate is green and keeps the approval
// when GitHub refuses the credential. An approval is an approve ruling on the
// pull request, written here through the ruling pen; the Approve control of
// the /agents window view that wrote it went with that view (2026-10-07).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { AUDIT_VERDICT, MERGE, TESTS_RUN, commitKey } from "./ttsMerge";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const REPO = "tom.quest";
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const PULL = {
  number: 212,
  title: "observe: the changes list approves a change in one press",
  branch: "some-branch",
  headSha: SHA,
  baseBranch: "main",
  draft: false,
  updatedAt: 1_000,
};

async function seedFact(t: TestConvex<typeof schema>, kind: string, data: Record<string, unknown>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind,
      key: commitKey(REPO, SHA),
      data: { repo: REPO, sha: SHA, ...data },
    });
  });
}

async function green(t: TestConvex<typeof schema>) {
  await seedFact(t, TESTS_RUN, { ok: true });
  await seedFact(t, AUDIT_VERDICT, { verdict: "APPROVED" });
}

const mirror = (t: TestConvex<typeof schema>, pulls = [PULL]) =>
  t.mutation(internal.observeMerge.internalReplaceOpenPulls, { repo: REPO, pulls });

/** Tom's approve ruling on the pull request. */
const approve = (t: TestConvex<typeof schema>) =>
  t.mutation(internal.ttsRulings.internalRecordRuling, {
    repo: REPO,
    externalId: `pr-${PULL.number}`,
    verdict: "approve",
    sentence: `Approve ${PULL.title}`,
  });

/** The mirror's rows of pull requests GitHub still lists as open. */
const openPulls = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => (await ctx.db.query("pullRequests").collect()).filter((row) => row.closedAt === undefined));

/** GitHub as the landing asks it: the pull request read answers the base
 *  branch, the merge PUT answers `mergeStatus`, and the mergedOnMain reads
 *  show the sha on main. */
function github(mergeStatus: number, message = "", base = "main") {
  const puts: { url: string; body: unknown }[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT") {
      puts.push({ url: path, body: JSON.parse(String(init.body)) });
      return Response.json({ message }, { status: mergeStatus });
    }
    if (/\/pulls\/\d+$/.test(path)) return Response.json({ base: { ref: base } });
    if (path.includes("/compare/")) return Response.json({ status: "ahead" });
    if (/\/repos\/Heffnt\/[^/]+$/.test(path)) return Response.json({ default_branch: "main" });
    return new Response("", { status: 404 });
  });
  return { fake, puts };
}

beforeEach(() => vi.stubEnv("GITHUB_MIRROR_TOKEN", "not-a-key"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the mirror", () => {
  it("reports the missing GitHub credential as a failure by name", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "");
    expect(await t.action(internal.observeMerge.refreshOpenPulls, {})).toEqual({
      open: 0,
      failures: ["observe: GITHUB_MIRROR_TOKEN is not set"],
    });
  });

  it("marks a pull request GitHub stopped listing as closed, so it leaves the waiting list", async () => {
    const t = convexTest({ schema, modules });
    await mirror(t);
    expect(await openPulls(t)).toHaveLength(1);
    await mirror(t, []);
    expect(await openPulls(t)).toHaveLength(0);
    const rows = await t.run((ctx) => ctx.db.query("pullRequests").collect());
    expect(rows[0].closedAt).toBeGreaterThan(0);
  });

  it("does not mirror a pull request aimed at a branch other than main", async () => {
    const t = convexTest({ schema, modules });
    vi.stubGlobal(
      "fetch",
      // The refresh also reads main of each repository under the gate
      // (convex/gateLandings.ts); on its first refresh that is main's newest
      // commit, and nothing is accounted for.
      vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/commits/main") ? Response.json({ sha: "c".repeat(40) }) : Response.json([
          {
            number: 300,
            title: "a change aimed elsewhere",
            draft: false,
            updated_at: new Date().toISOString(),
            head: { ref: "side", sha: SHA },
            base: { ref: "some-other-branch" },
          },
        ]),
      ),
    );
    expect(await t.action(internal.observeMerge.refreshOpenPulls, {})).toEqual({ open: 0, failures: [] });
    expect(await openPulls(t)).toHaveLength(0);
  });
});

describe("landing", () => {
  it("merges nothing while the gate is not green, and the approval stands", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await approve(t);
    const answer = await t.action(internal.observeMerge.landApproved, {});
    expect(answer).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
    const [row] = await openPulls(t);
    expect(row.lastAttempt).toBeUndefined();
  });

  it("merges an approved green change with a merge commit and records the merge", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await approve(t);
    const answer = await t.action(internal.observeMerge.landApproved, {});
    expect(answer).toEqual({ landed: 1, tried: 1 });
    expect(gh.puts[0].url).toContain("/repos/Heffnt/tom.quest/pulls/212/merge");
    expect(gh.puts[0].body).toMatchObject({ merge_method: "merge", sha: SHA });
    const merges = await t.run((ctx) =>
      ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", MERGE)).collect(),
    );
    expect(merges).toHaveLength(1);
    expect(await openPulls(t)).toHaveLength(0);
  });

  it("records nothing where GitHub took the merge but does not show the head on main", async () => {
    const t = convexTest({ schema, modules });
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "PUT") {
          puts.push(path);
          return Response.json({}, { status: 200 });
        }
        if (/\/pulls\/\d+$/.test(path)) return Response.json({ base: { ref: "main" } });
        if (path.includes("/compare/")) return Response.json({ status: "diverged" });
        if (/\/repos\/Heffnt\/[^/]+$/.test(path)) return Response.json({ default_branch: "main" });
        return Response.json([]);
      }),
    );
    await mirror(t);
    await green(t);
    await approve(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    expect(puts).toHaveLength(1);
    const merges = await t.run((ctx) =>
      ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", MERGE)).collect(),
    );
    expect(merges).toHaveLength(0);
    const [row] = await openPulls(t);
    expect(row.lastAttempt).toMatchObject({ ok: false });
    expect(row.lastAttempt?.why).toContain("does not show it on main");
  });

  it("merges nothing where Tom revises it while the landing is talking to GitHub", async () => {
    const t = convexTest({ schema, modules });
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "PUT") {
          puts.push(path);
          return Response.json({}, { status: 200 });
        }
        if (/\/pulls\/\d+$/.test(path)) {
          // His revise, written in the gap between the ready list and the
          // merge — which is the whole of what this holds.
          await t.mutation(internal.ttsRulings.internalRecordRuling, {
            repo: REPO,
            externalId: "pr-212",
            verdict: "revise",
            sentence: "stop",
          });
          return Response.json({ base: { ref: "main" } });
        }
        if (path.includes("/compare/")) return Response.json({ status: "ahead" });
        if (/\/repos\/Heffnt\/[^/]+$/.test(path)) return Response.json({ default_branch: "main" });
        return Response.json([]);
      }),
    );
    await mirror(t);
    await green(t);
    await approve(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    expect(puts).toHaveLength(0);
    const [row] = await openPulls(t);
    expect(row.lastAttempt?.why).toContain("no longer approved");
  });

  it("merges nothing where a revise shares the approve's millisecond", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await approve(t);
    // Tom's revise, written in the same millisecond the approve carries: the
    // later row wins on _creationTime, which is the only thing telling them
    // apart.
    await t.run(async (ctx) => {
      const approval = await ctx.db.query("rulings").first();
      await ctx.db.insert("rulings", {
        subjectType: "code",
        repo: REPO,
        externalId: "pr-212",
        verdict: "revise",
        sentence: "not yet",
        ruledAt: approval!.ruledAt,
      });
    });
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
  });

  it("merges nothing that GitHub has retargeted since the mirror saw it", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200, "", "some-other-branch");
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await approve(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    expect(gh.puts).toHaveLength(0);
    const [row] = await openPulls(t);
    expect(row.lastAttempt?.why).toContain("aimed at some-other-branch");
  });

  it("merges nothing aimed at a branch other than main, however green and approved", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t, [{ ...PULL, baseBranch: "some-other-branch" }]);
    await green(t);
    await approve(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
  });

  it("merges nothing that is green and not approved", async () => {
    const t = convexTest({ schema, modules });
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
  });

  it("keeps the approval and GitHub's sentence when the credential may not write", async () => {
    const t = convexTest({ schema, modules });
    vi.stubGlobal("fetch", github(403, "Resource not accessible by personal access token").fake);
    await mirror(t);
    await green(t);
    await approve(t);
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    const [row] = await openPulls(t);
    expect(await t.run((ctx) => ctx.db.query("rulings").collect())).toMatchObject([{ verdict: "approve" }]);
    expect(row.lastAttempt).toMatchObject({ ok: false });
    expect(row.lastAttempt?.why).toContain("GitHub answered 403: Resource not accessible by personal access token");
  });
});
