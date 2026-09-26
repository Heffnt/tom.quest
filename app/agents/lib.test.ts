// The two readers the runs page added with the lifeos update (phase 7),
// both of which read something ANOTHER file wrote and could drift from it
// silently.
//
//   modelOfTomHeadOf reads back the header convex/ttsSkills.ts writes at the
//   head of every session opener — the WikiTom commit the model-of-tom files
//   were read at, and its canonical selected layers. It is pinned against the
//   exact stored all-layer header so a transcript cannot silently lose that
//   context when the publication format changes.
//
//   describeOverflow says how much of a cut payload came back and whether it
//   can be trusted. Its claims are deliberately different strengths — verified
//   against the hash, summed across pages, and the two ways a payload comes
//   back wrong — and the wrong one is a lie about completeness, the exact
//   thing the overflow path exists to prevent.

import { describe, expect, it } from "vitest";
import {
  boxChangeText,
  childRunOf,
  contextFactsOf,
  costText,
  describeOverflow,
  durationText,
  errorTextOf,
  modelOfTomHeadOf,
  orderSessions,
  persistedOutputOf,
  placeBoxChanges,
  runsSudoCommand,
  shellCommandOf,
  runStatusChipClass,
  thinkingTextOf,
  toolInputObjectOf,
} from "./lib";

// Both rows are the parser's own output: the first is a production row's
// content verbatim, the second what worker/agents/ingest.mjs made of a real
// Claude `system/api_error` line (request id replaced).
describe("errorTextOf", () => {
  it("reads the parser's string error", () => {
    expect(errorTextOf({ error: "model changed from gpt-5.6-sol to gpt-5.6-terra" })).toBe(
      "model changed from gpt-5.6-sol to gpt-5.6-terra",
    );
  });

  it("reads the one-line reading off an api_error's error object", () => {
    const content = {
      error: {
        message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_fixture"}',
        status: 529,
        requestId: "req_fixture",
        formatted: "529 Overloaded",
        connection: null,
        isNetworkDown: false,
        rateLimits: null,
        noResponse: null,
      },
    };
    expect(errorTextOf(content)).toBe("529 Overloaded");
    expect(errorTextOf({ error: { ...content.error, formatted: undefined } })).toBe(
      content.error.message,
    );
  });
});

describe("modelOfTomHeadOf", () => {
  it("reads back the commit and canonical layers from the stored all-layer header", () => {
    const prompt = "MODEL-OF-TOM FILES (WikiTom commit 0123456789abcdef0123456789abcdef01234567): model-of-tom/agent-rules.md, model-of-tom/writing.md, model-of-tom/intent.md\n\noperate layer\n\nwrite layer\n\nknow layer";
    expect(modelOfTomHeadOf(prompt)).toEqual({
      commit: "0123456789abcdef0123456789abcdef01234567",
      paths: ["model-of-tom/agent-rules.md", "model-of-tom/writing.md", "model-of-tom/intent.md"],
    });
  });

  it("returns a null commit for a model-of-tom header without one", () => {
    expect(modelOfTomHeadOf("MODEL-OF-TOM FILES (not published yet): operate,write,know")).toEqual({
      commit: null,
      paths: ["operate", "write", "know"],
    });
  });

  it("is null for an ordinary prompt", () => {
    expect(modelOfTomHeadOf("Work the batch below with Tom.")).toBeNull();
    expect(modelOfTomHeadOf("")).toBeNull();
  });
});

