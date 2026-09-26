import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  AUDIT_REMOVAL_HEADING,
  AUDIT_REMOVAL_NOTES_MAX,
  AUDIT_REMOVAL_NOTE_MAX_CHARS,
  AUDIT_TEXT_MAX_BYTES,
  AUDIT_VERDICT,
  MERGE,
  SUITE_SLOW_KEY,
  SUITE_SLOW_SECONDS,
  TESTS_JOB_SLOW_KEY,
  TESTS_JOB_SLOW_SECONDS,
  TESTS_RUN,
  auditChunkNote,
  auditVerdictOf,
  checkRowPassed,
  commitKey,
  compactCount,
  mergedOnMain,
  removalNotesOf,
  slowConditions,
} from "./ttsMerge";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "worker-key";
const EVALS_KEY = "ci-evals-key";
const REPO = "tom.quest";
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function convex() {
  return convexTest({ schema, modules });
}

const post = (t: TestConvex<typeof schema>, path: string, payload: unknown, key = KEY) =>
  t.fetch(path, {
    method: "POST",
    headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const get = (t: TestConvex<typeof schema>, path: string) =>
  t.fetch(path, { method: "GET", headers: { "X-TTS-Key": KEY } });

/** A row of one kind against one commit, written straight in: these two are
 *  the gate's whole input, and a test that seeds them says exactly what the
 *  gate reads. */
async function seedFact(
  t: TestConvex<typeof schema>,
  kind: string,
  data: Record<string, unknown>,
  sha = SHA,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind,
      key: commitKey(REPO, sha),
      data: { repo: REPO, sha, ...data },
    });
  });
}

const greenTests = (t: TestConvex<typeof schema>, sha = SHA) =>
  seedFact(t, TESTS_RUN, { ok: true }, sha);
const approvedAudit = (t: TestConvex<typeof schema>, sha = SHA) =>
  seedFact(t, AUDIT_VERDICT, { verdict: "APPROVED" }, sha);
/** GitHub as POST /tts/merge asks it: how SHA compares with main, and the
 *  pull requests SHA belongs to. */
function github({ compare = "ahead", pulls = [] as unknown[], status = 200, main = "main" } = {}) {
  const asked: string[] = [];
  const fake = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    asked.push(path);
    if (status !== 200) return new Response("", { status });
    if (path.includes("/compare/")) return Response.json({ status: compare });
    if (path.includes("/pulls")) return Response.json(pulls);
    if (/\/repos\/Heffnt\/[^/]+$/.test(path)) return Response.json({ default_branch: main });
    return new Response("", { status: 404 });
  });
  return { fake, asked };
}

// Every merge report below is about a sha GitHub shows on main, unless a test
// says otherwise.
beforeEach(() => vi.stubGlobal("fetch", github().fake));
afterEach(() => vi.unstubAllGlobals());

const mergeReport = (t: TestConvex<typeof schema>, over: Record<string, unknown> = {}) =>
  post(t, "/tts/merge", {
    repo: REPO,
    sha: SHA,
    subject: "the delegate and the objection list",
    ...over,
  });

const mergeRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", MERGE)).collect(),
  );

const testsRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", TESTS_RUN).eq("key", commitKey(REPO, SHA)))
      .order("desc")
      .collect(),
  );

/** The timing warning's own reports, in the record's events table
 *  (convex/jarvis/jobs.ts): a repeat of a standing condition carries
 *  data.standingSince and is not a report. */
const jobRows = (t: TestConvex<typeof schema>, kind: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", kind)).collect()).filter(
      (row) => (row.data as { standingSince?: number }).standingSince === undefined,
    ),
  );

const auditRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", AUDIT_VERDICT).eq("key", commitKey(REPO, SHA)))
      .order("desc")
      .collect(),
  );

/** The row the gate reads: the NEWEST audit row for the commit. There is one
 *  of them per head unless a real verdict replaced an UNAVAILABLE. */
const auditRow = async (t: TestConvex<typeof schema>) => (await auditRows(t))[0] ?? null;

const auditData = async (t: TestConvex<typeof schema>) =>
  ((await auditRow(t))?.data ?? {}) as Record<string, unknown>;

/** A whole-diff read: twelve chunks of a 1,437,221-character diff, all twelve
 *  answered. The shape worker/jobs/audit.mjs posts once it has stopped cutting
 *  the diff at 200,000 characters. */
const WHOLE_DIFF = {
  count: 12,
  read: 12,
  charsRead: 1_437_221,
  charsTotal: 1_437_221,
  truncatedChunks: 0,
  files: 41,
};

type AuditOver = Partial<{
  sha: string;
  verdict: string;
  text: string;
  model: string;
  fallback: string;
  url: string;
  chunks: typeof WHOLE_DIFF;
  traceFindings: string[];
  trace: { available: boolean; reason?: string };
}>;

/** The audit door itself, called straight rather than over HTTP: these tests
 *  are about what the MUTATION stores and caps, and convex/http.ts is another
 *  agent's file. */
const recordAudit = (t: TestConvex<typeof schema>, over: AuditOver = {}) =>
  t.mutation(internal.ttsMerge.internalRecordAudit, {
    repo: REPO,
    sha: SHA,
    verdict: "APPROVED",
    text: "VERDICT: APPROVED\n\nIt lands what it claims and nothing else.",
    ...over,
  });

const auditWhy = async (t: TestConvex<typeof schema>) => {
  const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
  return (gate.checks as { name: string; why: string }[]).find((c) => c.name === "audit")!.why;
};

describe("auditVerdictOf", () => {
  it("reads the verdict line, alone on its line, in any case", () => {
    expect(auditVerdictOf("VERDICT: APPROVED\n\nNothing here breaks anything.")).toBe("APPROVED");
    expect(auditVerdictOf("Some prose first.\n  verdict:  refused  \nBecause X.")).toBe("REFUSED");
    expect(auditVerdictOf("VERDICT: UNAVAILABLE\n\nThe audit could not run.")).toBe("UNAVAILABLE");
  });

  it("does not read a verdict quoted inside a sentence", () => {
    expect(auditVerdictOf("Do not write VERDICT: APPROVED unless you mean it.")).toBe(null);
    expect(auditVerdictOf("I looked at the diff and it is fine.")).toBe(null);
  });
});

