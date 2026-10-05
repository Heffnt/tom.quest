import { describe, expect, it } from "vitest";
import { EVENT_KINDS, JOB_KINDS_WITH_DURATION, REPEATS_BY_DATA_ID, SUBJECT_REQUIRED, TOM_ONLY_KINDS, registryDiffOf, validateEvent } from "../jarvis-events.mjs";

describe("validateEvent", () => {
  it("fills at and data, keeps subject and text, and drops nothing it was given", () => {
    const result = validateEvent(
      { kind: "job-ok", provenance: { job: "box-watch" }, subject: "box-watch:read", text: "box-watch ran clean" },
      { now: 1000 },
    );
    expect(result).toEqual({
      ok: true,
      event: { kind: "job-ok", at: 1000, provenance: { job: "box-watch" }, data: {}, subject: "box-watch:read", text: "box-watch ran clean" },
    });
  });

  it("refuses a kind outside the list, naming the list", () => {
    expect(validateEvent({ kind: "made-up" })).toEqual({ ok: false, error: expect.stringContaining("EVENT_KINDS") });
    expect(validateEvent({ kind: "" }).ok).toBe(false);
    expect(validateEvent(null).ok).toBe(false);
  });

  it("refuses a provenance field the table does not hold, and an empty one", () => {
    expect(validateEvent({ kind: "job-ok", provenance: { host: "box" } }).error).toContain("provenance.host");
    expect(validateEvent({ kind: "job-ok", provenance: { job: "" } }).error).toContain("provenance.job");
    expect(validateEvent({ kind: "job-ok", provenance: [] }).ok).toBe(false);
  });

  it("refuses a malformed at, subject or text", () => {
    expect(validateEvent({ kind: "job-ok", at: "now" }).ok).toBe(false);
    expect(validateEvent({ kind: "job-ok", subject: "" }).ok).toBe(false);
    expect(validateEvent({ kind: "job-ok", text: 3 }).ok).toBe(false);
  });

  it("refuses an at more than five minutes past the writer's clock, and takes one within it", () => {
    const now = 1_700_000_000_000;
    expect(validateEvent({ kind: "job-ok", at: now + 5 * 60_000 + 1 }, { now })).toEqual({
      ok: false,
      error: "at is more than 5 minutes in the future",
    });
    expect(validateEvent({ kind: "job-ok", at: now + 5 * 60_000 }, { now }).ok).toBe(true);
    expect(validateEvent({ kind: "job-ok", at: now - 60_000 }, { now }).ok).toBe(true);
  });

  it("takes an eval set's run, subject the set's name", () => {
    const result = validateEvent({ kind: "eval-run", provenance: { job: "evals" }, subject: "wall", data: { set: "wall", passed: 3, total: 3 }, text: "wall: 3 of 3 pass" });
    expect(result).toMatchObject({ ok: true, event: { kind: "eval-run", subject: "wall", text: "wall: 3 of 3 pass" } });
  });

  it("refuses a decision, a digest line or an eval run without its subject", () => {
    for (const kind of ["decision", "digest-line", "eval-run"]) {
      expect(validateEvent({ kind, data: {} })).toEqual({ ok: false, error: `a ${kind} event names its subject` });
      expect(validateEvent({ kind, subject: "s", data: {} }).ok).toBe(true);
    }
  });

  it("refuses a thread-reply without its subject", () => {
    expect(validateEvent({ kind: "thread-reply", data: { kind: "todo" }, text: "a todo" })).toEqual({
      ok: false,
      error: "a thread-reply event names its subject",
    });
    expect(validateEvent({ kind: "thread-reply", subject: "m1", data: { kind: "todo" }, text: "a todo" }).ok).toBe(true);
  });

  it("refuses a thread-reply with only a subject, and one with an unknown data.kind", () => {
    expect(validateEvent({ kind: "thread-reply", subject: "m1" }).ok).toBe(false);
    expect(validateEvent({ kind: "thread-reply", subject: "m1", data: { kind: "idea" }, text: "an idea" }).ok).toBe(false);
    expect(validateEvent({ kind: "thread-reply", subject: "m1", data: { kind: "todo" }, text: "a todo" }).ok).toBe(true);
  });

  it("takes a complete part-disabled event and lists its identity rules", () => {
    const event = {
      kind: "part-disabled",
      provenance: { job: "deploy" },
      subject: "poll-dump",
      data: { id: "part-disabled:poll-dump", part: "poll-dump", replacedBy: "thread-reply", ruling: "2026-10-02: \"retire slack fully.\"" },
    };
    expect(validateEvent(event)).toMatchObject({ ok: true, event });
    expect(SUBJECT_REQUIRED).toContain("part-disabled");
    expect(REPEATS_BY_DATA_ID).toContain("part-disabled");
  });

  it("refuses an incomplete or mismatched part-disabled event", () => {
    const data = { id: "part-disabled:poll-dump", part: "poll-dump", replacedBy: "thread-reply", ruling: "2026-10-02: \"retire slack fully.\"" };
    expect(validateEvent({ kind: "part-disabled", data }).error).toBe("a part-disabled event names its subject");
    expect(validateEvent({ kind: "part-disabled", subject: "write-slack", data }).error).toBe("a part-disabled event names data.part as its subject");
    expect(validateEvent({ kind: "part-disabled", subject: data.part, data: { part: data.part, replacedBy: data.replacedBy, ruling: data.ruling } }).error).toBe("a part-disabled event names data.id as part-disabled:<part>");
    expect(validateEvent({ kind: "part-disabled", subject: data.part, data: { ...data, id: "part-disabled:write-slack" } }).error).toBe("a part-disabled event names data.id as part-disabled:<part>");
    expect(validateEvent({ kind: "part-disabled", subject: data.part, data: { ...data, replacedBy: "" } }).error).toContain("data.replacedBy");
    expect(validateEvent({ kind: "part-disabled", subject: data.part, data: { ...data, ruling: "" } }).error).toContain("data.ruling");
  });

  it("takes a complete work-run event and lists its subject as its identity", () => {
    const baseCommit = "a".repeat(40);
    const event = {
      kind: "work-run",
      provenance: { agentId: "codex:box:synthetic-session", job: "work-queue" },
      subject: `example@${baseCommit}`,
      data: {
        repo: "example", remote: "https://example.invalid/repo.git", cwd: "/workspace/example", baseCommit,
        briefKey: "runs/example/brief", preStatePatchKey: "runs/example/pre.patch", resultDiffKey: "runs/example/result.patch",
        bytes: { brief: 120, preStatePatch: 0, resultDiff: 240 }, check: "pnpm test", checkPassed: true,
        model: "synthetic-model", effort: "high", sandbox: "workspace-write", durationMs: 1234,
        costUsd: 0.01, exitCode: 0, harness: "codex", agentToken: "synthetic-agent-token",
      },
      text: "example on synthetic-model completed",
    };
    expect(validateEvent(event)).toMatchObject({ ok: true, event });
    expect(SUBJECT_REQUIRED).toContain("work-run");
  });

  it("refuses each malformed work-run identity field", () => {
    const baseCommit = "a".repeat(40);
    const data = {
      repo: "example", baseCommit, model: "synthetic-model", briefKey: "brief", preStatePatchKey: "pre",
      resultDiffKey: "result", harness: "codex", check: "pnpm test", checkPassed: true,
    };
    const event = { kind: "work-run", subject: `example@${baseCommit}`, data };
    const cases = [
      [{ ...event, data: null }, "a work-run event names data as an object"],
      [{ ...event, data: { ...data, repo: "" } }, "a work-run event names data.repo as a non-empty string"],
      [{ ...event, data: { ...data, baseCommit: "" } }, "a work-run event names data.baseCommit as a non-empty string"],
      [{ ...event, data: { ...data, model: "" } }, "a work-run event names data.model as a non-empty string"],
      [{ ...event, data: { ...data, briefKey: "" } }, "a work-run event names data.briefKey as a non-empty string"],
      [{ ...event, data: { ...data, preStatePatchKey: "" } }, "a work-run event names data.preStatePatchKey as a non-empty string"],
      [{ ...event, data: { ...data, resultDiffKey: "" } }, "a work-run event names data.resultDiffKey as a non-empty string"],
      [{ ...event, data: { ...data, baseCommit: "A".repeat(40) } }, "a work-run event names data.baseCommit as 40 lowercase hexadecimal characters"],
      [{ ...event, subject: `other@${baseCommit}` }, "a work-run event names <repo>@<baseCommit> as its subject"],
      [{ ...event, data: { ...data, harness: "other" } }, "a work-run event names data.harness as codex"],
      [{ ...event, data: { ...data, check: "" } }, "a work-run event names data.check as null or a non-empty string"],
      [{ ...event, data: { ...data, checkPassed: "yes" } }, "a work-run event names data.checkPassed as null or a boolean"],
      [{ ...event, data: { ...data, check: null } }, "a work-run event names data.check and data.checkPassed as both null or both non-null"],
    ];
    for (const [candidate, error] of cases) expect(validateEvent(candidate)).toEqual({ ok: false, error });
  });

  it("keeps thread-message as a Tom-only kind", () => {
    expect(TOM_ONLY_KINDS).toContain("thread-message");
    expect(SUBJECT_REQUIRED).toContain("thread-reply");
  });

  it("takes a job row's runtime as data.durationMs and keeps it", () => {
    for (const kind of ["job-ok", "job-failed"]) {
      const result = validateEvent({ kind, provenance: { job: "poll-gmail" }, subject: "poll-gmail:auth", data: { job: "poll-gmail", durationMs: 4210 } }, { now: 1000 });
      expect(result).toMatchObject({ ok: true, event: { data: { job: "poll-gmail", durationMs: 4210 } } });
    }
    expect(validateEvent({ kind: "job-ok", data: { job: "deploy", durationMs: 0 } }).ok).toBe(true);
    // A row without it is the row every job posted before the field existed.
    expect(validateEvent({ kind: "job-ok", data: { job: "deploy", key: "deploy" } }).ok).toBe(true);
    expect(JOB_KINDS_WITH_DURATION).toEqual(["job-ok", "job-failed"]);
  });

  it("refuses a job row whose durationMs is not non-negative milliseconds", () => {
    for (const durationMs of [-1, "4210", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateEvent({ kind: "job-failed", data: { job: "deploy", error: "x", durationMs } })).toEqual({
        ok: false,
        error: "a job-failed event names data.durationMs, when given, as non-negative milliseconds",
      });
    }
    // Another kind's durationMs is that kind's business (a work-run carries its own).
    expect(validateEvent({ kind: "digest-line", subject: "deploy", data: { durationMs: "n/a" } }).ok).toBe(true);
  });

  it("lists every kind once", () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });
});