describe("describeOverflow", () => {
  const base = { bytes: 0, byteLength: 100, end: false, complete: false, reads: 1, reading: false };

  it("says complete only when the server checked the hash", () => {
    expect(
      describeOverflow({ ...base, bytes: 100, end: true, complete: true }),
    ).toBe("complete — 100 bytes, checked against the stored hash");
  });

  // witness: let the paged case borrow the word "complete" alone — the page
  // would claim a verification that was never performed.
  it("says the bytes summed, and that the hash was not re-checked, across pages", () => {
    const said = describeOverflow({
      ...base,
      bytes: 100,
      end: true,
      reads: 3,
    });
    expect(said).toContain("complete — 100 bytes in 3 reads");
    expect(said).toContain("the hash is checked only when");
  });

  // witness: let the paged sentence answer for a single read too — a payload
  // whose stored hash did NOT match would be announced as complete, which is
  // the one thing this function exists to make impossible. The server computes
  // `complete` as the hash comparison itself and only ever on a whole read
  // from index 0, so complete:false here is a mismatch, not an unasked
  // question.
  it("says the bytes do not match the stored hash when one whole read fails the check", () => {
    expect(
      describeOverflow({
        ...base,
        bytes: 100,
        end: true,
        reads: 1,
        complete: false,
      }),
    ).toBe(
      "incomplete — 100 bytes came back but they do not match the stored hash",
    );
  });

  it("says incomplete, and why, when a chunk is missing", () => {
    expect(describeOverflow({ ...base, bytes: 40, end: false })).toBe(
      "incomplete — the stored chunks stop after 40 of 100 bytes; one is missing",
    );
  });

  it("says incomplete when the bytes do not sum to the row's stamp", () => {
    expect(describeOverflow({ ...base, bytes: 40, end: true })).toBe(
      "incomplete — 40 of 100 bytes came back",
    );
  });

  it("says what it has while a read is in flight", () => {
    expect(describeOverflow({ ...base, bytes: 40, reading: true })).toBe(
      "reading — 40 of 100 bytes so far",
    );
  });
});

// The run-row readers below all face the same hazard: a claudeMessages row is
// v.any() and now has THREE writers — the session daemon
// (worker/session-host/session.mjs), and the Claude and Codex parsers in
// worker/agents/ingest.mjs. A reader written against one writer's object reads
// the others' as nothing, silently, so each shape is pinned here against the
// line that writes it.

describe("thinkingTextOf", () => {
  // ingest.mjs:331 (Claude) and session.mjs:1366 (daemon) both write { text }.
  it("returns the Claude/daemon text complete", () => {
    const text = `line one\n${"x".repeat(4000)}\nline three`;
    expect(thinkingTextOf({ text })).toBe(text);
  });

  // ingest.mjs:450 writes the Codex reasoning summary as an array — of the
  // CLI's { type: "summary_text", text } blocks in a real rollout, of plain
  // strings in the parser's own fixture.
  it("returns a Codex summary complete, every part of it", () => {
    expect(
      thinkingTextOf({
        summary: [
          { type: "summary_text", text: "first thought" },
          { type: "summary_text", text: "second thought" },
        ],
      }),
    ).toBe("first thought\n\nsecond thought");
    expect(thinkingTextOf({ summary: ["only part"] })).toBe("only part");
  });

  it("says nothing rather than throwing on a shape it has never met", () => {
    expect(thinkingTextOf({ summary: [] })).toBe("");
    expect(thinkingTextOf(null)).toBe("");
    expect(thinkingTextOf("bare string")).toBe("bare string");
    expect(thinkingTextOf({ summary: [{ nope: 1 }] })).toBe('{"nope":1}');
  });
});

describe("toolInputObjectOf", () => {
  // ingest.mjs:334 (Claude) and session.mjs:1381 (daemon) store the input
  // object itself; the daemon spells the field the same way.
  it("passes a Claude/daemon input object through", () => {
    expect(toolInputObjectOf({ name: "Bash", input: { command: "ls" } })).toEqual({
      command: "ls",
    });
    expect(toolInputObjectOf({ toolName: "Bash", input: { command: "ls" } })).toEqual({
      command: "ls",
    });
  });

  // ingest.mjs:451 stores payload.arguments, which the CLI writes as a JSON
  // string.
  it("parses a Codex JSON-string input into its object", () => {
    expect(
      toolInputObjectOf({ name: "shell", input: '{"command":["ls","-la"]}' }),
    ).toEqual({ command: ["ls", "-la"] });
  });

  it("keeps a string input that is not an object", () => {
    expect(toolInputObjectOf({ name: "shell", input: "ls -la" })).toBe("ls -la");
    // Valid JSON, but a scalar: parsing it would hand the caller 42, not an
    // input it can render.
    expect(toolInputObjectOf({ name: "shell", input: "42" })).toBe("42");
  });

  // witness: JSON.parse without a guard — a payload cut mid-object
  // (cut.mjs TRUNCATE_LIMIT) would throw on the render pass, not on ingest.
  it("does not throw on a JSON string cut in half", () => {
    const cut = '{"command":["ls","-la"],"descrip';
    expect(() => toolInputObjectOf({ name: "shell", input: cut })).not.toThrow();
    expect(toolInputObjectOf({ name: "shell", input: cut })).toBe(cut);
  });
});