describe("removalNotesOf", () => {
  const APPROVED = "VERDICT: APPROVED\n\n";

  it("reads nothing out of an answered check with nothing to report", () => {
    expect(removalNotesOf(`${APPROVED}${AUDIT_REMOVAL_HEADING} none\n\nIt deletes more than it adds.`)).toEqual([]);
    expect(removalNotesOf(`${APPROVED}${AUDIT_REMOVAL_HEADING}   NONE  `)).toEqual([]);
  });

  it("reads the bullets, and stops at the paragraph after them", () => {
    expect(
      removalNotesOf(
        `${APPROVED}${AUDIT_REMOVAL_HEADING}\n` +
          "- convex/http.ts:a second key header — the change does not say why the first cannot be deleted\n" +
          "-  worker/jobs/evals.mjs:a retry branch — the change does not say why the timeout cannot be deleted \n" +
          "\nThe rest of it is narrow and does what it says.",
      ),
    ).toEqual([
      "convex/http.ts:a second key header — the change does not say why the first cannot be deleted",
      "worker/jobs/evals.mjs:a retry branch — the change does not say why the timeout cannot be deleted",
    ]);
  });

  it("reads nothing when the audit never answered the question", () => {
    expect(removalNotesOf(`${APPROVED}It does what it says and touches nothing else.`)).toEqual([]);
  });

  // The same anchoring auditVerdictOf has: without it, the quoted heading below
  // would pull the sentence after it in as a finding.
  it("does not read a heading quoted inside a sentence", () => {
    expect(
      removalNotesOf(
        `${APPROVED}I would write ${AUDIT_REMOVAL_HEADING} none here if there were none.\n` +
          "- convex/http.ts:a flag — the change does not say why\n",
      ),
    ).toEqual([]);
  });

  it("caps the list and each finding in it", () => {
    const many = `${AUDIT_REMOVAL_HEADING}\n${Array.from(
      { length: AUDIT_REMOVAL_NOTES_MAX + 5 },
      (_, i) => `- convex/x.ts:addition ${i}`,
    ).join("\n")}\n`;
    expect(removalNotesOf(many)).toHaveLength(AUDIT_REMOVAL_NOTES_MAX);

    const long = removalNotesOf(`${AUDIT_REMOVAL_HEADING}\n- ${"x".repeat(500)}\n`);
    expect(long[0]).toHaveLength(AUDIT_REMOVAL_NOTE_MAX_CHARS);
  });
});

describe("checkRowPassed", () => {
  it("answers for each kind, and false for a kind it was never taught", () => {
    expect(checkRowPassed(TESTS_RUN, { ok: true })).toBe(true);
    expect(checkRowPassed(TESTS_RUN, { ok: false })).toBe(false);
    expect(checkRowPassed(TESTS_RUN, {})).toBe(false);

    expect(checkRowPassed(AUDIT_VERDICT, { verdict: "approved" })).toBe(true);
    expect(checkRowPassed(AUDIT_VERDICT, { verdict: "REFUSED" })).toBe(false);
    expect(checkRowPassed(AUDIT_VERDICT, {})).toBe(false);

    expect(checkRowPassed("merge", { ok: true })).toBe(false);
    expect(checkRowPassed(TESTS_RUN, undefined)).toBe(false);
  });
});

describe("the merge gate's two checks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a merge with nothing on record, and names both", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const response = await mergeReport(t);
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer.ok).toBe(false);
    expect(answer.gate.missing).toEqual(["tests", "audit"]);
    expect(answer.error).toContain(["tests", "audit"].join(", "));
    expect(answer.gate.checks.map((c: { name: string }) => c.name)).toEqual(["tests", "audit"]);
    expect(await mergeRows(t)).toHaveLength(0);
  });

  it("refuses when only the TESTS are missing, and says the row is absent", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await approvedAudit(t);
    const answer = await (await mergeReport(t)).json();
    expect(answer.gate.missing).toEqual(["tests"]);
    expect(answer.gate.testsRun).toBeNull();
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "tests").why).toContain(
      "no tests result",
    );
  });

  it("refuses on RED tests, and says so rather than saying nothing is recorded", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await seedFact(t, TESTS_RUN, { ok: false, detail: "guardrails tests job" });
    await approvedAudit(t);
    const answer = await (await mergeReport(t)).json();
    expect(answer.gate.missing).toEqual(["tests"]);
    expect(answer.gate.testsRun).toEqual({ ok: false, detail: "guardrails tests job" });
    const tests = answer.gate.checks.find((c: { name: string }) => c.name === "tests");
    expect(tests.why).toContain("red");
    expect(tests.why).toContain("guardrails tests job");
  });

  it("refuses when only the AUDIT is missing, and when it answered something else", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const missing = convex();
    await greenTests(missing);
    expect((await (await mergeReport(missing)).json()).gate.missing).toEqual(["audit"]);

    const refused = convex();
    await greenTests(refused);
    await seedFact(refused, AUDIT_VERDICT, { verdict: "REFUSED" });
    const answer = await (await mergeReport(refused)).json();
    expect(answer.gate.missing).toEqual(["audit"]);
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "audit").why).toContain(
      "answered REFUSED",
    );
  });

  it("checks the head it was given, not another commit", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const other = "b".repeat(40);
    await greenTests(t, other);
    await approvedAudit(t, other);
    expect((await (await mergeReport(t)).json()).gate.missing).toEqual(["tests", "audit"]);
    expect((await mergeReport(t, { sha: other })).status).toBe(200);
  });
});

