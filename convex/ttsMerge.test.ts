import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  AUDIT_REMOVAL_HEADING,
  AUDIT_REMOVAL_NOTES_MAX,
  AUDIT_REMOVAL_NOTE_MAX_CHARS,
  AUDIT_TEXT_MAX_BYTES,
  AUDIT_VERDICT,
  MERGE,
  TESTS_RUN,
  auditVerdictOf,
  checkRowPassed,
  commitKey,
  removalNotesOf,
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
/** A run that opens the evals arm: no regression AND golden coverage answered
 *  true. Both are needed — a run that did not check coverage is a run that did
 *  not answer, and the arm treats that as a no. */
const cleanEvals = (t: TestConvex<typeof schema>, sha = SHA) =>
  seedFact(t, EVALS_RUN, { regressions: 0, goldenCoverage: true, pass: 40, items: 40 }, sha);

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
  it("answers for each of the three kinds, and false for a kind it was never taught", () => {
    expect(checkRowPassed(TESTS_RUN, { ok: true })).toBe(true);
    expect(checkRowPassed(TESTS_RUN, { ok: false })).toBe(false);
    expect(checkRowPassed(TESTS_RUN, {})).toBe(false);

    expect(checkRowPassed(AUDIT_VERDICT, { verdict: "approved" })).toBe(true);
    expect(checkRowPassed(AUDIT_VERDICT, { verdict: "REFUSED" })).toBe(false);
    expect(checkRowPassed(AUDIT_VERDICT, {})).toBe(false);

    expect(checkRowPassed(EVALS_RUN, { regressions: 0 })).toBe(true);
    expect(checkRowPassed(EVALS_RUN, { regressions: 2 })).toBe(false);
    expect(checkRowPassed(EVALS_RUN, {})).toBe(false);

    expect(checkRowPassed("merge", { ok: true })).toBe(false);
    expect(checkRowPassed(TESTS_RUN, undefined)).toBe(false);
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

  // NULL IS NOT ZERO, and this is the pin. worker/jobs/evals.mjs failedRun and
  // its uncompared-head path both stamp `regressions: null`: a head compared
  // to nothing has no number of regressions. A gate that read that as "no
  // regressions found" would open on a run that never compared anything.
  it("denies a head whose regressions are null, with no base to compare against", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await approvedAudit(t);
    await seedFact(t, EVALS_RUN, { regressions: null, goldenCoverage: true, pass: 40, items: 40 });
    const answer = await (await mergeReport(t)).json();
    expect(answer.gate.missing).toEqual(["evals"]);
    expect(answer.gate.checks.find((c: { name: string }) => c.name === "evals").why).toContain(
      "an unreadable number of regressions",
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

// Golden coverage is not a fourth check. It is a second question asked of the
// evals row: a change to a watched context file that shipped no golden item
// changed Tom's outputs with nothing scoring the change.
describe("the evals arm's golden-coverage clause", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function gateWith(coverage: Record<string, unknown>) {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convex();
    await greenTests(t);
    await approvedAudit(t);
    await seedFact(t, EVALS_RUN, { regressions: 0, pass: 40, items: 40, ...coverage });
    const answer = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    return {
      allowed: answer.allowed as boolean,
      missing: answer.missing as string[],
      why: (answer.checks as { name: string; why: string }[]).find((c) => c.name === "evals")!.why,
    };
  }

  it("opens on no regression AND coverage true", async () => {
    const gate = await gateWith({ goldenCoverage: true });
    expect(gate.allowed).toBe(true);
    expect(gate.why).toContain("no regression");
  });

  // The row an UNAFFECTED branch gets: the check read its own diff, nothing in
  // it was a watched path, and the door recorded that in seconds instead of
  // asking for a run of a set this change cannot move. Before it existed, the
  // workflow simply did not fire on such a branch, no evals row was ever
  // written, and a pure-code pull request could never merge.
  it("opens on coverage not-required, and says the evals are unaffected", async () => {
    const gate = await gateWith({ goldenCoverage: "not-required", unaffected: true });
    expect(gate.allowed).toBe(true);
    expect(gate.missing).toEqual([]);
    expect(gate.why).toBe(`the evals are unaffected at ${SHA.slice(0, 7)}: no watched path changed`);
  });

  // "not-required" is the ONE word that opens this way. Anything else on the
  // field is a run that did not answer, and the gate denies it.
  it("denies any other string on the field", async () => {
    const gate = await gateWith({ goldenCoverage: "not required" });
    expect(gate.missing).toEqual(["evals"]);
    expect(gate.why).toContain("did not check golden coverage");
  });

  it("denies on coverage false, and says a watched file changed with no item", async () => {
    const gate = await gateWith({ goldenCoverage: false });
    expect(gate.missing).toEqual(["evals"]);
    expect(gate.why).toBe(
      `the evals run at ${SHA.slice(0, 7)} changed a watched context file and shipped no golden item`,
    );
  });

  // BOTH of these are "we did not check", not "there was nothing to check": a
  // merge always has a diff. null is a run that was asked nothing; undefined is
  // a run recorded before the field existed. The deny message names the one
  // command that fixes either.
  it("denies on coverage null — the run was never asked about a diff", async () => {
    const gate = await gateWith({ goldenCoverage: null });
    expect(gate.missing).toEqual(["evals"]);
    expect(gate.why).toBe(
      `the evals run did not check golden coverage — re-run it: ` +
        `node /opt/tts/evals.mjs --repo ${REPO} --sha ${SHA} --force`,
    );
  });

  it("denies a run that predates the field, with the same message", async () => {
    const gate = await gateWith({});
    expect(gate.missing).toEqual(["evals"]);
    expect(gate.why).toContain("did not check golden coverage");
    expect(gate.why).toContain("--force");
  });

  it("names the regression first when a run both regressed and shipped no item", async () => {
    const gate = await gateWith({ regressions: 3, goldenCoverage: false });
    expect(gate.missing).toEqual(["evals"]);
    expect(gate.why).toContain("3 regressions");
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

  // THE REMOVAL CHECK IS NOT A FOURTH HEAD ROW (§23.8). The findings ride on
  // the audit row; the gate's answer has to be the same object with and
  // without them, which is what a deep equality over the whole result proves
  // and a spot check on `allowed` would not.
  it("answers identically whether or not the audit row carries removal notes", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const notes = ["convex/http.ts:a second key header — the change does not say why"];
    const text = "VERDICT: APPROVED\n\nIt does what it says.";

    async function gateWith(auditData: Record<string, unknown>, evalsRegressions: number) {
      const t = convex();
      await greenTests(t);
      await seedFact(t, AUDIT_VERDICT, auditData);
      // goldenCoverage rides along because the evals arm now asks two questions
      // of the one row (§ the golden-coverage gate); this test is about the audit
      // row's removal notes, so its evals row has to be one that passes.
      await seedFact(t, EVALS_RUN, { regressions: evalsRegressions, goldenCoverage: true, pass: 40, items: 40 });
      return await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    }

    const open = await gateWith({ verdict: "APPROVED", text }, 0);
    const openWithNotes = await gateWith({ verdict: "APPROVED", text, removalNotes: notes }, 0);
    expect(openWithNotes).toEqual(open);
    expect(open.allowed).toBe(true);

    const shut = await gateWith({ verdict: "REFUSED", text }, 1);
    const shutWithNotes = await gateWith({ verdict: "REFUSED", text, removalNotes: notes }, 1);
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
    // The gate is unmoved by either answer: the three head rows are still three.
    const gate = await (await get(t, `/tts/merge-gate?repo=${REPO}&sha=${SHA}`)).json();
    expect(gate.missing).toEqual(["tests", "evals"]);
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
    await cleanEvals(t);
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