describe("childRunOf", () => {
  // ingest.mjs:309 writes the completed shape beside the Task tool-result.
  it("reads a completed child run's facts", () => {
    expect(
      childRunOf({
        childRunId: "claude:box:sess/agent-1",
        agentId: "agent-1",
        agentType: "Explore",
        description: "find the parsers",
        model: "claude-opus-4",
        status: "completed",
        totalTokens: 1234,
        totalDurationMs: 5000,
        totalToolUseCount: 7,
      }),
    ).toEqual({
      childRunId: "claude:box:sess/agent-1",
      agentId: "agent-1",
      agentType: "Explore",
      description: "find the parsers",
      model: "claude-opus-4",
      status: "completed",
      totalTokens: 1234,
      totalDurationMs: 5000,
      totalToolUseCount: 7,
    });
  });

  // The launched shape omits the totals entirely (ingest.mjs:309 spreads them
  // only when status === "completed"), and agentType is absent when neither
  // the result nor the Task input named one.
  it("leaves the unknown fields undefined on a launched child run", () => {
    expect(
      childRunOf({ childRunId: "claude:box:sess/agent-2", agentId: "agent-2", status: "launched" }),
    ).toEqual({
      childRunId: "claude:box:sess/agent-2",
      agentId: "agent-2",
      agentType: undefined,
      description: undefined,
      model: undefined,
      status: "launched",
      totalTokens: undefined,
      totalDurationMs: undefined,
      totalToolUseCount: undefined,
    });
  });

  it("is null for a row that does not name a child run", () => {
    expect(childRunOf({ toolUseId: "t1", content: "output" })).toBeNull();
    expect(childRunOf({ childRunId: "" })).toBeNull();
    expect(childRunOf(null)).toBeNull();
    expect(childRunOf("child run")).toBeNull();
  });
});

describe("contextFactsOf", () => {
  // ingest.mjs:380 (Claude) — claudeContext plus the model and the prompt.
  it("reads the Claude context row", () => {
    expect(
      contextFactsOf({
        model: "claude-opus-4",
        skillsOffered: ["graphify"],
        skillsUsed: ["graphify"],
        tools: ["Bash", "Read"],
        hooks: ["stop-hook"],
        cwd: "/root/tom.quest",
        prompt: "MODEL-OF-TOM FILES…",
      }),
    ).toEqual({
      model: "claude-opus-4",
      host: undefined,
      cwd: "/root/tom.quest",
      skillsUsed: ["graphify"],
      tools: ["Bash", "Read"],
      hooks: ["stop-hook"],
      prompt: "MODEL-OF-TOM FILES…",
    });
  });

  // ingest.mjs:488-489 (Codex) — skillsUsed and hooks are always empty there.
  it("reads the Codex context row", () => {
    const facts = contextFactsOf({
      model: "gpt-5.6-sol",
      skillsOffered: [],
      skillsUsed: [],
      tools: ["shell"],
      hooks: [],
      cwd: "/root/ComplexMultiTrigger",
      permissionMode: "approval=never; sandbox=danger-full-access",
      prompt: "work the batch",
    });
    expect(facts.model).toBe("gpt-5.6-sol");
    expect(facts.tools).toEqual(["shell"]);
    expect(facts.skillsUsed).toEqual([]);
  });

  it("falls back to modelRequested, the way the transcript row already does", () => {
    expect(contextFactsOf({ modelRequested: "opus" }).model).toBe("opus");
  });

  it("says nothing is known when the row names nothing", () => {
    expect(contextFactsOf({})).toEqual({
      model: undefined,
      host: undefined,
      cwd: undefined,
      skillsUsed: [],
      tools: [],
      hooks: [],
      prompt: "",
    });
    expect(contextFactsOf(null).skillsUsed).toEqual([]);
    expect(contextFactsOf("context").tools).toEqual([]);
  });

  it("drops a name that is not a string", () => {
    expect(contextFactsOf({ tools: ["Bash", 7, null, { name: "Read" }] }).tools).toEqual(["Bash"]);
  });
});