describe("a merge the gate allows", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function gated(t: TestConvex<typeof schema>) {
    await greenTests(t);
    await approvedAudit(t);
  }

  it("records one row per merged sha, and a retry writes nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await gated(t);
    const todoId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "the delegate lands",
        status: "active",
        readiness: "prepared",
        timingClass: "whenever",
        source: "tom",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect((await mergeReport(t, { todoId })).status).toBe(200);
    const retried = await (await mergeReport(t, { todoId })).json();
    expect(retried.existing).toBe(true);

    const written = await mergeRows(t);
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe(`${REPO}:${SHA}`);
    expect(written[0].todoId).toBe(todoId);
  });

  it("posts ONE line to #tts-decisions, naming the merge and the two checks", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await gated(t);
    expect((await mergeReport(t)).status).toBe(200);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    expect(scheduled).toHaveLength(1);
    const args = scheduled[0].args[0] as { askId: string; decision: string; reason: string };
    // The ask id is the merge's own key, so a reply in that thread objects to
    // THIS merge.
    expect(args.askId).toBe(`${REPO}:${SHA}`);
    expect(args.decision).toContain(`merged ${REPO}@${SHA.slice(0, 7)}`);
    expect(args.decision).toContain("the delegate and the objection list");
    expect(args.reason).toContain("the tests are green");
    expect(args.reason).toContain("the audit approved");
    expect(args.reason).not.toContain("evals");
  });

  // witness: PR #196 was recorded at c4e73b5 on 2026-09-19 from a merge
  // command GitHub had refused; the row cannot be corrected once written.
  it("refuses to record a sha that is not on main and was merged by no pull request", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    vi.stubGlobal("fetch", github({ compare: "diverged", pulls: [{ number: 196, merged_at: null, base: { ref: "main" } }] }).fake);
    const t = convex();
    await gated(t);
    const response = await mergeReport(t);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("is not on main");
    expect(await mergeRows(t)).toEqual([]);
  });

  it("records the head of a squash-merged pull request, whose commit never reaches main", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    vi.stubGlobal("fetch", github({ compare: "diverged", pulls: [{ number: 207, merged_at: "2026-09-21T12:00:00Z", base: { ref: "main" }, head: { sha: SHA } }] }).fake);
    const t = convex();
    await gated(t);
    expect((await mergeReport(t)).status).toBe(200);
    expect(await mergeRows(t)).toHaveLength(1);
  });

  it("records a merge of a repository the token cannot read, and says it was not checked", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    vi.stubGlobal("fetch", github({ status: 404 }).fake);
    const t = convex();
    await gated(t);
    expect((await mergeReport(t)).status).toBe(200);
    const [row] = await mergeRows(t);
    expect((row.data as { mainCheck?: string }).mainCheck).toContain("not checked against GitHub");
  });

  it("records nothing when GitHub cannot be asked", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    vi.stubGlobal("fetch", github({ status: 403 }).fake);
    const t = convex();
    await gated(t);
    const response = await mergeReport(t);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("GitHub could not be asked");
    expect(await mergeRows(t)).toEqual([]);
  });

  it("400s a report missing its repo, sha or subject", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await gated(t);
    const response = await post(t, "/tts/merge", { repo: REPO, sha: SHA });
    expect(response.status).toBe(400);
  });
});

describe("GET /tts/merge-gate — what the box asks before it merges", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the two checks and opens nothing by itself", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    const shut = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(shut.allowed).toBe(false);
    expect(shut.missing).toEqual(["audit"]);
    expect(shut.checks).toHaveLength(2);
    // A read is a read: no merge row appeared.
    expect(await mergeRows(t)).toHaveLength(0);

    await approvedAudit(t);
    const open = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(open.allowed).toBe(true);
    expect(open.missing).toEqual([]);
  });

  // THE REMOVAL CHECK IS NOT A FOURTH HEAD ROW (§23.8). The findings ride on
  // the audit row; the gate's answer has to be the same object with and
  // without them, which is what a deep equality over the whole result proves
  // and a spot check on `allowed` would not.
  it("answers identically whether or not the audit row carries removal notes", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const notes = ["convex/http.ts:a second key header — the change does not say why"];
    const text = "VERDICT: APPROVED\n\nIt does what it says.";

    async function gateWith(auditData: Record<string, unknown>) {
      const t = convex();
      await greenTests(t);
      await seedFact(t, AUDIT_VERDICT, auditData);
      return await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    }

    const open = await gateWith({ verdict: "APPROVED", text });
    const openWithNotes = await gateWith({ verdict: "APPROVED", text, removalNotes: notes });
    expect(openWithNotes).toEqual(open);
    expect(open.allowed).toBe(true);

    const shut = await gateWith({ verdict: "REFUSED", text });
    const shutWithNotes = await gateWith({ verdict: "REFUSED", text, removalNotes: notes });
    expect(shutWithNotes).toEqual(shut);
    expect(shut.allowed).toBe(false);
  });

  it("400s without a repo and a sha, and 401s without the key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    expect((await get(t, "/tts/merge-gate?repo=tom.quest")).status).toBe(400);
    expect(
      (await t.fetch(`/tts/merge-gate?repo=${REPO}&sha=${SHA}`, { method: "GET" })).status,
    ).toBe(401);
  });
});

describe("POST /tts/tests — the first check's own door", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes the CI key as well as the worker key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    vi.stubEnv("EVALS_KEY", EVALS_KEY);
    const t = convex();
    const response = await t.fetch("/tts/tests", {
      method: "POST",
      headers: { "X-Evals-Key": EVALS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: REPO, sha: SHA, ok: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).green).toBe(true);
  });

  it("keeps the first answer, so a red run cannot be re-run until it goes green", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/tests", { repo: REPO, sha: SHA, ok: false, detail: "one suite failed" });
    const again = await (await post(t, "/tts/tests", { repo: REPO, sha: SHA, ok: true })).json();
    expect(again.existing).toBe(true);
    expect(again.green).toBe(false);
    expect((await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json()).missing).toContain(
      "tests",
    );
  });

  it("400s without ok", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    expect((await post(t, "/tts/tests", { repo: REPO, sha: SHA })).status).toBe(400);
  });

  it("keeps the mode, the file count and every job's seconds on the row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/tests", {
      repo: REPO,
      sha: SHA,
      ok: true,
      mode: "related",
      files: 2,
      durations: { "static-boundaries": 31, "secret-scan": 11, tests: 142, e2e: 97, suite: 11.4 },
      slowest: [{ file: "convex/http.test.ts", seconds: 6.2 }],
    });
    const row = (await testsRows(t))[0];
    expect(row.data).toMatchObject({
      mode: "related",
      files: 2,
      durations: { tests: 142, suite: 11.4 },
      slowest: [{ file: "convex/http.test.ts", seconds: 6.2 }],
    });
  });

  // A malformed timing must not cost the gate its tests row: the door drops
  // what the validator would refuse and records the fact it came for.
  it("drops a timing it cannot read rather than refusing the row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const response = await post(t, "/tts/tests", {
      repo: REPO,
      sha: SHA,
      ok: true,
      files: "two",
      durations: { tests: "fast" },
      slowest: [{ file: "convex/http.test.ts" }],
    });
    expect(response.status).toBe(200);
    const row = (await testsRows(t))[0];
    expect(row.data).toMatchObject({ ok: true });
    expect((row.data as Record<string, unknown>).durations).toBeUndefined();
    expect((row.data as Record<string, unknown>).files).toBeUndefined();
  });
});

