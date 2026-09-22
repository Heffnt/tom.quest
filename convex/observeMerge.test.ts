// The Approve control and what it sets in motion: the ruling it writes, that a
// second press writes nothing, the mirror of open pull requests, and that the
// landing merges only an approved change whose gate is green and keeps the
// approval when GitHub refuses the credential.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { EVALS_RUN } from "./ttsEvals";
import { AUDIT_VERDICT, MERGE, TESTS_RUN, commitKey } from "./ttsMerge";
import { EVALS_PROTOCOL } from "../worker/jobs/evals-row.mjs";

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

async function withTom(t: TestConvex<typeof schema>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

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
  await t.mutation(internal.ttsEvals.internalObserveBoxEvalsProtocol, { boxEvalsVersion: EVALS_PROTOCOL });
  await seedFact(t, TESTS_RUN, { ok: true });
  await seedFact(t, AUDIT_VERDICT, { verdict: "APPROVED" });
  await seedFact(t, EVALS_RUN, { regressions: 0, goldenCoverage: true, pass: 40, items: 40 });
}

const mirror = (t: TestConvex<typeof schema>, pulls = [PULL]) =>
  t.mutation(internal.observeMerge.internalReplaceOpenPulls, { repo: REPO, pulls });

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

beforeEach(() => vi.stubEnv("GITHUB_MIRROR_TOKEN", "test-token"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("approveChange", () => {
  it("records one approve ruling on the pull request, applied, and a second press writes nothing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await mirror(t);

    const first = await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(first).toEqual({ written: true, ruled: "approve" });
    const second = await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(second).toEqual({ written: false, ruled: "approve" });

    const rulings = await t.run((ctx) => ctx.db.query("dtsRulings").collect());
    expect(rulings).toHaveLength(1);
    expect(rulings[0]).toMatchObject({
      subjectType: "code",
      repo: REPO,
      externalId: "pr-212",
      verdict: "approve",
      sentence: `Approve ${PULL.title}`,
    });
    // Applied at write time, so the auto-session scheduler never reads it as
    // a worker mission.
    expect(rulings[0].appliedAt).toBeGreaterThan(0);
  });

  it("answers with the word already ruled when Tom ruled otherwise first", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await mirror(t);
    await t.mutation(internal.ttsRulings.internalRecordRuling, {
      repo: REPO,
      externalId: "pr-212",
      verdict: "revise",
      sentence: "split it in two",
    });
    const answer = await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(answer).toEqual({ written: false, ruled: "revise" });
  });

  it("is Tom's alone", async () => {
    const t = convexTest({ schema, modules });
    await mirror(t);
    await expect(t.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number })).rejects.toThrow();
  });

  it("on a merged commit records the ruling only and schedules nothing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run((ctx) =>
      ctx.db.insert("dtsEvents", {
        at: 1,
        kind: MERGE,
        key: `${REPO}:${SHA}`,
        data: { repo: REPO, sha: SHA, subject: "tts: the page has no capture bar" },
      }),
    );
    await tom.mutation(api.observe.approveChange, { repo: REPO, sha: SHA });
    const [ruling] = await t.run((ctx) => ctx.db.query("dtsRulings").collect());
    expect(ruling).toMatchObject({ externalId: `sha-${SHA}`, sentence: "Approve tts: the page has no capture bar" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("landApproved"))).toHaveLength(0);
    const [row] = await tom.query(api.observe.gateRows, { commits: [{ repo: REPO, sha: SHA }] });
    expect(row.ruled).toBe("approve");
  });
});

