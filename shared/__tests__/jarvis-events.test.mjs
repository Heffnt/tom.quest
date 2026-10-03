import { describe, expect, it } from "vitest";
import { EVENT_KINDS, REPEATS_BY_DATA_ID, SUBJECT_REQUIRED, TOM_ONLY_KINDS, validateEvent } from "../jarvis-events.mjs";

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

  it("lists every kind once", () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });
});