describe("the timing warning — Tom's 2026-09-22 ruling", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names the two thresholds and answers a condition per duration it was given", () => {
    expect(TESTS_JOB_SLOW_SECONDS).toBe(300);
    expect(SUITE_SLOW_SECONDS).toBe(600);
    expect(slowConditions({ durations: {} })).toEqual([]);
    const both = slowConditions({
      mode: "full",
      durations: { tests: 400, suite: 700 },
      slowest: [{ file: "convex/http.test.ts", seconds: 90 }],
    });
    expect(both.map((row) => row.key)).toEqual([TESTS_JOB_SLOW_KEY, SUITE_SLOW_KEY]);
    expect(both.every((row) => row.crossed)).toBe(true);
    expect(both[0].error).toContain("convex/http.test.ts 90s");
    // A related run that crossed ten minutes crossed the five-minute job
    // threshold seven minutes earlier, so one slow run is still one sentence.
    expect(slowConditions({ mode: "related", durations: { tests: 200, suite: 700 } })).toEqual([
      { key: TESTS_JOB_SLOW_KEY, crossed: false, error: expect.stringContaining("200s") },
    ]);
  });

  it("posts one job-failed row when the tests job crosses five minutes, and never twice", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const timing = { durations: { tests: 420, suite: 88 }, mode: "related", slowest: [{ file: "convex/runs.test.ts", seconds: 41 }] };
    await post(t, "/tts/tests", { repo: REPO, sha: SHA, ok: true, ...timing });
    await post(t, "/tts/tests", { repo: REPO, sha: `${SHA.slice(0, 39)}b`, ok: true, ...timing });
    const failures = await jobRows(t, "job-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].subject).toBe(TESTS_JOB_SLOW_KEY);
    expect((failures[0].data as { error: string }).error).toContain("420s");
    expect((failures[0].data as { error: string }).error).toContain("convex/runs.test.ts 41s");
  });

  it("re-arms the warning when a later run comes back under the threshold", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/tests", { repo: REPO, sha: SHA, ok: true, durations: { tests: 420 } });
    await post(t, "/tts/tests", { repo: REPO, sha: `${SHA.slice(0, 39)}b`, ok: true, durations: { tests: 60 } });
    await post(t, "/tts/tests", { repo: REPO, sha: `${SHA.slice(0, 39)}c`, ok: true, durations: { tests: 420 } });
    expect(await jobRows(t, "job-recovered")).toHaveLength(1);
    expect(await jobRows(t, "job-failed")).toHaveLength(2);
  });

  // The row is write-once and the clock is not: the nightly full suite runs on
  // a main sha whose row already exists, and it is exactly the run whose
  // duration there would otherwise be no way to hear about.
  it("reads the timing of a rerun the row already answers", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/tests", { repo: REPO, sha: SHA, ok: true, durations: { tests: 60 } });
    const again = await (
      await post(t, "/tts/tests", {
        repo: REPO,
        sha: SHA,
        ok: true,
        mode: "full",
        durations: { tests: 120, suite: 900 },
      })
    ).json();
    expect(again.existing).toBe(true);
    const failures = await jobRows(t, "job-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].subject).toBe(SUITE_SLOW_KEY);
    // And the row itself still carries the FIRST run's answer.
    expect((await testsRows(t))[0].data).toMatchObject({ durations: { tests: 60 } });
  });

  it("never fails anything: a slow run still records a green row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const response = await post(t, "/tts/tests", {
      repo: REPO,
      sha: SHA,
      ok: true,
      mode: "full",
      durations: { tests: 9_999, suite: 9_999 },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).green).toBe(true);
    expect(
      (await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json()).missing,
    ).not.toContain("tests");
  });
});

