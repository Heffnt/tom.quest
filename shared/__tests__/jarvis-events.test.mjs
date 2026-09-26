import { describe, expect, it } from "vitest";
import { EVENT_KINDS, validateEvent } from "../jarvis-events.mjs";

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

  it("takes an eval set's run, subject the set's name", () => {
    const result = validateEvent({ kind: "eval-run", provenance: { job: "evals" }, subject: "wall", data: { set: "wall", passed: 3, total: 3 }, text: "wall: 3 of 3 pass" });
    expect(result).toMatchObject({ ok: true, event: { kind: "eval-run", subject: "wall", text: "wall: 3 of 3 pass" } });
  });

  it("lists every kind once", () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });
});