describe("the design page's events", () => {
  const row = (id, extra = {}) => ({ id, name: id, type: "program", fate: { type: "kept", by: null }, serves: [{ guarantee: "G4" }], ...extra });
  const registry = (data = {}, extra = {}) => {
    const parts = data.parts ?? [row("deploy"), row("sweep")];
    return {
      kind: "registry",
      subject: "Jarvis@abc1234",
      provenance: { job: "deploy" },
      data: { id: "registry:Jarvis@abc1234", repo: "Jarvis", sha: "abc1234", parts, count: parts.length, ...data },
      text: "registry of Jarvis at abc1234: 2 parts",
      ...extra,
    };
  };

  it("takes a registry named by its deployed commit, and is retried by data.id", () => {
    expect(validateEvent(registry()).ok).toBe(true);
    expect(SUBJECT_REQUIRED).toContain("registry");
    expect(REPEATS_BY_DATA_ID).toContain("registry");
  });

  it("refuses a registry with no subject, a row with no id, an unknown type or fate, or a count that is not the rows'", () => {
    expect(validateEvent(registry({}, { subject: undefined })).error).toBe("a registry event names its subject");
    expect(validateEvent(registry({ parts: [{ name: "x", type: "program", fate: { type: "kept" }, serves: [] }], count: 1 })).error).toContain("data.parts[0].id");
    expect(validateEvent(registry({ parts: [row("x", { type: "kind" })], count: 1 })).error).toContain("row x has a type");
    expect(validateEvent(registry({ parts: [row("x", { fate: { kind: "kept" } })], count: 1 })).error).toContain("row x has a fate.type");
    expect(validateEvent(registry({ parts: [row("x", { serves: undefined })], count: 1 })).error).toContain("row x has no serves list");
    expect(validateEvent(registry({ count: 3 })).error).toContain("data.count");
    expect(validateEvent(registry({ id: "registry:other" })).error).toContain("data.id");
    expect(validateEvent(registry({}, { subject: "Jarvis@other" })).error).toContain("Jarvis@<data.sha>");
  });

  const explanation = (data = {}, extra = {}) => ({
    kind: "explanation",
    subject: "deploy",
    provenance: { session: "aaa9ae16" },
    data: { title: "The deploy job", html: "<!doctype html><html><body><h1>The deploy job</h1></body></html>", ...data },
    text: "The deploy job",
    ...extra,
  });

  it("takes an explanation of a part by the agent that wrote it", () => {
    expect(validateEvent(explanation()).ok).toBe(true);
    expect(validateEvent(explanation({ html: "  <!DOCTYPE html><p>x</p>" })).ok).toBe(true);
    expect(SUBJECT_REQUIRED).toContain("explanation");
  });

  it("refuses an explanation with a script, a src attribute, no doctype, no author or no subject", () => {
    expect(validateEvent(explanation({ html: "<!doctype html><script>alert(1)</script>" })).error).toContain("no script");
    expect(validateEvent(explanation({ html: '<!doctype html><img src="x">' })).error).toContain("no script");
    expect(validateEvent(explanation({ html: "<html></html>" })).error).toContain("<!doctype html>");
    expect(validateEvent(explanation({}, { provenance: { job: "x" } })).error).toContain("the agent that wrote it");
    expect(validateEvent(explanation({}, { subject: undefined })).error).toContain("names its subject");
  });
});

describe("registryDiffOf", () => {
  const diff = { base: "abcdef0", added: ["new-part"], changed: ["deploy"], removed: ["sweep"], rows: { deploy: { id: "deploy" }, "new-part": { id: "new-part" } } };

  it("takes a well-formed diff and refuses a malformed one", () => {
    expect(registryDiffOf(diff)).toEqual(diff);
    expect(registryDiffOf({ ...diff, base: "" })).toBeNull();
    expect(registryDiffOf({ ...diff, added: ["Not An Id"] })).toBeNull();
    expect(registryDiffOf({ ...diff, rows: { sweep: { id: "sweep" } } })).toBeNull();
    expect(registryDiffOf({ ...diff, rows: { deploy: { id: "other" } } })).toBeNull();
    expect(registryDiffOf("a diff")).toBeNull();
  });
});