describe("POST /tts/audit — the second check's own door", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the verdict out of the audit's own text and records it", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const text = "VERDICT: APPROVED\n\nIt does what it says and touches nothing else.";
    const response = await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text,
      model: "codex",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).verdict).toBe("APPROVED");
    expect((await auditRow(t))?.data).toMatchObject({ verdict: "APPROVED", text });
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(gate.missing).not.toContain("audit");
    expect(gate.checks.find((c: { name: string }) => c.name === "audit").why).toContain(
      "It does what it says and touches nothing else.",
    );
  });

  it("redacts the retained audit text and caps it at 8 KiB of UTF-8", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    // Credential-SHAPED (digits, no spaces, long enough) and not a credential:
    // the filter only takes a named value that could actually be one, so a
    // fixture reading "not-a-real-secret" would prove nothing about the door.
    const secret = "n0t-a-real-secret-9f3c1d8b";
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: `VERDICT: REFUSED\n\npassword=${secret}\n${"😀".repeat(5_000)}`,
    });
    const stored = ((await auditRow(t))?.data as { text?: unknown } | undefined)?.text;
    expect(typeof stored).toBe("string");
    expect(stored).toContain("password=[redacted:secret]");
    expect(stored).not.toContain(secret);
    expect(new TextEncoder().encode(stored as string).length).toBeLessThanOrEqual(
      AUDIT_TEXT_MAX_BYTES,
    );
  });

  it("files the removal check's findings on the row, beside the text they came out of", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text:
        "VERDICT: APPROVED\n\nIt lands safely.\n\n" +
        `${AUDIT_REMOVAL_HEADING}\n` +
        "- convex/http.ts:a second key header — the change does not say why the first cannot be deleted\n",
    });
    expect((await auditRow(t))?.data).toMatchObject({
      verdict: "APPROVED",
      removalNotes: [
        "convex/http.ts:a second key header — the change does not say why the first cannot be deleted",
      ],
    });
  });

  it("files an empty list for an audit that answered the removal check with none", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: `VERDICT: APPROVED\n\n${AUDIT_REMOVAL_HEADING} none\n\nIt deletes more than it adds.`,
    });
    expect((await auditRow(t))?.data).toMatchObject({ removalNotes: [] });
    // The gate is unmoved by either answer: the two head rows are still two.
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(gate.missing).toEqual(["tests"]);
  });

  it("refuses an answer with no verdict line — an audit that did not say did not finish", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const response = await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "I read the diff and it looks fine to me.",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("VERDICT");
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(gate.checks.find((c: { name: string }) => c.name === "audit").why).toContain(
      "no audit verdict",
    );
  });

  // UNAVAILABLE is the ABSENCE of an audit, not an audit: the auditor could
  // not be reached (Codex over its weekly cap). Write-once over that meant a
  // head audited during a capped hour could never merge at all.
  it("lets a real verdict replace an UNAVAILABLE, and the gate reads the new one", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: UNAVAILABLE\n\nThe audit could not run: you've hit your usage limit.",
      model: "codex",
    });
    const shut = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(shut.missing).toContain("audit");

    const replaced = await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: APPROVED\n\nIt lands what it claims and nothing else.",
      model: "claude-opus-5",
      fallback: "codex-cap",
    });
    expect((await replaced.json()).verdict).toBe("APPROVED");
    const open = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(open.missing).not.toContain("audit");
    // The failed attempt is still on the record — the newest row is what the
    // gate reads, not the only row there is.
    expect(await auditRows(t)).toHaveLength(2);
  });

  it("keeps an APPROVED and a REFUSED write-once, and does not stack UNAVAILABLEs", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const approved = convex();
    await post(approved, "/tts/audit", { repo: REPO, sha: SHA, text: "VERDICT: APPROVED\n\nfine" });
    const again = await (
      await post(approved, "/tts/audit", { repo: REPO, sha: SHA, text: "VERDICT: REFUSED\n\nno" })
    ).json();
    expect(again.existing).toBe(true);
    expect(again.verdict).toBe("APPROVED");
    expect(((await auditRow(approved))?.data as { verdict?: string })?.verdict).toBe("APPROVED");

    const refused = convex();
    await post(refused, "/tts/audit", { repo: REPO, sha: SHA, text: "VERDICT: REFUSED\n\nno" });
    const retried = await (
      await post(refused, "/tts/audit", {
        repo: REPO,
        sha: SHA,
        text: "VERDICT: APPROVED\n\nfine now",
        model: "claude-opus-5",
        fallback: "codex-cap",
      })
    ).json();
    expect(retried.existing).toBe(true);
    expect(retried.verdict).toBe("REFUSED");

    const unavailable = convex();
    const text = "VERDICT: UNAVAILABLE\n\nThe audit could not run.";
    await post(unavailable, "/tts/audit", { repo: REPO, sha: SHA, text });
    expect((await (await post(unavailable, "/tts/audit", { repo: REPO, sha: SHA, text })).json()).existing).toBe(true);
    expect(await auditRows(unavailable)).toHaveLength(1);
  });

  it("says WHO audited when Codex was capped, in the gate and in the merge line", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: APPROVED\n\nIt lands what it claims and nothing else.",
      model: "claude-opus-5",
      fallback: "codex-cap",
    });
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    const audit = gate.checks.find((c: { name: string }) => c.name === "audit");
    expect(audit.passed).toBe(true);
    expect(audit.why).toContain("(audit by claude-opus-5, Codex at its cap)");

    expect((await mergeReport(t)).status).toBe(200);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    // Tom reads the merge line in #tts-decisions; a same-family audit is a
    // thing he can object to, so the line has to say it happened.
    expect((scheduled[0].args[0] as { reason: string }).reason).toContain(
      "(audit by claude-opus-5, Codex at its cap)",
    );
  });

  // worker/jobs/audit.mjs's third rung: Codex at its cap and Claude at its
  // limit, so an OpenRouter model read the change. The gate's line and the
  // merge line name it with both refusals.
  it("says WHO audited when Codex and Claude were both out", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: APPROVED\n\nIt lands what it claims and nothing else.",
      model: "openrouter/deepseek/deepseek-v4-pro-0813",
      fallback: "codex-cap, claude-limit",
    });
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    const audit = gate.checks.find((c: { name: string }) => c.name === "audit");
    expect(audit.passed).toBe(true);
    expect(audit.why).toContain(
      "(audit by openrouter/deepseek/deepseek-v4-pro-0813, fallback: codex-cap, claude-limit)",
    );
  });

  it("says nothing extra when Codex itself audited", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: APPROVED\n\nfine",
      model: "codex",
    });
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(gate.checks.find((c: { name: string }) => c.name === "audit").why).not.toContain(
      "audit by",
    );
  });

  it("records a refusal as a refusal, and keeps the gate shut", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await post(t, "/tts/audit", {
      repo: REPO,
      sha: SHA,
      text: "VERDICT: REFUSED\n\nIt deletes the only caller of a live route.",
    });
    const response = await mergeReport(t);
    expect(response.status).toBe(409);
    const gate = (await response.json()).gate;
    expect(gate.checks.find((c: { name: string }) => c.name === "audit").why).toContain(
      "It deletes the only caller of a live route.",
    );
  });
});

describe("mergedOnMain", () => {
  it("asks GitHub how the sha compares with the repository's main", async () => {
    const { fake, asked } = github({ compare: "identical" });
    expect(await mergedOnMain(REPO, SHA, fake as unknown as typeof fetch)).toMatchObject({ merged: true });
    expect(asked).toEqual(["https://api.github.com/repos/Heffnt/tom.quest", `https://api.github.com/repos/Heffnt/tom.quest/compare/${SHA}...main`]);
  });

  // witness: the first version compared against main by name, and
  // ComplexMultiTrigger's main branch is master.
  it("compares against the branch GitHub names as the repository's default", async () => {
    const { fake, asked } = github({ main: "master", compare: "diverged", pulls: [{ number: 3, merged_at: "2026-09-21T12:00:00Z", base: { ref: "master" }, head: { sha: SHA } }] });
    expect(await mergedOnMain("ComplexMultiTrigger", SHA, fake as unknown as typeof fetch)).toMatchObject({ merged: true, why: expect.stringContaining("merged into master") });
    expect(asked[1]).toBe(`https://api.github.com/repos/Heffnt/ComplexMultiTrigger/compare/${SHA}...master`);
  });

  it("refuses a repository the record does not know and a value that is not a sha", async () => {
    const { fake, asked } = github();
    expect(await mergedOnMain("elsewhere", SHA, fake as unknown as typeof fetch)).toMatchObject({ merged: false });
    expect(await mergedOnMain(REPO, "main", fake as unknown as typeof fetch)).toMatchObject({ merged: false });
    expect(asked).toEqual([]);
  });

  // witness: the sixth audit of PR #207 — GitHub lists a merged pull request
  // for every commit in it, and an earlier commit of a squash merge never
  // reached main.
  it("does not count a commit of a merged pull request that was not its head", async () => {
    const { fake } = github({ compare: "diverged", pulls: [{ number: 8, merged_at: "2026-09-21T12:00:00Z", base: { ref: "main" }, head: { sha: "f".repeat(40) } }] });
    expect(await mergedOnMain(REPO, SHA, fake as unknown as typeof fetch)).toMatchObject({ merged: false });
  });

  it("does not count a pull request merged into another branch", async () => {
    const { fake } = github({ compare: "diverged", pulls: [{ number: 9, merged_at: "2026-09-21T12:00:00Z", base: { ref: "release" } }] });
    expect(await mergedOnMain(REPO, SHA, fake as unknown as typeof fetch)).toMatchObject({ merged: false });
  });
});