describe("persistedOutputOf", () => {
  // ingest.mjs:303 hangs the pointer off the tool-result body.
  it("reads the pointer off a Claude tool-result row", () => {
    expect(
      persistedOutputOf({
        toolUseId: "t1",
        content: "<persisted-output>…",
        isError: false,
        persistedOutput: { path: "/root/.claude/tool-results/t1.txt", sizeText: "1.2MB" },
      }),
      // The size is the marker's own words, quoted — never reinterpreted as a
      // byte count nobody measured.
    ).toEqual({ path: "/root/.claude/tool-results/t1.txt", sizeText: "1.2MB" });
  });

  it("is null for a tool result that has none", () => {
    expect(persistedOutputOf({ toolUseId: "t1", content: "ok" })).toBeNull();
    expect(persistedOutputOf({ persistedOutput: null })).toBeNull();
    expect(persistedOutputOf({ persistedOutput: {} })).toBeNull();
    expect(persistedOutputOf("ok")).toBeNull();
    expect(persistedOutputOf(null)).toBeNull();
  });
});

describe("durationText", () => {
  it("reads under a second in whole milliseconds", () => {
    expect(durationText(340)).toBe("340ms");
    expect(durationText(0)).toBe("0ms");
  });

  it("reads under a minute to one decimal", () => {
    expect(durationText(1200)).toBe("1.2s");
    expect(durationText(59_000)).toBe("59.0s");
  });

  it("reads a minute and over as minutes and padded seconds", () => {
    expect(durationText(124_000)).toBe("2m 04s");
    expect(durationText(60_000)).toBe("1m 00s");
  });

  // witness: render a missing duration as 0ms — the page would state a
  // measurement nobody took.
  it("says nothing for a duration that is not one", () => {
    expect(durationText(-1)).toBe("");
    expect(durationText(Number.NaN)).toBe("");
    expect(durationText(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("runStatusChipClass", () => {
  it("uses the session chip's own tokens, and no new colour", () => {
    expect(runStatusChipClass("running")).toBe("border-accent/60 text-accent");
    expect(runStatusChipClass("ended")).toBe("border-border text-text");
    expect(runStatusChipClass("failed")).toBe("border-error/60 text-error");
    expect(runStatusChipClass("abandoned")).toBe("border-border text-text-muted");
    expect(runStatusChipClass("unknown")).toBe("border-border text-text-muted");
    // A status the union grows later is muted, never unstyled.
    expect(runStatusChipClass("something-new")).toBe("border-border text-text-muted");
  });
});

describe("costText", () => {
  it("prints a priced run in dollars and cents", () => {
    expect(costText(0.42)).toBe("$0.42");
    expect(costText(12.5)).toBe("$12.50");
  });

  // witness: read absent as zero. costUsd is omitted when prices.mjs does not
  // price the model (ingest.mjs:402, 506), so "$0.00" there would be the page
  // claiming the run was free — a different answer from a run that cost zero.
  it("says nothing when the model is not in the price table", () => {
    expect(costText(undefined)).toBe("");
    expect(costText(0)).toBe("$0.00");
    expect(costText(undefined)).not.toBe(costText(0));
  });
});

describe("orderSessions", () => {
  const row = (status: string, statusChangedAt: number, createdAt: number) =>
    ({ status, statusChangedAt, createdAt }) as {
      status: "running" | "starting" | "requested" | "idle" | "ended" | "failed";
      statusChangedAt: number;
      createdAt: number;
    };

  it("puts the triage bands in order: running, spinning up, idle, over", () => {
    // The two terminal rows share a createdAt so the band test reads bands
    // only; their newest-first order is the test below.
    const ordered = orderSessions([
      row("ended", 1, 1),
      row("idle", 2, 2),
      row("requested", 3, 3),
      row("running", 4, 4),
      row("starting", 5, 5),
      row("failed", 6, 1),
    ]);
    expect(ordered.map((s) => s.status)).toEqual([
      "running",
      "requested",
      "starting",
      "idle",
      "ended",
      "failed",
    ]);
  });

  it("reads the terminal band newest first", () => {
    const ordered = orderSessions([
      row("ended", 10, 100),
      row("failed", 10, 300),
      row("ended", 10, 200),
    ]);
    expect(ordered.map((s) => s.createdAt)).toEqual([300, 200, 100]);
  });

  it("keeps the caller's own order inside a live band, and its array untouched", () => {
    const input = [row("running", 1, 300), row("running", 2, 100), row("idle", 3, 200)];
    const ordered = orderSessions(input);
    expect(ordered.map((s) => s.createdAt)).toEqual([300, 100, 200]);
    expect(input.map((s) => s.status)).toEqual(["running", "running", "idle"]);
    expect(ordered).not.toBe(input);
  });
});

// The box-change rows' placement in an agent's chat (plan-root T1) reads the
// command the box's journal logged against the command the agent's tool call
// ran. sudo logs the program by its full path and the arguments without the
// shell's quotes, so the match is the box reader's own (Jarvis box-change.mjs
// commandLineTime), and a line that merely mentions the program is not a run.
describe("box changes among an agent's rows", () => {
  const T = Date.UTC(2026, 8, 25, 5, 8, 34);
  const call = (id: string, at: number, command: string) =>
    ({ _id: id, kind: "tool-call", createdAt: at, seq: 1, content: { toolName: "Bash", input: { command } } }) as never;
  const change = (id: string, at: number, command: string, count?: number) => ({
    id, at, source: "sudo", why: "ran-as-root", command, user: "jarvis", ...(count === undefined ? {} : { count }),
  });

  it("reads the command out of Claude's and Codex's shell calls", () => {
    expect(shellCommandOf({ toolName: "Bash", input: { command: "sudo ls" } })).toBe("sudo ls");
    expect(shellCommandOf({ toolName: "exec_command", input: { cmd: "sudo ls" } })).toBe("sudo ls");
    expect(shellCommandOf({ toolName: "shell", input: { command: ["sudo", "ls", "/root"] } })).toBe("sudo ls /root");
    expect(shellCommandOf({ toolName: "Read", input: { file_path: "/etc/hosts" } })).toBeNull();
  });

  it("knows a shell command that ran the root command from one that names it", () => {
    expect(runsSudoCommand("sudo -n /usr/local/sbin/tts-install-cron && echo ok", "/usr/local/sbin/tts-install-cron")).toBe(true);
    expect(runsSudoCommand("sudo apt-get install -y jq", "/usr/bin/apt-get install -y jq")).toBe(true);
    expect(runsSudoCommand("ls /usr/local/sbin/tts-install-cron; grep -c sudo f", "/usr/local/sbin/tts-install-cron")).toBe(false);
    expect(runsSudoCommand("sudo cat /etc/hosts", "/usr/bin/cat /etc/sudoers.d/jarvis")).toBe(false);
  });

  it("puts a change after the latest call that ran it, and the rest by time", () => {
    const rows = [
      call("c1", T - 600_000, "sudo apt-get install -y jq"),
      call("c2", T - 2_000, "sudo apt-get install -y jq"),
      call("c3", T + 60_000, "sudo apt-get install -y jq"),
    ];
    const placed = placeBoxChanges(rows, [
      change("b1", T, "/usr/bin/apt-get install -y jq"),
      change("b2", T, "read-only: cat ×2", 2),
      change("b3", T, "/usr/bin/systemctl restart nginx"),
    ]);
    expect([...placed.afterCall.entries()].map(([id, changes]) => [id, changes.map((c) => c.id)])).toEqual([["c2", ["b1"]]]);
    expect(placed.byTime.map((c) => c.id)).toEqual(["b2", "b3"]);
  });

  it("says what changed in the record's own words", () => {
    expect(boxChangeText(change("b", T, "read-only: cat ×2", 2))).toBe("read-only: cat ×2 (2 read-only commands)");
    expect(boxChangeText({ id: "s", at: T, source: "setup", why: "setup", user: "jarvis", commit: "0123456789abcdef", change: { what: "setup", after: "folded: 2 unit changes" } }))
      .toBe("setup ran at 0123456: folded: 2 unit changes");
    expect(boxChangeText({ id: "u", at: T, source: "systemd", why: "unit", user: "root", change: { what: "cron.service", after: "restart" } })).toBe("cron.service: restart");
  });
});