describe("the mirror", () => {
  it("marks a pull request GitHub stopped listing as closed, so it leaves the waiting list", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await mirror(t);
    expect(await tom.query(api.observe.changesWaiting, {})).toHaveLength(1);
    await mirror(t, []);
    expect(await tom.query(api.observe.changesWaiting, {})).toHaveLength(0);
    const rows = await t.run((ctx) => ctx.db.query("pullRequests").collect());
    expect(rows[0].closedAt).toBeGreaterThan(0);
  });

  it("does not mirror a pull request aimed at a branch other than main", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
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
    expect(await t.action(internal.observeMerge.refreshOpenPulls, {})).toEqual({ open: 0 });
    expect(await tom.query(api.observe.changesWaiting, {})).toHaveLength(0);
  });
});

describe("landing", () => {
  it("merges nothing while the gate is not green, and the approval stands", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    const answer = await t.action(internal.observeMerge.landApproved, {});
    expect(answer).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
    const [row] = await tom.query(api.observe.changesWaiting, {});
    expect(row).toMatchObject({ ruled: "approve", allowed: false, lastAttempt: null });
  });

  it("merges an approved green change with a merge commit and records the merge", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    const answer = await t.action(internal.observeMerge.landApproved, {});
    expect(answer).toEqual({ landed: 1, tried: 1 });
    expect(gh.puts[0].url).toContain("/repos/Heffnt/tom.quest/pulls/212/merge");
    expect(gh.puts[0].body).toMatchObject({ merge_method: "merge", sha: SHA });
    const merges = await t.run((ctx) =>
      ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", MERGE)).collect(),
    );
    expect(merges).toHaveLength(1);
    expect(await tom.query(api.observe.changesWaiting, {})).toHaveLength(0);
    // The landed change shows the ruling that landed it.
    const [row] = await tom.query(api.observe.gateRows, { commits: [{ repo: REPO, sha: SHA }] });
    expect(row.ruled).toBe("approve");
  });

  it("records nothing where GitHub took the merge but does not show the head on main", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
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
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    expect(puts).toHaveLength(1);
    const merges = await t.run((ctx) =>
      ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", MERGE)).collect(),
    );
    expect(merges).toHaveLength(0);
    const [row] = await tom.query(api.observe.changesWaiting, {});
    expect(row.lastAttempt).toMatchObject({ ok: false });
    expect(row.lastAttempt?.why).toContain("does not show it on main");
  });

  it("merges nothing where a revise shares the approve's millisecond", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    // Tom's revise, written in the same millisecond the approve carries: the
    // later row wins on _creationTime, which is the only thing telling them
    // apart.
    await t.run(async (ctx) => {
      const approve = await ctx.db.query("dtsRulings").first();
      await ctx.db.insert("dtsRulings", {
        subjectType: "code",
        repo: REPO,
        externalId: "pr-212",
        verdict: "revise",
        sentence: "not yet",
        ruledAt: approve!.ruledAt,
      });
    });
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 0 });
    expect(gh.puts).toHaveLength(0);
  });

  it("merges nothing that GitHub has retargeted since the mirror saw it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const gh = github(200, "", "some-other-branch");
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t);
    await green(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    expect(gh.puts).toHaveLength(0);
    const [row] = await tom.query(api.observe.changesWaiting, {});
    expect(row.lastAttempt?.why).toContain("aimed at some-other-branch");
  });

  it("merges nothing aimed at a branch other than main, however green and approved", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const gh = github(200);
    vi.stubGlobal("fetch", gh.fake);
    await mirror(t, [{ ...PULL, baseBranch: "some-other-branch" }]);
    await green(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
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
    const tom = await withTom(t);
    vi.stubGlobal("fetch", github(403, "Resource not accessible by personal access token").fake);
    await mirror(t);
    await green(t);
    await tom.mutation(api.observe.approveChange, { repo: REPO, number: PULL.number });
    expect(await t.action(internal.observeMerge.landApproved, {})).toEqual({ landed: 0, tried: 1 });
    const [row] = await tom.query(api.observe.changesWaiting, {});
    expect(row.ruled).toBe("approve");
    expect(row.lastAttempt).toMatchObject({ ok: false });
    expect(row.lastAttempt?.why).toContain("GitHub answered 403: Resource not accessible by personal access token");
  });
});