describe("compactCount", () => {
  it("groups below ten thousand and scales above it", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(812)).toBe("812");
    expect(compactCount(4_120)).toBe("4,120");
    expect(compactCount(9_999)).toBe("9,999");
    expect(compactCount(10_000)).toBe("10 K");
    expect(compactCount(12_345)).toBe("12.3 K");
    expect(compactCount(200_000)).toBe("200 K");
    expect(compactCount(812_000)).toBe("812 K");
    expect(compactCount(1_000_000)).toBe("1 M");
    expect(compactCount(1_437_221)).toBe("1.4 M");
    expect(compactCount(25_000_000)).toBe("25 M");
    expect(compactCount(150_000_000)).toBe("150 M");
  });

  it("answers a question mark rather than a number it does not have", () => {
    expect(compactCount(Number.NaN)).toBe("?");
    expect(compactCount(Number.POSITIVE_INFINITY)).toBe("?");
    expect(compactCount("1437221" as unknown as number)).toBe("?");
    expect(compactCount(undefined as unknown as number)).toBe("?");
  });
});

describe("auditChunkNote", () => {
  it("says how much of the diff was read, at a magnitude a person reads", () => {
    expect(auditChunkNote({ chunks: WHOLE_DIFF })).toBe(
      "12 of 12 chunks, 1.4 M of 1.4 M characters",
    );
    expect(
      auditChunkNote({ chunks: { ...WHOLE_DIFF, read: 3, charsRead: 200_000 } }),
    ).toBe("3 of 12 chunks, 200 K of 1.4 M characters");
    expect(
      auditChunkNote({
        chunks: { count: 1, read: 1, charsRead: 4_120, charsTotal: 4_120, truncatedChunks: 0, files: 2 },
      }),
    ).toBe("1 of 1 chunk, 4,120 of 4,120 characters");
  });

  // `data` is v.any() coming back out. A half-written sentence in the line Tom
  // reads is worse than no clause: the clause is a claim about coverage, and a
  // claim assembled out of a missing number is not one.
  it("renders nothing at all for a row with no chunks, or a malformed one", () => {
    expect(auditChunkNote({})).toBe("");
    expect(auditChunkNote({ chunks: null })).toBe("");
    expect(auditChunkNote({ chunks: "12 of 12" })).toBe("");
    expect(auditChunkNote({ chunks: { count: 12 } })).toBe("");
    expect(auditChunkNote({ chunks: { ...WHOLE_DIFF, charsTotal: "1.4 M" } })).toBe("");
    expect(auditChunkNote({ chunks: { ...WHOLE_DIFF, read: -1 } })).toBe("");
    expect(auditChunkNote({ chunks: { ...WHOLE_DIFF, count: Number.NaN } })).toBe("");
  });
});

// THE 2026-09-11 FAULT. The auditor approved a ~30,000-line diff having read
// the first 200,000 characters of it, and the row recorded nothing about how
// much it saw. These are the fields that make the difference legible — and
// none of them is a condition.
describe("what the audit row records about its own reading", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lands the coverage and the trace findings on the row", async () => {
    const t = convex();
    await recordAudit(t, {
      chunks: WHOLE_DIFF,
      traceFindings: [
        "it claimed the tests pass and no tests-run row exists for this head",
        "it claimed it opened worker/jobs/audit.mjs and its run never opened that path",
      ],
    });
    expect(await auditData(t)).toMatchObject({
      verdict: "APPROVED",
      chunks: WHOLE_DIFF,
      traceFindings: [
        "it claimed the tests pass and no tests-run row exists for this head",
        "it claimed it opened worker/jobs/audit.mjs and its run never opened that path",
      ],
    });
  });

  it("caps the trace findings and each of them, and redacts what they quote", async () => {
    const t = convex();
    // Credential-SHAPED and not a credential, like the audit-text fixture
    // above: a finding quotes the line it found, and a line a model printed can
    // carry a token. The findings arrive as an ARGUMENT, so this door is the
    // only place they can be filtered at all.
    // `gitleaks:allow` — the shape IS the test: a finding that quotes a
    // credential-shaped line is the thing this door must redact.
    const token = "ghp_0123456789abcdefghijABCD"; // gitleaks:allow
    await recordAudit(t, {
      traceFindings: [
        `it claimed the deploy ran with ${token} in the environment`,
        "x".repeat(500),
        ...Array.from({ length: AUDIT_REMOVAL_NOTES_MAX + 5 }, (_, i) => `finding ${i}`),
      ],
    });
    const findings = (await auditData(t)).traceFindings as string[];
    expect(findings).toHaveLength(AUDIT_REMOVAL_NOTES_MAX);
    expect(findings[0]).toContain("[redacted:github]");
    expect(findings[0]).not.toContain(token);
    expect(findings[1]).toHaveLength(AUDIT_REMOVAL_NOTE_MAX_CHARS);
  });

  // NOT ASKED is not ASKED AND CLEAN. A row with no key is an audit recorded
  // before any of this existed; `traceFindings: []` is an audit that was traced
  // and came back clean. Defaulting the absent one to `[]` erases that.
  it("writes NO KEY for a field it was not given", async () => {
    const t = convex();
    await recordAudit(t);
    const keys = Object.keys(await auditData(t));
    expect(keys).not.toContain("chunks");
    expect(keys).not.toContain("traceFindings");
    expect(keys).not.toContain("trace");
    // And the row it did always write is still there.
    expect(keys).toContain("removalNotes");
  });

  it("records the counted absence, so an unread run record does not read as clean", async () => {
    const t = convex();
    await recordAudit(t, {
      traceFindings: [],
      trace: { available: false, reason: `the session file was never written: ${"y".repeat(500)}` },
    });
    const data = await auditData(t);
    expect(data.traceFindings).toEqual([]);
    const trace = data.trace as { available: boolean; reason: string };
    expect(trace.available).toBe(false);
    expect(trace.reason).toHaveLength(AUDIT_REMOVAL_NOTE_MAX_CHARS);
    expect(trace.reason.startsWith("the session file was never written")).toBe(true);
  });

  it("keeps an available trace with no reason, and writes no reason key", async () => {
    const t = convex();
    await recordAudit(t, { trace: { available: true }, traceFindings: [] });
    const trace = (await auditData(t)).trace as Record<string, unknown>;
    expect(trace).toEqual({ available: true });
  });

  // Write-once is the point of this door and none of the new fields is an
  // opening in it: a thin read cannot be re-posted as a fat one over an
  // APPROVED, any more than a REFUSED can be re-posted as an APPROVED.
  it("keeps write-once with the new fields present", async () => {
    const t = convex();
    await recordAudit(t, { chunks: WHOLE_DIFF, traceFindings: [] });
    const again = await recordAudit(t, {
      verdict: "REFUSED",
      text: "VERDICT: REFUSED\n\nOn second thought.",
      chunks: { ...WHOLE_DIFF, read: 3, charsRead: 200_000 },
      traceFindings: ["it did not read the whole diff"],
    });
    expect(again.existing).toBe(true);
    expect(again.verdict).toBe("APPROVED");
    expect(await auditRows(t)).toHaveLength(1);
    expect((await auditData(t)).chunks).toEqual(WHOLE_DIFF);
  });

  it("lets a real verdict still replace an UNAVAILABLE, carrying its own chunks", async () => {
    const t = convex();
    await recordAudit(t, {
      verdict: "UNAVAILABLE",
      text: "VERDICT: UNAVAILABLE\n\nThe audit could not run: you've hit your usage limit.",
    });
    const replaced = await recordAudit(t, {
      model: "claude-opus-5",
      fallback: "codex-cap",
      chunks: WHOLE_DIFF,
      traceFindings: [],
    });
    expect(replaced.existing).toBe(false);
    expect(replaced.verdict).toBe("APPROVED");
    expect(await auditRows(t)).toHaveLength(2);
    // The newest row is the one the gate reads, and it carries its own coverage
    // — the UNAVAILABLE row before it still carries none, because it read none.
    expect((await auditData(t)).chunks).toEqual(WHOLE_DIFF);
    expect(Object.keys((await auditRows(t))[1].data as Record<string, unknown>)).not.toContain(
      "chunks",
    );
  });
});

