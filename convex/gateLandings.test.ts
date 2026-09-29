// Every commit that arrives on main of a repository under the merge gate is
// filed by the record's own refresh (convex/gateLandings.ts): a merge row when
// the gate was open for its head, a report of a landing past the gate when it
// was shut or when the commit belongs to no pull request. These run the timed
// task itself, observeMerge.refreshOpenPulls, against a GitHub played by
// `fakeGitHub` below.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { firstParentLine } from "./gateLandings";
import { AUDIT_VERDICT, LANDING_JOB, MERGE, TESTS_RUN, commitKey, landingKey, mergeKey } from "./ttsMerge";
import { gatherTodayFacts } from "./ttsDigest";
import { DAY_MS, nyCalendarDayKey } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const REPO = "Jarvis";
const SLUG = "Heffnt/Jarvis";
const sha = (c: string) => c.repeat(40);
const BASE = sha("0");

type Commit = { sha: string; parents: { sha: string }[]; commit: { message: string } };
const commit = (id: string, parents: string[], message = `commit ${id.slice(0, 7)}`): Commit => ({
  sha: id,
  parents: parents.map((one) => ({ sha: one })),
  commit: { message: `${message}\n\nits body` },
});

/**
 * GitHub for the refresh: each repository's main (its newest commit, and the
 * commits since any base), its recently closed pull requests, and the pull
 * requests of one commit. Every URL asked is kept.
 */
function fakeGitHub() {
  const asked: string[] = [];
  const state = {
    head: new Map<string, string>(),
    history: new Map<string, Commit[]>(),
    closed: new Map<string, unknown[]>(),
    pullsOf: new Map<string, unknown[]>(),
    failing: null as RegExp | null,
  };
  const fake = vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace("https://api.github.com/repos/", "");
    asked.push(path);
    if (state.failing !== null && state.failing.test(path)) return new Response("", { status: 502 });
    const [owner, name, ...rest] = path.split("/");
    const slug = `${owner}/${name}`;
    const tail = rest.join("/");
    if (tail.startsWith("pulls?state=open")) return Response.json([]);
    if (tail === "commits/main") return Response.json({ sha: state.head.get(slug) ?? BASE });
    const compared = /^compare\/([0-9a-f]+)\.\.\.main$/.exec(tail);
    if (compared !== null) {
      const history = state.history.get(slug) ?? [];
      const from = history.findIndex((one) => one.sha === compared[1]);
      const arrived = history.slice(from + 1);
      return Response.json({ status: arrived.length === 0 ? "identical" : "ahead", total_commits: arrived.length, commits: arrived });
    }
    if (tail.startsWith("pulls?state=closed")) return Response.json(state.closed.get(slug) ?? []);
    const ofCommit = /^commits\/([0-9a-f]+)\/pulls$/.exec(tail);
    if (ofCommit !== null) return Response.json(state.pullsOf.get(ofCommit[1]) ?? []);
    return new Response("", { status: 404 });
  });
  return { fake, asked, state };
}

/** A pull request GitHub shows landed on main. */
const landed = (number: number, head: string, landedAs: string) => ({
  number,
  title: `pull request ${number}`,
  merged_at: "2026-09-28T12:00:00Z",
  merge_commit_sha: landedAs,
  head: { sha: head },
  base: { ref: "main" },
});

async function seedGate(t: TestConvex<typeof schema>, head: string, verdict = "APPROVED") {
  await t.run(async (ctx) => {
    const key = commitKey(REPO, head);
    await ctx.db.insert("dtsEvents", { at: Date.now(), kind: TESTS_RUN, key, data: { repo: REPO, sha: head, ok: true } });
    await ctx.db.insert("dtsEvents", { at: Date.now(), kind: AUDIT_VERDICT, key, data: { repo: REPO, sha: head, verdict } });
  });
}

const refresh = (t: TestConvex<typeof schema>) => t.action(internal.observeMerge.refreshOpenPulls, {});

const mergeRows = (t: TestConvex<typeof schema>) =>
  t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", MERGE)).collect());

const eventsOf = (t: TestConvex<typeof schema>, kind: string) =>
  t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", kind)).collect());

/** The reports of landings past the gate, without repeats of a standing one. */
const reports = async (t: TestConvex<typeof schema>) =>
  (await eventsOf(t, "job-failed")).filter(
    (row) => row.provenance.job === LANDING_JOB && (row.data as { standingSince?: number }).standingSince === undefined,
  );

let gh: ReturnType<typeof fakeGitHub>;

