import { describe, expect, it } from "vitest";
import {
  DELEGATE_ONLY_KINDS,
  EVENT_KINDS,
  HANDOFF_TRANSITIONS,
  JARVIS_EVENT_ONLY_KINDS,
  JOB_KINDS_WITH_DURATION,
  PART_ROW_DATA_MAX_BYTES,
  PART_ROW_TEXT_MAX_BYTES,
  RECORD_ONLY_KINDS,
  registryDiffOf,
  REPEATS_BY_DATA_ID,
  STANDING_RULING_ONLY_KINDS,
  SUBJECT_REQUIRED,
  THREAD_REPLY_KINDS,
  TODO_STATES,
  TOM_ONLY_KINDS,
  isRulingScope,
  validateEvent,
} from "../jarvis-events.mjs";

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

  it("keeps thread events in their route-only lists", () => {
    expect(TOM_ONLY_KINDS).toContain("thread-message");
    expect(TOM_ONLY_KINDS).toContain("explanation-confirmed");
    expect(RECORD_ONLY_KINDS).toContain("thread-digest");
    expect(SUBJECT_REQUIRED).toContain("thread-reply");
    expect(RECORD_ONLY_KINDS).toContain("silence-alarm");
    expect(SUBJECT_REQUIRED).toContain("needs-you-opened");
    expect(validateEvent({ kind: "needs-you-opened", data: { key: "k" }, text: "No subject." }))
      .toEqual({ ok: false, error: "a needs-you-opened event names its subject" });
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

/** A complete registry row: every field Jarvis scripts/check-parts.mjs requires. */
const row = (id, extra = {}) => ({
  id,
  name: id,
  type: "program",
  file: `worker/jobs/${id}.mjs`,
  starts: [],
  reads: ["record"],
  writes: ["record"],
  refuses: [],
  routes: ["/jarvis/event"],
  schedule: id,
  fate: { type: "kept", by: null },
  serves: [{ guarantee: "G4" }],
  designed_by: "outcomes",
  note: `The ${id} part.`,
  ...extra,
});

describe("the design page's events", () => {
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

  it("refuses a registry row missing any field the registry check requires", () => {
    for (const field of ["name", "file", "starts", "reads", "writes", "refuses", "routes", "schedule", "serves", "designed_by", "note"]) {
      const partial = row("x");
      delete partial[field];
      expect(validateEvent(registry({ parts: [partial], count: 1 })).error, field).toContain("row x");
    }
    expect(validateEvent(registry({ parts: [row("x", { fate: { type: "kept", by: 3 } })], count: 1 })).error).toContain("fate.by");
    expect(validateEvent(registry({ parts: [row("x", { file: null, schedule: null })], count: 1 })).ok).toBe(true);
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
  const diff = { base: "abcdef0", added: ["new-part"], changed: ["deploy"], removed: ["sweep"], rows: { deploy: row("deploy", { note: "changed" }), "new-part": row("new-part") } };

  it("takes a diff with a complete row for each added and changed id", () => {
    expect(registryDiffOf(diff)).toEqual(diff);
    expect(registryDiffOf({ base: "abcdef0", added: [], changed: [], removed: ["sweep"], rows: {} })).toEqual({ base: "abcdef0", added: [], changed: [], removed: ["sweep"], rows: {} });
  });

  it("refuses a diff missing the row of an added or changed id", () => {
    expect(registryDiffOf({ ...diff, rows: { deploy: diff.rows.deploy } })).toBeNull();
    expect(registryDiffOf({ ...diff, rows: { "new-part": diff.rows["new-part"] } })).toBeNull();
  });

  it("refuses a row holding only its id, or failing the registry row check", () => {
    expect(registryDiffOf({ ...diff, rows: { ...diff.rows, deploy: { id: "deploy" } } })).toBeNull();
    expect(registryDiffOf({ ...diff, rows: { ...diff.rows, deploy: row("deploy", { type: "kind" }) } })).toBeNull();
    expect(registryDiffOf({ ...diff, rows: { ...diff.rows, deploy: row("other") } })).toBeNull();
  });

  it("refuses a row for an id neither added nor changed, and a malformed list or base", () => {
    expect(registryDiffOf({ ...diff, rows: { ...diff.rows, sweep: row("sweep") } })).toBeNull();
    expect(registryDiffOf({ ...diff, base: "" })).toBeNull();
    expect(registryDiffOf({ ...diff, added: ["Not An Id"] })).toBeNull();
    expect(registryDiffOf("a diff")).toBeNull();
  });
});

// The rows a session writes while it builds a todo (convex/jarvis/build.ts).
describe("the build rows: todo-state and handoff", () => {
  const TODO = "k57todo";
  const state = (data, extra = {}) =>
    validateEvent({ kind: "todo-state", subject: TODO, data: { from: "waiting", by: "claude:box:s1", ...data }, text: `todo ${TODO} is ${data.state}`, ...extra });
  const order = {
    todo: [{ id: TODO, statement: "refuse a whitespace-only statement" }],
    design: "every door that stores a statement refuses a whitespace-only one",
    checks: [{ type: "mechanical", command: "pnpm vitest run convex/tts.test.ts", expected: "exit 0" }],
    decisions: { sentences: ["go"], answered: [] },
    outOfScope: ["the Jarvis guard"],
    walls: [],
    agents: { tasks: [{ n: 1, name: "refusals and tests", role: "worker", check: "the vitest command exits 0" }] },
    builder: "session",
  };
  const base = { sentences: [{ at: 1, text: "design the refusals" }], state: "explored", next: "design", pointers: {} };
  const handoff = (transition, data = {}, extra = {}) =>
    validateEvent({ kind: "handoff", subject: TODO, data: { transition, ...base, ...data }, text: `${transition} on todo ${TODO}`, ...extra });

  it("both are kinds, each refused without its todo as subject", () => {
    for (const kind of ["todo-state", "handoff"]) {
      expect(EVENT_KINDS).toContain(kind);
      expect(SUBJECT_REQUIRED).toContain(kind);
    }
    expect(state({ state: "in session" }, { subject: undefined })).toEqual({ ok: false, error: "a todo-state event names its subject" });
    expect(handoff("exploration to design", {}, { subject: undefined })).toEqual({ ok: false, error: "a handoff event names its subject" });
  });

  it("takes a todo-state in each of the seven states with its fields", () => {
    expect(TODO_STATES).toEqual(["waiting", "in session", "ordered", "building", "returned", "done", "archived"]);
    const fields = {
      ordered: { orderRowId: "e1", builder: "orchestrator" },
      building: { orderRowId: "e1", builder: "session" },
      returned: { mergeRowId: "e2", pullRequest: { repo: "tom.quest", number: 350 } },
      done: { sentence: "done" },
    };
    for (const s of TODO_STATES) expect(state({ state: s, ...fields[s] }).ok).toBe(true);
  });

  it("refuses a todo-state whose state or from is off the list, or with no mover or text", () => {
    expect(state({ state: "reviewing" }).error).toBe(`a todo-state names data.state as one of ${TODO_STATES.join(", ")}`);
    expect(state({ state: "in session", from: "started" }).error).toContain("data.from");
    expect(state({ state: "in session", by: " " }).error).toContain("data.by");
    expect(state({ state: "in session" }, { text: undefined }).error).toBe("a todo-state names its one-line text");
    expect(validateEvent({ kind: "todo-state", subject: TODO, text: "x" }).ok).toBe(false);
  });

  it("refuses a todo-state missing the fields its state needs", () => {
    expect(state({ state: "building", builder: "session" }).error).toContain("data.orderRowId");
    expect(state({ state: "ordered", orderRowId: "e1", builder: "worker" }).error).toContain("data.builder");
    expect(state({ state: "returned", mergeRowId: "e2" }).error).toContain("data.pullRequest");
    expect(state({ state: "returned", mergeRowId: "e2", pullRequest: { repo: "tom.quest", number: 0 } }).ok).toBe(false);
    expect(state({ state: "done" }).error).toContain("data.sentence");
    // A return sent back to the session carries his sentence too.
    expect(state({ state: "in session", from: "returned" }).error).toContain("data.sentence");
    expect(state({ state: "in session", from: "returned", sentence: "the empty-line case still passes" }).ok).toBe(true);
  });

  it("takes a handoff at each transition with the fields it needs", () => {
    expect(HANDOFF_TRANSITIONS).toEqual(["exploration to design", "design to build", "build to review", "review to landing", "landing to return", "leaving"]);
    const fields = {
      "design to build": { order },
      "review to landing": { gate: { testsRunRowId: "e3", auditVerdictRowId: "e4" } },
      "landing to return": { mergeRowId: "e5", commit: "abc1234" },
      leaving: { unblock: ["the OpenRouter key"] },
    };
    for (const t of HANDOFF_TRANSITIONS) expect(handoff(t, { previous: "e0", ...fields[t] })).toMatchObject({ ok: true });
  });

  it("refuses a handoff without a transition on the list", () => {
    expect(validateEvent({ kind: "handoff", subject: TODO, data: base, text: "x" }).error).toBe(
      `a handoff names data.transition as one of ${HANDOFF_TRANSITIONS.join(", ")}`,
    );
    expect(handoff("design to review").ok).toBe(false);
  });

  it("refuses a handoff missing its sentences, state, next step, pointers or text", () => {
    expect(handoff("exploration to design", { sentences: [{ text: "no time" }] }).error).toContain("data.sentences");
    expect(handoff("exploration to design", { sentences: "go" }).error).toContain("data.sentences");
    expect(handoff("exploration to design", { state: "" }).error).toContain("data.state");
    expect(handoff("exploration to design", { next: undefined }).error).toContain("data.next");
    expect(handoff("exploration to design", { pointers: [] }).error).toContain("data.pointers");
    expect(handoff("exploration to design", { previous: "" }).error).toContain("data.previous");
    expect(handoff("exploration to design", {}, { text: " " }).error).toBe("a handoff names its one-line text");
    expect(handoff("exploration to design", { sentences: [] }).ok).toBe(true);
  });

  it("takes complete pointers, and refuses a pointer of the wrong type or a field the contract does not name", () => {
    const complete = {
      rows: ["e1", "e2"],
      agents: [{ id: "codex:box:run-1", knows: "the diff of task 1 and why each hunk" }],
      files: ["convex/tts.ts", "convex/tts.test.ts"],
      branch: "session/w577k3ah",
      head: "9666e0f1da5c5bd47dc36224b497b8ab493c52b0",
      pullRequest: { repo: "tom.quest", number: 350 },
    };
    expect(handoff("build to review", { pointers: complete })).toMatchObject({ ok: true, event: { data: { pointers: complete } } });
    const pointers = (value) => handoff("build to review", { pointers: value }).error;
    expect(pointers({ rows: 7 })).toBe("a handoff names data.pointers.rows, when it exists, as a list of event ids");
    expect(pointers({ rows: ["e1", ""] })).toContain("data.pointers.rows");
    expect(pointers({ branch: 5 })).toBe("a handoff names data.pointers.branch, when it exists, as a branch name");
    expect(pointers({ branch: null })).toContain("data.pointers.branch");
    expect(pointers({ head: "" })).toContain("data.pointers.head");
    expect(pointers({ agents: ["codex:box:run-1"] })).toContain("data.pointers.agents");
    expect(pointers({ files: "convex/tts.ts" })).toContain("data.pointers.files");
    expect(pointers({ pullRequest: { repo: "tom.quest" } })).toContain("data.pointers.pullRequest");
    expect(pointers({ ...complete, worktree: "/tmp/x" })).toBe(
      "a handoff's data.pointers holds only rows, agents, files, branch, head, pullRequest; worktree is not one",
    );
  });

  it("refuses a design to build handoff whose work order lacks a part or a builder", () => {
    expect(handoff("design to build").error).toBe("a design to build handoff names data.order, the work order");
    const without = (part, value) => handoff("design to build", { order: { ...order, [part]: value } }).error;
    expect(without("todo", [])).toContain("order.todo");
    expect(without("design", undefined)).toContain("order.design");
    expect(without("checks", [{ type: "eyeballed" }])).toContain("order.checks");
    expect(without("decisions", { sentences: ["go"] })).toContain("order.decisions");
    expect(without("outOfScope", undefined)).toContain("order.outOfScope");
    expect(without("walls", undefined)).toContain("order.walls");
    expect(without("agents", { tasks: [{ name: "no check" }] })).toContain("order.agents.tasks");
    expect(without("builder", "worker")).toContain("order.builder");
  });

  it("refuses the other transitions without their fields", () => {
    expect(handoff("review to landing", { gate: { testsRunRowId: "e3" } }).error).toContain("data.gate");
    expect(handoff("landing to return", { mergeRowId: "e5" }).error).toContain("data.commit");
    expect(handoff("leaving").error).toContain("data.unblock");
  });

  it("refuses a todo-state whose data passes 8 KiB, and a build row whose text passes 2,048 bytes", () => {
    expect(state({ state: "done", sentence: "x".repeat(8 * 1024) }).error).toBe("a todo-state's data is at most 8192 bytes");
    expect(state({ state: "done", sentence: "x".repeat(7 * 1024) }).ok).toBe(true);
    expect(state({ state: "in session" }, { text: "x".repeat(2049) }).error).toBe("a todo-state's text is at most 2048 bytes");
    expect(state({ state: "in session" }, { text: "é".repeat(1025) }).ok).toBe(false);
    expect(state({ state: "in session" }, { text: "x".repeat(2048) }).ok).toBe(true);
    expect(handoff("exploration to design", {}, { text: "x".repeat(2049) }).error).toBe("a handoff's text is at most 2048 bytes");
  });

  it("refuses a handoff whose data passes 64 KiB", () => {
    const long = "x".repeat(64 * 1024);
    expect(handoff("exploration to design", { state: long }).error).toContain("at most 65536 bytes");
    expect(handoff("exploration to design", { state: "x".repeat(60 * 1024) }).ok).toBe(true);
  });
});

describe("use, issue and presence rows", () => {
  // The rows Jarvis worker/jobs/thread-reply.mjs posts (Jarvis #247), byte for byte.
  const prov = { job: "thread-reply" };
  const said = "the digest works.";

  it("takes the box's no-issues use row and stores it as Tom's, with what from the text", () => {
    const body = { kind: "use", provenance: prov, subject: "write-slack", data: { part: "write-slack", state: "working", threadMessageId: "m1" }, text: said };
    expect(validateEvent(body, { now: 1000 })).toEqual({
      ok: true,
      event: {
        kind: "use", at: 1000, provenance: prov, subject: "write-slack", text: said,
        data: { part: "write-slack", state: "working", threadMessageId: "m1", by: "tom", what: said },
      },
    });
  });

  it("takes the box's issue row with a part and with none", () => {
    const named = validateEvent({ kind: "issue", provenance: prov, subject: "digest", data: { part: "digest", threadMessageId: "m2" }, text: "the digest is broken" });
    expect(named).toMatchObject({ ok: true, event: { subject: "digest", data: { part: "digest", threadMessageId: "m2", by: "tom" } } });
    const none = validateEvent({ kind: "issue", provenance: prov, data: { part: null, threadMessageId: "m3" }, text: "something is off" });
    expect(none).toMatchObject({ ok: true, event: { data: { part: null, by: "tom" } } });
    expect(none.event).not.toHaveProperty("subject");
  });

  it("takes the box's presence rows", () => {
    for (const away of [true, false]) {
      expect(validateEvent({ kind: "presence", provenance: prov, subject: "tom", data: { away, threadMessageId: "m4" }, text: "im back" }).ok).toBe(true);
    }
  });

  it("says who a row is by when the writer did not", () => {
    const use = (provenance, data = {}) => validateEvent({ kind: "use", provenance, subject: "p", data: { part: "p", what: "ran", ...data } }).event.data.by;
    expect(use({ job: "deploy" })).toBe("job");
    expect(use({ agentId: "codex:box:1" })).toBe("agent");
    expect(use({ session: "s1" })).toBe("agent");
    expect(use({ user: "tom" })).toBe("tom");
    expect(use({ job: "deploy" }, { by: "agent" })).toBe("agent");
  });

  it("dates a resolving issue row by the record, and refuses a backdated or future time from the writer", () => {
    const now = 1_700_000_000_000;
    const issue = { kind: "issue", subject: "deploy", data: { part: "deploy", resolvedBy: "landing-row" }, text: "fixed by #250" };
    expect(validateEvent(issue, { now })).toMatchObject({ ok: true, event: { at: now, data: { resolvedAt: now, resolvedBy: "landing-row" } } });
    const fromWriter = "an issue event's data.resolvedAt is set by the record to the row's own time";
    expect(validateEvent({ ...issue, data: { ...issue.data, resolvedAt: now - 86_400_000 } }, { now }).error).toBe(fromWriter);
    expect(validateEvent({ ...issue, data: { ...issue.data, resolvedAt: now + 86_400_000 } }, { now }).error).toBe(fromWriter);
    const ownAt = "an issue event that resolves is dated by the record's clock, within 5 minutes";
    expect(validateEvent({ ...issue, at: now - 86_400_000 }, { now }).error).toBe(ownAt);
    expect(validateEvent({ ...issue, at: now - 6 * 60_000 }, { now }).error).toBe(ownAt);
    // The stored row validates again unchanged: the record's insert re-checks what the route checked.
    const stored = validateEvent(issue, { now }).event;
    expect(validateEvent(stored, { now: now + 50 })).toEqual({ ok: true, event: stored });
    expect(validateEvent({ kind: "issue", subject: "deploy", data: { part: "deploy", resolvedAt: now }, text: "t" }, { now }).error).toBe("an issue event names data.resolvedAt only with data.resolvedBy");
    expect(validateEvent({ ...issue, data: { part: "deploy", resolvedBy: "" } }, { now }).error).toBe("an issue event's data.resolvedBy is a landing row id or a thread message id");
    expect(validateEvent({ kind: "issue", data: { part: null, resolvedBy: "x" }, text: "t" }, { now }).error).toBe("an issue event that resolves names its part");
    // An issue that resolves nothing keeps the writer's at.
    expect(validateEvent({ kind: "issue", subject: "deploy", at: now - 1000, data: { part: "deploy" }, text: "t" }, { now }).event.at).toBe(now - 1000);
  });

  it("keeps data.what to one line: refuses a newline or other control character, and takes the first line of text", () => {
    const use = (what) => validateEvent({ kind: "use", subject: "p", data: { part: "p", what } });
    const oneLine = "a use event's data.what is one line, with no newline or other control character";
    expect(use("ran\nand more").error).toBe(oneLine);
    expect(use("ran\r").error).toBe(oneLine);
    expect(use("ran\tthere").error).toBe(oneLine);
    expect(use("ran there").ok).toBe(true);
    const fromText = validateEvent({ kind: "use", subject: "p", data: { part: "p" }, text: "first\tline\r\nsecond" });
    expect(fromText.event.data.what).toBe("first line");
  });

  it("refuses a use or issue row that names its part wrongly or lacks its words", () => {
    const cases = [
      [{ kind: "use", data: { part: "p", what: "x" } }, "a use event names its subject"],
      [{ kind: "use", subject: "q", data: { part: "p", what: "x" } }, "a use event names data.part as its subject"],
      [{ kind: "use", subject: "p", data: { part: "", what: "x" } }, "a use event names data.part as a part id"],
      [{ kind: "use", subject: "p", data: null }, "a use event names data as an object"],
      [{ kind: "use", subject: "p", data: { part: "p" } }, "a use event names data.what or its text"],
      [{ kind: "use", subject: "p", data: { part: "p", what: "x", state: "broken" } }, 'a use event\'s data.state, when given, is "working"'],
      [{ kind: "use", subject: "p", data: { part: "p", what: "x", by: "someone" } }, "a use event names data.by as one of tom, agent, job"],
      [{ kind: "use", subject: "p", data: { part: "p", what: "x", threadMessageId: "" } }, "a use event's data.threadMessageId, when given, is a non-empty string"],
      [{ kind: "issue", subject: "p", data: { part: "p" } }, "an issue event names its text"],
      [{ kind: "issue", subject: "p", data: { part: null }, text: "t" }, "an issue event with data.part null names no subject"],
      [{ kind: "issue", subject: "p", data: {}, text: "t" }, "an issue event names data.part as a part id"],
      [{ kind: "presence", subject: "someone", data: { away: true } }, 'a presence event names "tom" as its subject'],
      [{ kind: "presence", subject: "tom", data: { away: "yes" } }, "a presence event names data.away as a boolean"],
    ];
    for (const [candidate, error] of cases) expect(validateEvent(candidate)).toEqual({ ok: false, error });
  });

  it("refuses a use or issue row whose text or data is over its stated size, and takes any message Tom can send", () => {
    const issue = { kind: "issue", subject: "deploy", data: { part: "deploy" } };
    // A thread message is at most 4,000 characters; at 3 bytes each that is 12,000 bytes.
    expect(validateEvent({ ...issue, text: "中".repeat(4000) }).ok).toBe(true);
    expect(validateEvent({ ...issue, text: "x".repeat(PART_ROW_TEXT_MAX_BYTES + 1) }).error).toBe(`an issue event's text is over ${PART_ROW_TEXT_MAX_BYTES} bytes`);
    expect(validateEvent({ kind: "use", subject: "deploy", data: { part: "deploy", what: "ran" }, text: "x".repeat(PART_ROW_TEXT_MAX_BYTES + 1) }).error).toBe(`a use event's text is over ${PART_ROW_TEXT_MAX_BYTES} bytes`);
    const padded = { part: "deploy", what: "ran", note: "x".repeat(PART_ROW_DATA_MAX_BYTES) };
    expect(validateEvent({ kind: "use", subject: "deploy", data: padded }).error).toBe(`a use event's data is over ${PART_ROW_DATA_MAX_BYTES} bytes as stored`);
    expect(validateEvent({ ...issue, data: { ...padded, what: undefined }, text: "t" }).error).toBe(`an issue event's data is over ${PART_ROW_DATA_MAX_BYTES} bytes as stored`);
    // Under the cap as posted, over it once by and what are filled in: refused.
    const base = { part: "deploy", note: "" };
    const room = PART_ROW_DATA_MAX_BYTES - JSON.stringify(base).length - 5;
    const near = { part: "deploy", note: "x".repeat(room) };
    expect(JSON.stringify(near).length).toBeLessThan(PART_ROW_DATA_MAX_BYTES);
    expect(validateEvent({ kind: "use", subject: "deploy", data: near, text: "ran" }).error).toBe(`a use event's data is over ${PART_ROW_DATA_MAX_BYTES} bytes as stored`);
    // The same for a resolution, whose resolvedAt the record fills in.
    const resolving = { part: "deploy", by: "job", resolvedBy: "L1", note: "" };
    const nearResolving = { ...resolving, note: "x".repeat(PART_ROW_DATA_MAX_BYTES - JSON.stringify(resolving).length - 5) };
    expect(JSON.stringify(nearResolving).length).toBeLessThan(PART_ROW_DATA_MAX_BYTES);
    expect(validateEvent({ kind: "issue", subject: "deploy", data: nearResolving, text: "fixed" }).error).toBe(`an issue event's data is over ${PART_ROW_DATA_MAX_BYTES} bytes as stored`);
    expect(PART_ROW_TEXT_MAX_BYTES).toBe(16_000);
    expect(PART_ROW_DATA_MAX_BYTES).toBe(8 * 1024);
  });

  it("keeps the three kinds writable by the box, and the four reply kinds on the list", () => {
    for (const kind of ["use", "issue", "presence"]) {
      expect(EVENT_KINDS).toContain(kind);
      expect(TOM_ONLY_KINDS).not.toContain(kind);
      expect(DELEGATE_ONLY_KINDS).not.toContain(kind);
      expect(REPEATS_BY_DATA_ID).toContain(kind);
      expect(JARVIS_EVENT_ONLY_KINDS).toContain(kind);
    }
    expect(THREAD_REPLY_KINDS).toEqual(["fact", "todo", "rule", "errand", "question", "issue", "no-issues", "leaving", "back", "answer"]);
    expect(validateEvent({ kind: "thread-reply", subject: "m1", data: { kind: "no-issues" }, text: "working, written as a use row on digest: event e1" }).ok).toBe(true);
  });
});

describe("a ruling event", () => {
  const ruling = (data = {}, extra = {}) => ({
    kind: "ruling",
    subject: "repo:Jarvis",
    data: {
      id: `ruling:${"0f".repeat(32)}`,
      sentence: "if I say it is good once then that holds",
      scope: "repo:Jarvis",
      question: "May the merge gate's audit run on Codex?",
      provenance: { threadMessageId: "k17abc" },
      standing: true,
      ...data,
    },
    ...extra,
  });

  it("takes his sentence, its scope as its subject, the question and one provenance", () => {
    expect(validateEvent(ruling(), { now: 1000 }).ok).toBe(true);
    expect(validateEvent(ruling({ provenance: { session: "aaa9ae16" } })).ok).toBe(true);
    expect(validateEvent(ruling({ scope: "all" }, { subject: "all" })).ok).toBe(true);
    expect(EVENT_KINDS).toContain("ruling");
    expect(SUBJECT_REQUIRED).toContain("ruling");
    expect(STANDING_RULING_ONLY_KINDS).toEqual(["ruling"]);
  });

  it("refuses a missing sentence or question, a subject other than the scope, and a scope off the four forms", () => {
    expect(validateEvent(ruling({ sentence: " " })).error).toContain("data.sentence");
    expect(validateEvent(ruling({ question: undefined })).error).toContain("data.question");
    expect(validateEvent(ruling({}, { subject: "repo:WikiTom" })).error).toContain("as its subject");
    expect(validateEvent(ruling({ scope: "repo:Elsewhere" }, { subject: "repo:Elsewhere" })).error).toContain("data.scope");
    expect(validateEvent(ruling({}, { subject: undefined })).error).toContain("names its subject");
  });

  it("refuses a provenance naming both sources, neither, or another field", () => {
    expect(validateEvent(ruling({ provenance: { session: "a", threadMessageId: "b" } })).error).toContain("data.provenance");
    expect(validateEvent(ruling({ provenance: {} })).error).toContain("data.provenance");
    expect(validateEvent(ruling({ provenance: { agentId: "x" } })).error).toContain("data.provenance");
    expect(validateEvent(ruling({ provenance: { session: "" } })).error).toContain("data.provenance");
  });

  it("takes a sentence typed on the design page, and no other page", () => {
    expect(validateEvent(ruling({ provenance: { page: "design" } })).ok).toBe(true);
    expect(validateEvent(ruling({ provenance: { page: "thread" } })).error).toContain("data.provenance");
    expect(validateEvent(ruling({ provenance: { page: "design", session: "a" } })).error).toContain("data.provenance");
  });

  it("names the key a retry is matched on", () => {
    expect(validateEvent(ruling({ id: undefined })).error).toContain("data.id");
    expect(validateEvent(ruling({ id: "thread:k17abc" })).error).toContain("data.id");
    expect(validateEvent(ruling({ id: "ruling:thread:k17abc:repo:Jarvis:0f" })).error).toContain("data.id");
  });

  it("is written standing, never already superseded", () => {
    expect(validateEvent(ruling({ standing: false })).error).toContain("data.standing");
    expect(validateEvent(ruling({ supersededBy: "k17def" })).error).toContain("data.supersededBy");
  });
});

describe("isRulingScope", () => {
  it("takes all, a part id, a change class and a SESSION_REPOS repository", () => {
    for (const scope of ["all", "part:delegate", "part:thread-reply", "class:mockup", "repo:tom.quest", "repo:Jarvis", "repo:WikiTom"]) {
      expect(isRulingScope(scope)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const scope of ["", "All", "part:", "part:Delegate", "part:a--b", "class:small change", "repo:jarvis", "repo:", "todo:abc", "delegate", 3, null]) {
      expect(isRulingScope(scope)).toBe(false);
    }
  });
});

describe("an explanation-confirmed event", () => {
  const confirmed = (data = {}, extra = {}) => ({ kind: "explanation-confirmed", subject: "idle", provenance: { user: "tom" }, data: { part: "idle", explanationId: "x1", id: "confirm:x1", ...data }, ...extra });
  it("names the part as its subject, the explanation, and the key a second press is matched on", () => {
    expect(validateEvent(confirmed()).ok).toBe(true);
    expect(validateEvent(confirmed({ part: "other" })).error).toContain("data.part as its subject");
    expect(validateEvent(confirmed({ explanationId: "" })).error).toContain("data.explanationId");
    expect(validateEvent(confirmed({ id: "confirm:x2" })).error).toContain("confirm:<explanationId>");
    expect(validateEvent(confirmed({}, { subject: undefined })).error).toContain("names its subject");
  });
});