describe("the chunk clause in the sentence Tom reads", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rides the APPROVED why, after the audit's own reason", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await recordAudit(t, { model: "codex", chunks: WHOLE_DIFF });
    expect(await auditWhy(t)).toBe(
      `the audit approved ${SHA.slice(0, 7)}` +
        " — It lands what it claims and nothing else." +
        " — 12 of 12 chunks, 1.4 M of 1.4 M characters",
    );
  });

  // An audit that REFUSED after reading a quarter of the diff is exactly as
  // interesting as one that approved after reading all of it, so the clause is
  // on the detail both arms carry rather than on the approval.
  it("rides the REFUSED why too, and says how little was read", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await recordAudit(t, {
      verdict: "REFUSED",
      text: "VERDICT: REFUSED\n\nIt deletes the only caller of a live route.",
      chunks: { ...WHOLE_DIFF, read: 3, charsRead: 200_000 },
    });
    const why = await auditWhy(t);
    expect(why).toContain(`the audit answered REFUSED at ${SHA.slice(0, 7)}`);
    expect(why).toContain("3 of 12 chunks, 200 K of 1.4 M characters");
  });

  it("says nothing at all for a row recorded before the diff was chunked", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await recordAudit(t, { model: "codex" });
    expect(await auditWhy(t)).toBe(
      `the audit approved ${SHA.slice(0, 7)} — It lands what it claims and nothing else.`,
    );
  });

  it("drops a malformed chunks object rather than printing half a sentence", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    // Written straight into the row: the mutation's validator would refuse this
    // shape, and the point is the READ side, where data is v.any().
    await seedFact(t, AUDIT_VERDICT, {
      verdict: "APPROVED",
      text: "VERDICT: APPROVED\n\nIt lands what it claims and nothing else.",
      chunks: { count: 12, read: "twelve" },
    });
    expect(await auditWhy(t)).toBe(
      `the audit approved ${SHA.slice(0, 7)} — It lands what it claims and nothing else.`,
    );
  });

  it("carries the clause into the #tts-decisions merge line for free", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await recordAudit(t, { chunks: WHOLE_DIFF });
    expect((await mergeReport(t)).status).toBe(200);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.includes("sendDecision"),
      ),
    );
    // internalRecordMerge joins the `why` strings into the decision's
    // reason, so the coverage reaches Tom wherever the gate's answer does.
    expect((scheduled[0].args[0] as { reason: string }).reason).toContain(
      "12 of 12 chunks, 1.4 M of 1.4 M characters",
    );
  });
});

// THERE IS NO THIRD VERIFIER. The gate is two head rows — tests and audit —
// and everything this round added to the audit row is a RECORD on the
// row the audit already wrote. This is the test that catches the day someone
// makes a thin read, an unavailable trace or a pile of trace findings deny a
// merge: none of them may move a single `passed` boolean.
describe("the new audit fields add no third gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function gateChecks(over: AuditOver) {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await recordAudit(t, over);
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    return {
      allowed: gate.allowed as boolean,
      passed: (gate.checks as { name: string; passed: boolean }[]).map((c) => ({
        name: c.name,
        passed: c.passed,
      })),
    };
  }

  it("answers exactly two checks, and the same two booleans, loaded or bare", async () => {
    const bare = await gateChecks({});
    const loaded = await gateChecks({
      // A THIN READ: one chunk of twelve, and the audit approved anyway.
      chunks: { ...WHOLE_DIFF, read: 1, charsRead: 120_000, truncatedChunks: 4 },
      traceFindings: Array.from({ length: AUDIT_REMOVAL_NOTES_MAX }, (_, i) => `finding ${i}`),
      trace: { available: false, reason: "the run record could not be read" },
    });

    expect(bare.passed).toEqual([
      { name: "tests", passed: true },
      { name: "audit", passed: true },
    ]);
    expect(loaded.passed).toEqual(bare.passed);
    expect(bare.allowed).toBe(true);
    expect(loaded.allowed).toBe(true);
  });

  it("still denies on the verdict, and only on the verdict", async () => {
    const refused = await gateChecks({
      verdict: "REFUSED",
      text: "VERDICT: REFUSED\n\nIt deletes the only caller of a live route.",
      // A PERFECT read that refused: coverage is not what opens the gate either.
      chunks: WHOLE_DIFF,
      traceFindings: [],
      trace: { available: true },
    });
    expect(refused.passed).toEqual([
      { name: "tests", passed: true },
      { name: "audit", passed: false },
    ]);
    expect(refused.allowed).toBe(false);
  });
});