/** Main of both repositories under the gate at BASE, and the first refresh
 *  run, so every test starts from a record that has accounted for BASE. */
async function started() {
  const t = convexTest({ schema, modules });
  for (const slug of ["Heffnt/tom.quest", SLUG]) {
    gh.state.head.set(slug, BASE);
    gh.state.history.set(slug, [commit(BASE, [])]);
  }
  expect(await refresh(t)).toEqual({ open: 0, failures: [] });
  return t;
}

/** Main of Jarvis moves by these commits. */
function arrive(...commits: Commit[]) {
  gh.state.history.get(SLUG)!.push(...commits);
  gh.state.head.set(SLUG, commits[commits.length - 1].sha);
}

beforeEach(() => {
  vi.stubEnv("GITHUB_MIRROR_TOKEN", "not-a-key");
  gh = fakeGitHub();
  vi.stubGlobal("fetch", gh.fake);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("firstParentLine", () => {
  it("is main's own line, oldest first, without the commits a merge commit brought in", () => {
    const line = firstParentLine([
      commit(sha("1"), [BASE]),
      commit(sha("2"), [sha("1")]),
      commit(sha("3"), [BASE, sha("2")]),
      commit(sha("4"), [sha("3")]),
    ]);
    expect(line.map((one) => one.sha)).toEqual([sha("3"), sha("4")]);
  });
});

describe("what arrived on main", () => {
  it("accounts for nothing on the first refresh, and reads each repository under the gate once when main has not moved", async () => {
    const t = await started();
    // The first refresh read main's newest commit of each, and wrote it down.
    expect(gh.asked.filter((path) => path.endsWith("/commits/main"))).toEqual([
      "Heffnt/tom.quest/commits/main",
      `${SLUG}/commits/main`,
    ]);
    gh.asked.length = 0;
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    // One comparison per repository, and nothing else about main; WikiTom is
    // outside the gate and is not read.
    expect(gh.asked.filter((path) => !path.includes("pulls?state=open"))).toEqual([
      `Heffnt/tom.quest/compare/${BASE}...main`,
      `${SLUG}/compare/${BASE}...main`,
    ]);
    expect(await mergeRows(t)).toHaveLength(0);
    expect(await reports(t)).toHaveLength(0);
  });

  it("writes the merge row of a pull request that landed with the gate open, keyed on its head, once", async () => {
    const t = await started();
    const head = sha("a");
    const squash = sha("b");
    await seedGate(t, head);
    arrive(commit(squash, [BASE]));
    gh.state.closed.set(SLUG, [landed(41, head, squash)]);
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    const [row] = await mergeRows(t);
    expect(row.key).toBe(mergeKey(REPO, head));
    expect(row.data).toMatchObject({
      repo: REPO,
      sha: head,
      subject: "pull request 41",
      mainCheck: "aaaaaaa is the head of pull request #41, merged into main as bbbbbbb",
    });
    // The squash commit was named by the closed list: not asked about alone.
    expect(gh.asked.some((path) => path.includes("/pulls") && path.includes("commits/"))).toBe(false);
    await refresh(t);
    expect(await mergeRows(t)).toHaveLength(1);
    expect(await reports(t)).toHaveLength(0);
  });

  it("reports a pull request that landed with the gate shut, names the missing checks, and writes no merge row", async () => {
    const t = await started();
    const head = sha("a");
    const landing = sha("c");
    arrive(commit(sha("d"), [BASE]), commit(landing, [BASE, sha("d")]));
    gh.state.closed.set(SLUG, [landed(42, head, landing)]);
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    expect(await mergeRows(t)).toHaveLength(0);
    const [report] = await reports(t);
    expect(report.subject).toBe(landingKey(REPO, head));
    expect((report.data as { error: string }).error).toBe(
      "Jarvis pull request #42 landed on main as ccccccc with the merge gate shut for its head aaaaaaa: missing tests, audit.",
    );
    // The branch's own commit arrived with the merge commit and is not a
    // landing of its own.
    expect(await reports(t)).toHaveLength(1);
  });

  it("reports a commit that belongs to no pull request, keyed on the commit", async () => {
    const t = await started();
    const pushed = sha("e");
    arrive(commit(pushed, [BASE], "a push straight to main"));
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    expect(gh.asked).toContain(`${SLUG}/commits/${pushed}/pulls`);
    const [report] = await reports(t);
    expect(report.subject).toBe(landingKey(REPO, pushed));
    expect((report.data as { error: string }).error).toBe(
      "Jarvis commit eeeeeee arrived on main with no pull request, and the merge gate is shut for it: missing tests, audit.",
    );
  });

  it("finds the pull request of a commit the closed list does not name, by asking about that commit", async () => {
    const t = await started();
    const head = sha("a");
    const rebased = sha("f");
    await seedGate(t, head);
    arrive(commit(rebased, [BASE]));
    gh.state.pullsOf.set(rebased, [landed(43, head, sha("9"))]);
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    expect((await mergeRows(t)).map((row) => row.key)).toEqual([mergeKey(REPO, head)]);
  });

  it("clears the report when a late row opens the gate for that commit", async () => {
    const t = await started();
    const head = sha("a");
    await t.run((ctx) =>
      ctx.db.insert("dtsEvents", { at: Date.now(), kind: TESTS_RUN, key: commitKey(REPO, head), data: { repo: REPO, sha: head, ok: true } }),
    );
    arrive(commit(sha("b"), [BASE]));
    gh.state.closed.set(SLUG, [landed(44, head, sha("b"))]);
    await refresh(t);
    expect((await reports(t)).map((row) => row.subject)).toEqual([landingKey(REPO, head)]);
    expect(await eventsOf(t, "job-recovered")).toHaveLength(0);

    await t.mutation(internal.ttsMerge.internalRecordAudit, {
      repo: REPO,
      sha: head,
      verdict: "APPROVED",
      text: "VERDICT: APPROVED\nIt does what it says.",
    });
    const recovered = await eventsOf(t, "job-recovered");
    expect(recovered.map((row) => row.subject)).toEqual([landingKey(REPO, head)]);
  });

  it("moves nothing forward when GitHub fails part way, and files the same commits once on the next refresh", async () => {
    const t = await started();
    const pushed = sha("e");
    const head = sha("a");
    await seedGate(t, head);
    arrive(commit(pushed, [BASE]), commit(sha("b"), [pushed]));
    gh.state.closed.set(SLUG, [landed(45, head, sha("b"))]);
    gh.state.failing = /commits\/e+\/pulls$/;
    const failed = await refresh(t);
    expect(failed.failures).toEqual([`gate landings: Jarvis the pull requests of eeeeeee could not be read (status 502)`]);
    expect(await reports(t)).toHaveLength(0);

    gh.state.failing = null;
    gh.asked.length = 0;
    expect(await refresh(t)).toEqual({ open: 0, failures: [] });
    // Read again from the same commit.
    expect(gh.asked).toContain(`${SLUG}/compare/${BASE}...main`);
    expect((await reports(t)).map((row) => row.subject)).toEqual([landingKey(REPO, pushed)]);
    expect((await mergeRows(t)).map((row) => row.key)).toEqual([mergeKey(REPO, head)]);
    gh.asked.length = 0;
    await refresh(t);
    expect(gh.asked).toContain(`${SLUG}/compare/${sha("b")}...main`);
  });
});

describe("the digest", () => {
  it("shows a landing past the gate once among what is broken, and says when the gate passed it", async () => {
    const t = await started();
    const head = sha("a");
    arrive(commit(sha("b"), [BASE]));
    gh.state.closed.set(SLUG, [landed(46, head, sha("b"))]);
    await refresh(t);
    // A second refresh files it again; the standing report is not a second line.
    gh.state.history.set(SLUG, [commit(BASE, []), commit(sha("b"), [BASE])]);
    await t.mutation(internal.gateLandings.internalSetMainSeen, { repo: REPO, sha: BASE });
    await refresh(t);
    const broken = async () =>
      await t.run(async (ctx) => {
        const now = Date.now() + 1;
        return (await gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - DAY_MS })).broken;
      });
    const lines = (await broken()).filter((line) => line.statement.includes("merge gate"));
    expect(lines).toHaveLength(1);
    expect(lines[0].statement).toBe("A change reached main without passing the merge gate.");
    expect(lines[0].detail).toContain("Jarvis pull request #46 landed on main as bbbbbbb");

    // The rows arrive late, through their writers: the gate opens.
    await t.mutation(internal.ttsMerge.internalRecordTests, { repo: REPO, sha: head, ok: true });
    await t.mutation(internal.ttsMerge.internalRecordAudit, {
      repo: REPO,
      sha: head,
      verdict: "APPROVED",
      text: "VERDICT: APPROVED\nIt does what it says.",
    });
    const after = (await broken()).filter((line) => line.statement.includes("merge gate"));
    expect(after).toHaveLength(1);
    expect(after[0].statement).toMatch(/^A change reached main without passing the merge gate\. The merge gate has passed it since /);
  });
});
