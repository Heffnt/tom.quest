import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  AUDIT_TEXT_MAX_BYTES,
  AUDIT_VERDICT,
  MERGE,
  TESTS_RUN,
  auditVerdictOf,
  commitKey,
} from "./ttsMerge";
import { EVALS_RUN } from "./ttsEvals";

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

/** A row of one kind against one commit, written straight in: these three are
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
const cleanEvals = (t: TestConvex<typeof schema>, sha = SHA) =>
  seedFact(t, EVALS_RUN, { regressions: 0, pass: 40, items: 40 }, sha);

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

const auditRow = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", AUDIT_VERDICT).eq("key", commitKey(REPO, SHA)))
      .unique(),
  );

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

describe("the merge gate's three checks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a merge with nothing on record, and names all three", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const response = await mergeReport(t);
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer.ok).toBe(false);
    expect(answer.gate.missing).toEqual(["tests", "audit", "evals"]);
    expect(answer.error).toContain("tests, audit, evals");
    expect(await mergeRows(t)).toHaveLength(0);
  });

  it("refuses when only the TESTS are missing, and says the row is absent", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await approvedAudit(t);
    await cleanEvals(t);
    const answer = await (await mergeReport(t)).json();
    expect(answer.gate.missing).toEqual(["tests"]);
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "tests").why).toContain(
      "no tests result",
    );
  });

  it("refuses on RED tests, and says so rather than saying nothing is recorded", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await seedFact(t, TESTS_RUN, { ok: false, detail: "guardrails tests job" });
    await approvedAudit(t);
    await cleanEvals(t);
    const answer = await (await mergeReport(t)).json();
    expect(answer.gate.missing).toEqual(["tests"]);
    const tests = answer.gate.checks.find((c: { name: string }) => c.name === "tests");
    expect(tests.why).toContain("red");
    expect(tests.why).toContain("guardrails tests job");
  });

  it("refuses when only the AUDIT is missing, and when it answered something else", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const missing = convex();
    await greenTests(missing);
    await cleanEvals(missing);
    expect((await (await mergeReport(missing)).json()).gate.missing).toEqual(["audit"]);

    const refused = convex();
    await greenTests(refused);
    await cleanEvals(refused);
    await seedFact(refused, AUDIT_VERDICT, { verdict: "REFUSED" });
    const answer = await (await mergeReport(refused)).json();
    expect(answer.gate.missing).toEqual(["audit"]);
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "audit").why).toContain(
      "answered REFUSED",
    );
  });

  it("refuses when only the EVALS are missing, and when they found a regression", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const missing = convex();
    await greenTests(missing);
    await approvedAudit(missing);
    expect((await (await mergeReport(missing)).json()).gate.missing).toEqual(["evals"]);

    const regressed = convex();
    await greenTests(regressed);
    await approvedAudit(regressed);
    await seedFact(regressed, EVALS_RUN, { regressions: 2, pass: 38, items: 40 });
    const answer = await (await mergeReport(regressed)).json();
    expect(answer.gate.missing).toEqual(["evals"]);
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "evals").why).toContain(
      "2 regressions",
    );
  });

  it("checks the head it was given, not another commit", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    const other = "b".repeat(40);
    await greenTests(t, other);
    await approvedAudit(t, other);
    await cleanEvals(t, other);
    expect((await (await mergeReport(t)).json()).gate.missing).toEqual([
      "tests",
      "audit",
      "evals",
    ]);
    expect((await mergeReport(t, { sha: other })).status).toBe(200);
  });
});

describe("a merge the gate allows", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function gated(t: TestConvex<typeof schema>) {
    await greenTests(t);
    await approvedAudit(t);
    await cleanEvals(t);
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

  it("posts ONE line to #tts-decisions, naming the merge and the three checks", async () => {
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
    expect(args.reason).toContain("no regression");
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

  it("answers the three checks and opens nothing by itself", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    const shut = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(shut.allowed).toBe(false);
    expect(shut.missing).toEqual(["audit", "evals"]);
    expect(shut.checks).toHaveLength(3);
    // A read is a read: no merge row appeared.
    expect(await mergeRows(t)).toHaveLength(0);

    await approvedAudit(t);
    await cleanEvals(t);
    const open = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(open.allowed).toBe(true);
    expect(open.missing).toEqual([]);
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
    const secret = "not-a-real-secret";
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

  it("records a refusal as a refusal, and keeps the gate shut", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await cleanEvals(t);
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