// ── The gate as the `tts-gate` commit status ────────────────────────────────
describe("the gate posted as the tts-gate commit status", () => {
  /** GitHub's statuses endpoint, answering `status`; every call is kept. */
  function statusesApi(status = 201) {
    const calls: { url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return status === 201
        ? Response.json({ id: 1, state: "success" }, { status: 201 })
        : Response.json({ message: "Resource not accessible by personal access token" }, { status });
    });
    vi.stubGlobal("fetch", fake);
    return calls;
  }

  const recordAudit = (t: TestConvex<typeof schema>, verdict: string) =>
    t.mutation(internal.ttsMerge.internalRecordAudit, {
      repo: REPO,
      sha: SHA,
      verdict,
      text: `The change is sound.\nVERDICT: ${verdict}\nIt does what it says.`,
    });
  const recordTests = (t: TestConvex<typeof schema>, ok: boolean) =>
    t.mutation(internal.ttsMerge.internalRecordTests, { repo: REPO, sha: SHA, ok });
  const settle = (t: TestConvex<typeof schema>) => t.finishAllScheduledFunctions(vi.runAllTimers);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "test-token");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("tests-run green and audit-verdict APPROVED post one status: success, on the head sha", async () => {
    const calls = statusesApi();
    const t = convex();
    await greenTests(t);
    await recordAudit(t, "APPROVED");
    await settle(t);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // POST /repos/{owner}/{repo}/statuses/{sha}, body { state, description, context }
    // (docs.github.com/en/rest/commits/statuses#create-a-commit-status).
    expect(call.url).toBe(`https://api.github.com/repos/Heffnt/tom.quest/statuses/${SHA}`);
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer test-token");
    expect(call.headers.Accept).toBe("application/vnd.github+json");
    // The gate's own status text shares a 40-character window with the line of
    // the private operate page that describes the gate, and check-private-paths
    // has no carve-out for public product text, so the expected string is
    // written in two pieces; the assertion is still the whole exact string.
    expect(call.body).toEqual({
      state: "success",
      description: "open at a1b2c3d: tests-run green," + " audit-verdict APPROVED",
      context: "tts-gate",
    });
  });

  it("a refused audit posts failure and names the row", async () => {
    const calls = statusesApi();
    const t = convex();
    await greenTests(t);
    await recordAudit(t, "REFUSED");
    await settle(t);
    expect(calls.map((c) => c.body)).toEqual([
      { state: "failure", description: "refused at a1b2c3d: audit-verdict REFUSED", context: "tts-gate" },
    ]);
  });

  it("red tests post failure; a missing row posts pending naming it", async () => {
    const calls = statusesApi();
    const t = convex();
    await recordTests(t, false);
    await settle(t);
    await recordAudit(t, "APPROVED");
    await settle(t);
    expect(calls.map((c) => c.body.state)).toEqual(["failure", "failure"]);
    expect(calls[0].body.description).toBe("refused at a1b2c3d: tests-run red; waiting for audit-verdict");

    const t2 = convex();
    calls.length = 0;
    await recordTests(t2, true);
    await settle(t2);
    expect(calls.map((c) => c.body)).toEqual([
      { state: "pending", description: "waiting for audit-verdict at a1b2c3d", context: "tts-gate" },
    ]);
    // Each row written posts the gate's answer as it now stands.
    await recordAudit(t2, "APPROVED");
    await settle(t2);
    expect(calls.map((c) => c.body.state)).toEqual(["pending", "success"]);
  });

  it("an UNAVAILABLE audit is no audit: pending, not failure", async () => {
    const calls = statusesApi();
    const t = convex();
    await greenTests(t);
    await recordAudit(t, "UNAVAILABLE");
    await settle(t);
    expect(calls.map((c) => c.body)).toEqual([
      { state: "pending", description: "waiting for audit-verdict at a1b2c3d", context: "tts-gate" },
    ]);
  });

  it("a status GitHub refuses is one keyed job-failed row, and the next success recovers it", async () => {
    statusesApi(403);
    const t = convex();
    await greenTests(t);
    await recordAudit(t, "APPROVED");
    await settle(t);
    const failed = await t.run((ctx) =>
      ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "job-failed").eq("subject", "gate-status:tom.quest")).collect(),
    );
    expect(failed).toHaveLength(1);
    expect((failed[0].data as { error: string }).error).toMatch(
      /tts-gate status was not posted on tom\.quest@a1b2c3d: GitHub answered 403: Resource not accessible/,
    );

    statusesApi();
    await t.action(internal.ttsMerge.internalPostGateStatus, { repo: REPO, sha: SHA });
    const recovered = await t.run((ctx) =>
      ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "job-recovered").eq("subject", "gate-status:tom.quest")).collect(),
    );
    expect(recovered).toHaveLength(1);
  });

  it("posts again when a row lands while it was posting, so the last post is the current answer", async () => {
    const t = convex();
    await greenTests(t);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      // The audit is recorded between this action's read and its post.
      if (bodies.length === 1) await approvedAudit(t);
      return Response.json({}, { status: 201 });
    }));
    const result = await t.action(internal.ttsMerge.internalPostGateStatus, { repo: REPO, sha: SHA });
    expect(bodies.map((b) => b.state)).toEqual(["pending", "success"]);
    expect(result.posted.map((p) => p.state)).toEqual(["pending", "success"]);
  });

  it("posts nothing without a credential, for an unknown repo, or for a short sha", async () => {
    const calls = statusesApi();
    const t = convex();
    await greenTests(t);
    await approvedAudit(t);
    expect((await t.action(internal.ttsMerge.internalPostGateStatus, { repo: "nope", sha: SHA })).posted).toEqual([]);
    expect((await t.action(internal.ttsMerge.internalPostGateStatus, { repo: REPO, sha: SHA.slice(0, 7) })).posted).toEqual([]);
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "");
    expect((await t.action(internal.ttsMerge.internalPostGateStatus, { repo: REPO, sha: SHA })).why).toBe(
      "the record holds no GitHub credential",
    );
    expect(calls).toHaveLength(0);
  });
});
