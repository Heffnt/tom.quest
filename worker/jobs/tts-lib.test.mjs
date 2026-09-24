// Tests for the shared brief-clipping rule in tts-lib.mjs.
//
// This rule used to be spelled twice — once in plan-graphs.mjs (with an
// ellipsis marker and an empty-text case) and once in the retired v1 batcher
// (a bare slice with neither) — so the same brief reached the model in two
// forms depending on which planner read it. These three cases are exactly the
// ones the two old spellings disagreed about, so they are what a re-split
// would break first.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutBoxState } from "../../test/box-state.mjs";
import { tempDir } from "../../test/temp.mjs";
import { parseRegistrationBlock } from "../runs/registration.mjs";

import {
  runClaude,
  resultEnvelopeOf,
  DENIABLE_TOOLS,
  captureContext,
  clip,
  convexFetch,
  declined,
  declinedLine,
  JSON_ONLY_ANSWER,
  NO_ID,
  reconcileVerdicts,
  reportJobFailed,
  reportJobOk,
  ttsItemLink,
  unmatchedIdKey,
  unmatchedIdMessage,
  untriagedKey,
  untriagedMessage,
} from "./tts-lib.mjs";

// EVERY runClaude CASE RUNS THROUGH box-run.mjs, which takes a slot on the
// semaphore under the run state directory and makes a work directory there.
// Pointed at a scratch directory, with no env file and no inherited slot, so a
// suite run on the box neither queues behind real runs nor rides one's slot.
const runState = withoutBoxState();

describe("clip", () => {
  // Any limit will do; 400 is the brief limit scripts/check-writing-standard.mjs holds.
  const MAX_BRIEF_CHARS = 400;

  it("returns text shorter than the limit unchanged and unmarked", () => {
    expect(clip("a short brief", MAX_BRIEF_CHARS)).toBe("a short brief");
  });

  it("returns text exactly at the limit unchanged and unmarked", () => {
    const exact = "x".repeat(MAX_BRIEF_CHARS);
    expect(clip(exact, MAX_BRIEF_CHARS)).toBe(exact);
  });

  it("cuts text over the limit and marks the cut with an ellipsis", () => {
    const long = "y".repeat(MAX_BRIEF_CHARS + 50);
    const clipped = clip(long, MAX_BRIEF_CHARS);
    expect(clipped).toBe(`${"y".repeat(MAX_BRIEF_CHARS)}…`);
    // The marker is appended after the slice, so the result is one character
    // longer than the limit. The limit bounds the source text, not the output.
    expect(clipped).toHaveLength(MAX_BRIEF_CHARS + 1);
  });

  it("maps empty and missing text to null, never to an empty string", () => {
    // A blank field would read to the model as a claim that the todo HAS an
    // empty brief; null drops the field from the JSON instead.
    expect(clip("", MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(undefined, MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(null, MAX_BRIEF_CHARS)).toBeNull();
  });

  it("honours a caller-supplied limit other than MAX_BRIEF_CHARS", () => {
    expect(clip("abcdef", 3)).toBe("abc…");
  });
});

describe("the item link", () => {
  it("is the one URL shape worker/ writes", () => {
    // convex/ttsShared.ts ttsItemLink is the same string server-side; a job
    // that spells it itself is the drift this helper exists to stop.
    expect(ttsItemLink("k17abc")).toBe("https://tom.quest/tts?item=k17abc");
  });
});

// An integration Tom declines is an archived todo with his ruling on it
// (convex/ttsIntegrations.ts). Every poller asks this first and stands down
// when the answer is not null.
describe("declined", () => {
  const outlook = {
    name: "outlook",
    todoId: "k1",
    ruledAt: Date.UTC(2026, 8, 5, 14),
    sentence: "not worth the credential",
  };

  it("finds the ruling for this job's own name", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, "outlook"),
    ).toEqual(outlook);
  });

  it("is null for a job Tom has not declined", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, "gmail"),
    ).toBeNull();
    expect(
      declined({ declinedIntegrations: [] }, "outlook"),
    ).toBeNull();
  });

  it("matches the name however the caller spelled it", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, " Outlook "),
    ).toEqual(outlook);
  });

  it("survives a deployment that does not serve the field yet", () => {
    // A box running ahead of the deployment must not crash every poller.
    expect(declined({}, "outlook")).toBeNull();
    expect(declined(undefined, "outlook")).toBeNull();
  });
});

// ONE READ PER RUN. A poller reads its writing standard and declined list from
// one payload, and `declined` takes that payload rather than fetching its own.
describe("captureContext", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the single GET the writing standard and declined list come from", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          writingStandard: "write standard",
          declinedIntegrations: [],
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const context = await captureContext(env);
    expect(declined(context, "gmail")).toBeNull();
    expect(context.writingStandard).toBe("write standard");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://x.convex.site/tts/capture-context",
    );
  });

  it("passes a missing model-of-tom layer refusal to its caller unchanged", async () => {
    const refusal = "model-of-tom layer write is not stored";
    const body = JSON.stringify({ error: refusal });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => body })));

    await expect(captureContext(env)).rejects.toMatchObject({ message: refusal, status: 503, body });
  });
});

describe("convexFetch failures", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps unrelated HTTP errors in the HTTP summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: "invalid JSON body" }) })));

    await expect(convexFetch(env, "/tts/example")).rejects.toMatchObject({
      message: '/tts/example -> HTTP 400: {"error":"invalid JSON body"}',
      status: 400,
      body: '{"error":"invalid JSON body"}',
    });
  });
});

// A job's report about itself must never become a second unreported failure,
// and telling Tom about a bad run must never cost the run's real work.
describe("reportJobFailed / reportJobOk", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the job, the words and the condition key", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, reported: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await reportJobFailed(env, {
        job: "poll-canvas",
        error: "the token is dead",
        key: "poll-canvas:canvas-auth",
      }),
    ).toEqual({ ok: true, reported: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://x.convex.site/tts/job-failed");
    expect(JSON.parse(init.body)).toEqual({
      job: "poll-canvas",
      error: "the token is dead",
      key: "poll-canvas:canvas-auth",
    });
  });

  it("swallows a refusal rather than failing twice over one failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    expect(await reportJobFailed(env, { job: "poll-canvas", error: "x" })).toBeNull();
    expect(await reportJobOk(env, { job: "poll-canvas", key: "k" })).toBeNull();
  });
});

// SILENCE USED TO MEAN "SKIP". Each poller looked its batch up in a map keyed
// by the ids the MODEL returned, and a miss read as "not captured" — so a
// garbled id dropped a mail, the cursor advanced past it, and the only trace
// was a count one lower.
describe("reconcileVerdicts", () => {
  const yes = (id, statement) => ({ id, capture: true, statement });
  const no = (id) => ({ id, capture: false });

  it("gives every answered item its verdict and leaves nothing unresolved", () => {
    const { byId, unmatched, unresolved } = reconcileVerdicts(
      ["a", "b", "c"],
      [yes("a", "Reply to Sarah"), no("b"), yes("c", "Pay the invoice")],
    );
    expect(unresolved).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(byId.get("a")).toMatchObject({ capture: true, statement: "Reply to Sarah" });
    expect(byId.get("b")).toEqual({ capture: false });
  });

  it("names the item a garbled id lost AND the garbled id itself", () => {
    // "b1" for "b": the mail has no verdict and the answer carries an id that
    // was never in the batch. Both are facts, and both are reported.
    const { byId, unmatched, unresolved } = reconcileVerdicts(
      ["a", "b", "c"],
      [no("a"), yes("b1", "Reply to Sarah"), no("c")],
    );
    expect(unresolved).toEqual(["b"]);
    expect(unmatched).toEqual(["b1"]);
    expect(byId.has("b")).toBe(false);
  });

  it("leaves an item the model simply did not mention unresolved", () => {
    const { unresolved, unmatched } = reconcileVerdicts(["a", "b"], [no("a")]);
    expect(unresolved).toEqual(["b"]);
    expect(unmatched).toEqual([]);
  });

  it("keeps the batch's own order, so the caller can stop at the oldest", () => {
    expect(reconcileVerdicts(["a", "b", "c", "d"], [no("c")]).unresolved).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("treats a claim with no statement as no verdict at all", () => {
    // "capture: true" with nothing to write claims an action and names none.
    // Reading it as a skip would lose the item exactly the way silence did.
    for (const answer of [
      { id: "a", capture: true },
      { id: "a", capture: true, statement: "   " },
      { id: "a" },
      { id: "a", capture: "yes" },
    ]) {
      expect(reconcileVerdicts(["a"], [answer]).unresolved).toEqual(["a"]);
    }
    // Whereas an explicit no is a complete verdict.
    expect(reconcileVerdicts(["a"], [no("a")]).unresolved).toEqual([]);
  });

  it("collects an answer that names no id under one stand-in, deduped", () => {
    const { unmatched, unresolved } = reconcileVerdicts(
      ["a"],
      [{ capture: false }, { id: "", capture: false }, { id: "zz", capture: false }],
    );
    expect(unmatched).toEqual([NO_ID, "zz"]);
    expect(unresolved).toEqual(["a"]);
  });

  it("survives an answer that is not a list of objects", () => {
    expect(reconcileVerdicts(["a"], undefined).unresolved).toEqual(["a"]);
    expect(reconcileVerdicts(["a"], [null, 7, "b"]).unresolved).toEqual(["a"]);
  });
});

describe("what an untriaged item is reported as", () => {
  it("is keyed on the item, so a mail retried every tick is one row", () => {
    // The cursor holds at the oldest untriaged item, so the same mail comes
    // back every ten minutes until a run answers for it. Keyed on the mail,
    // that is one row (convex/ttsJobs.ts); keyed on the run it would be one
    // row every ten minutes, for ever.
    expect(untriagedKey("poll-gmail", "gmail:message:18f0a1")).toBe(
      "poll-gmail:untriaged:gmail:message:18f0a1",
    );
    expect(unmatchedIdKey("poll-gmail", "18f0a1x")).toBe(
      "poll-gmail:unmatched-id:18f0a1x",
    );
    // Model output, clipped: an id can come back arbitrarily long.
    expect(unmatchedIdKey("poll-gmail", "x".repeat(500))).toHaveLength(
      "poll-gmail:unmatched-id:".length + 80,
    );
  });

  it("says what was skipped and what the cursor is doing about it", () => {
    const message = untriagedMessage(
      "poll-gmail",
      '"Lab meeting Friday" from Sarah Chen',
      "gmail:message:18f0a1",
    );
    expect(message).toContain("Lab meeting Friday");
    expect(message).toContain("gmail:message:18f0a1");
    expect(message).toContain("read again next run");
    expect(unmatchedIdMessage("poll-canvas", "991x")).toContain('"991x"');
  });
});

describe("declinedLine", () => {
  it("says who declined it, when, and why", () => {
    expect(
      declinedLine("poll-outlook", {
        ruledAt: Date.UTC(2026, 8, 5, 14),
        sentence: "not worth the credential",
      }),
    ).toBe(
      "[poll-outlook] declined by Tom on 2026-09-05: not worth the credential — skipping",
    );
  });

  it("drops the reason when he gave none", () => {
    expect(
      declinedLine("poll-canvas", { ruledAt: Date.UTC(2026, 8, 5, 14), sentence: null }),
    ).toBe("[poll-canvas] declined by Tom on 2026-09-05 — skipping");
  });
});


describe("JSON_ONLY_ANSWER", () => {
  it("is the one JSON instruction every worker prompt shares", () => {
    expect(JSON_ONLY_ANSWER).toBe("Answer ONLY a JSON object, no prose, no code fences:");
  });
});

// runClaude's allowedTools is what pre-approves the delegate's reading tools
// (worker/jobs/delegate.mjs passes Read, Glob and Grep). A malformed list must
// fail before the process is spawned rather than quietly widening the run to
// every tool the CLI has.
describe("runClaude allowedTools", () => {
  it("refuses a list that is not non-empty strings, before spawning anything", () => {
    expect(() => runClaude("p", { allowedTools: "Read" })).toThrow(/allowedTools/);
    expect(() => runClaude("p", { allowedTools: ["Read", ""] })).toThrow(/allowedTools/);
    expect(() => runClaude("p", { allowedTools: [1] })).toThrow(/allowedTools/);
  });
});

// The token of the CHILD run a call spawns, handed back to the caller. It is
// what a door stamps on the row it stores as producedByRunToken, and it is the
// one edge convex/runLabels.ts turns into a label's runId. The job's own
// process.env.TTS_RUN_REG_TOKEN is a DIFFERENT run and would be the wrong edge.
// BOTH OF THESE EXPECT THE CALL TO FAIL — that IS the case being made: the
// receipt is filled before the child is reached. The suite's CLAUDE_BIN names
// no binary (vitest.config.mts), so the launcher refuses before it spawns.
// Until 2026-09-24 they started the machine's real `claude` when it had one,
// and the one-millisecond child budget below is what killed it; it stays so a
// test run with a real CLAUDE_BIN still cannot make a call. The generous test
// timeout is for the launcher's own work under a full-suite run, where the
// five-second default made the first of them flaky.
const SPAWN_TIMEOUT_MS = 30_000;

describe("runClaude receipt", () => {
  it("fills the token before the child runs, so a failed call still names its run", () => {
    const spool = tempDir("tts-lib-receipt-");
    const previous = process.env.TTS_RUN_REG_SPOOL;
    process.env.TTS_RUN_REG_SPOOL = spool;
    const receipt = {};
    try {
      // The token is already written by the time the child is reached, which is
      // why a caller can report WHICH run timed out rather than only that one
      // did.
      runClaude("p", { model: "sonnet", timeoutMs: 1, registration: { layersKnown: false }, receipt });
    } catch {
      // Expected: the suite's CLAUDE_BIN names no binary (vitest.config.mts),
      // so the launcher refuses before any child starts.
    } finally {
      if (previous === undefined) delete process.env.TTS_RUN_REG_SPOOL;
      else process.env.TTS_RUN_REG_SPOOL = previous;
    }
    expect(typeof receipt.runToken).toBe("string");
    expect(receipt.runToken.length).toBeGreaterThan(0);
  }, SPAWN_TIMEOUT_MS);

  it("names a worker unless the caller named another environment", () => {
    // The registration rides at the head of the prompt, so this case needs a
    // CLI that keeps what it read: a fake that writes its stdin to a file.
    const dir = tempDir("tts-lib-environment-cli-");
    const script = path.join(dir, "fake.mjs");
    fs.writeFileSync(script, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.FAKE_PROMPT_AT, fs.readFileSync(0, "utf8"));',
      'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok" }));',
    ].join("\n"));
    fs.chmodSync(script, 0o755);
    let bin = script;
    if (process.platform === "win32") {
      bin = path.join(dir, "claude.cmd");
      fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
    }
    const envelopeFor = (registration) => {
      const spool = tempDir("tts-lib-environment-");
      const promptAt = path.join(spool, "prompt.txt");
      vi.stubEnv("TTS_RUN_REG_SPOOL", spool);
      vi.stubEnv("CLAUDE_BIN", bin);
      vi.stubEnv("FAKE_PROMPT_AT", promptAt);
      vi.stubEnv("TTS_RUN_SLOT_HELD", "");
      // NO vi.unstubAllEnvs() HERE: it also undid withoutBoxState's stubs, so
      // the second call ran with no run state directory and, on the box, read
      // /etc/tts/worker.env and made its work directory in the box's own
      // /var/cache/tts/runs. The helper's afterEach restores the environment.
      runClaude("p", { model: "sonnet", registration });
      return parseRegistrationBlock(fs.readFileSync(promptAt, "utf8")).registration;
    };
    expect(envelopeFor({ layersKnown: false }).environment).toBe("worker");
    expect(envelopeFor({ layersKnown: false, environment: "session" }).environment).toBe("session");
  }, SPAWN_TIMEOUT_MS);

  it("writes nothing into a receipt when no registration was asked for", () => {
    const receipt = {};
    try {
      runClaude("p", { model: "sonnet", timeoutMs: 1, receipt });
    } catch {
      // Same spawn failure; the assertion is about the receipt.
    }
    expect(receipt.runToken).toBeUndefined();
  }, SPAWN_TIMEOUT_MS);
});

// THE CLI SAYS WHY ON ITS WAY OUT, and execFileSync used to throw the saying
// away: a non-zero exit reached the caller as "Command failed", so eighty
// evals items failed on 2026-09-14 with a sentence naming neither the cause
// nor the knob. The envelope rides `error.stdout` and nothing above runClaude
// can see it.
describe("resultEnvelopeOf", () => {
  it("reads the result envelope off whatever the CLI printed", () => {
    expect(resultEnvelopeOf('{"type":"result","subtype":"success","result":"hello"}'))
      .toMatchObject({ subtype: "success", result: "hello" });
    // The failure envelope: a subtype and NO result. This is the shape the
    // re-thrown message is built out of.
    expect(resultEnvelopeOf('{"type":"result","subtype":"error_max_turns","is_error":true}'))
      .toMatchObject({ subtype: "error_max_turns" });
  });

  it("answers null for anything that is not one", () => {
    expect(resultEnvelopeOf("not json at all")).toBe(null);
    expect(resultEnvelopeOf('{"type":"assistant"}')).toBe(null);
    expect(resultEnvelopeOf("")).toBe(null);
    expect(resultEnvelopeOf(undefined)).toBe(null);
    expect(resultEnvelopeOf(null)).toBe(null);
  });
});

describe("runClaude on a failing child", () => {
  // A `claude` that is not on PATH prints no envelope, so the message falls
  // back to the head of stderr rather than saying nothing at all.
  it("names the failure instead of Command failed", () => {
    const previous = process.env.PATH;
    process.env.PATH = path.join(os.tmpdir(), "tts-lib-no-claude-here");
    let thrown = null;
    try {
      runClaude("p", { model: "sonnet", timeoutMs: 1000 });
    } catch (error) {
      thrown = error;
    } finally {
      process.env.PATH = previous;
    }
    expect(thrown).not.toBe(null);
    expect(thrown.message).toMatch(/^claude failed/);
    expect(thrown.message).not.toBe("Command failed");
  }, SPAWN_TIMEOUT_MS);

  // The shape the message takes when the envelope IS there, asserted off the
  // one function that builds it — spawning a `claude` that exits non-zero is
  // not something this suite can arrange on every machine.
  it("carries the envelope's subtype and the exit code", () => {
    const error = Object.assign(new Error("Command failed"), {
      status: 1,
      stdout: '{"type":"result","subtype":"error_max_turns","is_error":true}',
      stderr: "",
    });
    const failed = resultEnvelopeOf(error.stdout);
    expect(failed.subtype).toBe("error_max_turns");
    expect(`claude failed (subtype: ${failed.subtype}, exit ${error.status})`)
      .toBe("claude failed (subtype: error_max_turns, exit 1)");
  });
});

// An EMPTY allow-list is a real answer and not a malformed one: the evals
// explanation regeneration asks for no tools at all, because everything it is
// meant to read is in its prompt.
describe("runClaude with no tools", () => {
  it("accepts an empty allow-list", () => {
    let thrown = null;
    try {
      runClaude("p", { model: "sonnet", timeoutMs: 1, allowedTools: [] });
    } catch (error) {
      thrown = error;
    }
    // It reached the spawn — the validation above it did not refuse the list.
    expect(String(thrown?.message ?? "")).not.toMatch(/allowedTools/);
  }, SPAWN_TIMEOUT_MS);

  // The allow-list PRE-APPROVES and does not withhold, and the default
  // permission mode hands the model its read tools either way — which is how
  // an explanation regeneration with a two-turn budget spent both turns
  // reading the tree. "None" has to be spelled out to be denied.
  //
  // AND SPELLED WHOLE. The file-and-shell names below are not the CLI's set:
  // with only those denied, the box's installed CLI still handed the model an
  // agent spawner, a scheduler, a cron trio and ToolSearch, which fetches the
  // schemas of everything else. The list is asserted here by kind rather than
  // by length, because a new built-in must be added to it and a test that
  // counted would only say that the number changed.
  it("names the tools it is denying, because the flag denies by name", () => {
    expect(DENIABLE_TOOLS).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Write"]));
    expect(DENIABLE_TOOLS).toEqual(expect.arrayContaining(["Task", "ToolSearch", "Workflow", "ScheduleWakeup"]));
    expect(DENIABLE_TOOLS.every((tool) => typeof tool === "string" && tool !== "")).toBe(true);
    // Denying the same name twice is harmless to the CLI and a sign the list
    // was edited without being read.
    expect(new Set(DENIABLE_TOOLS).size).toBe(DENIABLE_TOOLS.length);
  });
});

// runClaude BUILDS NO COMMAND LINE: it composes the job's envelope and hands
// the call to box-run.mjs's boxRunSync. These cases run the whole path against
// a fake `claude` named by CLAUDE_BIN, the seam box-run.mjs keeps for exactly
// this, and read what the child was given and what the spool holds.
describe("runClaude through the box launcher", () => {
  function fakeClaude(answer, exitCode = 0, stderr = "") {
    const dir = tempDir("tts-lib-fake-claude-");
    const script = path.join(dir, "fake.mjs");
    fs.writeFileSync(script, [
      'import fs from "node:fs";',
      'let stdin = "";',
      'try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
      'if (process.env.FAKE_PROMPT_AT) fs.writeFileSync(process.env.FAKE_PROMPT_AT, stdin);',
      'if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), slotHeld: process.env.TTS_RUN_SLOT_HELD ?? null, config: process.env.CLAUDE_CONFIG_DIR ?? null }));',
      `process.stdout.write(${JSON.stringify(answer)});`,
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join("\n"));
    if (process.platform === "win32") {
      const command = path.join(dir, "claude.cmd");
      fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
      return command;
    }
    fs.writeFileSync(script, `#!/usr/bin/env node\n${fs.readFileSync(script, "utf8")}`);
    fs.chmodSync(script, 0o755);
    return script;
  }
  const spooled = (spool) => fs.readdirSync(spool)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(spool, name), "utf8")));

  it("returns the answer text and spools the job's envelope under box-run's name", () => {
    const spool = path.join(runState(), "registration");
    const record = path.join(runState(), "record.json");
    vi.stubEnv("TTS_RUN_REG_SPOOL", spool);
    const promptAt = path.join(runState(), "prompt.txt");
    vi.stubEnv("FAKE_RECORD", record);
    vi.stubEnv("FAKE_PROMPT_AT", promptAt);
    vi.stubEnv("CLAUDE_BIN", fakeClaude(JSON.stringify({ type: "result", subtype: "success", result: "triaged" })));
    vi.stubEnv("RUN_HOST", "");
    const receipt = {};
    const answer = runClaude("p", { model: "sonnet", registration: { origin: "cron:poll-gmail", layersKnown: false }, receipt });
    expect(answer).toBe("triaged");
    const [envelope] = spooled(spool);
    expect(envelope.token).toBe(receipt.runToken);
    expect(envelope.writer.file).toBe("worker/runs/box-run.mjs");
    // The job's registration is at the head of the prompt the CLI read; the
    // spool keeps the token, which that prompt never carries.
    const sent = fs.readFileSync(promptAt, "utf8");
    expect(sent).not.toContain(envelope.token);
    expect(envelope).not.toHaveProperty("registration");
    expect(parseRegistrationBlock(sent).registration).toMatchObject({ origin: "cron:poll-gmail", kind: "job", environment: "worker", host: null, cli: "claude", modelRequested: "sonnet" });
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    // The same flags runClaude always handed the CLI: JSON out, eight turns
    // by default, the model, and nothing else.
    expect(seen.argv).toEqual(["-p", "--output-format", "json", "--max-turns", "8", "--model", "sonnet"]);
    // Every job call runs under the active account, and its child never
    // queues for a slot of its own.
    expect(seen.config).toBe("/root/.claude-accounts/active");
    expect(seen.slotHeld).toBe("1");
  }, SPAWN_TIMEOUT_MS);

  it("names the subtype and the exit code when the CLI fails with an envelope", () => {
    vi.stubEnv("CLAUDE_BIN", fakeClaude(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }), 1));
    expect(() => runClaude("p", { model: "sonnet" })).toThrow("claude failed (subtype: error_max_turns, is_error: true, exit 1)");
  }, SPAWN_TIMEOUT_MS);

  // THE SPEND LIMIT OF 2026-09-22. An account out of usage exits 1 with
  // subtype "success", is_error true and the reason as the envelope's result;
  // the message said only "subtype: success, exit 1". It now carries the
  // envelope's text and the stderr tail, each on one line.
  it("carries the envelope's result text, is_error and the stderr tail", () => {
    vi.stubEnv("CLAUDE_BIN", fakeClaude(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your monthly spend limit" }),
      1,
      "first line\nsecond line\n",
    ));
    expect(() => runClaude("p", { model: "sonnet" })).toThrow(
      "claude failed (subtype: success, is_error: true, exit 1): result: You've hit your monthly spend limit; stderr: first line second line",
    );
  }, SPAWN_TIMEOUT_MS);

  it("trims a long result to a bounded length", () => {
    vi.stubEnv("CLAUDE_BIN", fakeClaude(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "x".repeat(5000) }), 1));
    let message = "";
    try { runClaude("p", { model: "sonnet" }); } catch (error) { message = error.message; }
    expect(message).toBe(`claude failed (subtype: success, is_error: true, exit 1): result: ${"x".repeat(300)}`);
  }, SPAWN_TIMEOUT_MS);

  it("says a zero exit with no result is a failure, in the same words", () => {
    vi.stubEnv("CLAUDE_BIN", fakeClaude(JSON.stringify({ type: "result", subtype: "error_during_execution" })));
    expect(() => runClaude("p", { model: "sonnet" })).toThrow("claude failed (subtype: error_during_execution): the envelope carried no result");
  }, SPAWN_TIMEOUT_MS);

  // THE EVALS DEADLOCK OF 2026-09-19. Two box runs held both slots while they
  // waited for their pull requests' evals, and the evals pass's model call
  // queued for a slot behind them, so nobody finished. A job's call takes no
  // slot: with both held it runs at once. The call runs in a child process
  // under a hard timeout because a queued call waits synchronously, which no
  // test timeout in this process could interrupt: were it to queue again, the
  // child is killed and the test fails instead of hanging the suite.
  it("runs a job's call at once with both slots held, and takes none itself", () => {
    const held = { count: 2, holders: [
      { id: "held0001", pid: process.pid, at: Date.now() },
      { id: "held0002", pid: process.pid, at: Date.now() },
    ] };
    const counter = path.join(runState(), "semaphore.json");
    fs.writeFileSync(counter, JSON.stringify(held));
    const lib = pathToFileURL(path.join(import.meta.dirname, "tts-lib.mjs")).href;
    const call = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const { runClaude } = await import(${JSON.stringify(lib)}); process.stdout.write(runClaude("p", { model: "sonnet" }));`,
    ], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        CLAUDE_BIN: fakeClaude(JSON.stringify({ type: "result", subtype: "success", result: "scored" })),
        RUN_MAX_PARALLEL: "2",
      },
    });
    expect(call.error?.code).toBeUndefined();
    expect(call.stdout).toBe("scored");
    expect(JSON.parse(fs.readFileSync(counter, "utf8"))).toEqual(held);
  }, SPAWN_TIMEOUT_MS);
});

// BOTH LAYOUTS RESOLVE THE LAUNCHER. In a checkout tts-lib.mjs reaches
// ../runs/box-run.mjs; on the box setup.sh copies jobs/*.mjs flat to /opt/tts/
// and runs/*.mjs to /opt/tts/runs/, so it reaches ./runs/box-run.mjs. No
// guardrail covers a jobs/ to runs/ import, so this builds the flat layout the
// way setup.sh does and imports it from a process whose cwd is outside the
// repository, where the cwd fallbacks cannot rescue a wrong candidate.
describe("the launcher import in the installed layout", () => {
  it("imports tts-lib.mjs from a flat /opt/tts-shaped copy", () => {
    const root = tempDir("tts-lib-flat-");
    const flat = path.join(root, "opt-tts");
    const copyAll = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from).filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs"))) {
        fs.copyFileSync(fs.realpathSync(path.join(from, name)), path.join(to, name));
      }
    };
    copyAll(path.resolve("worker/jobs"), flat);
    copyAll(path.resolve("worker/runs"), path.join(flat, "runs"));
    copyAll(path.resolve("worker/session-host"), path.join(flat, "session-host"));
    // The runs/ modules' own ../jobs/ imports are setup.sh's named copies,
    // fenced by scripts/check-setup-imports.mjs; the whole set stands in here.
    copyAll(path.resolve("worker/jobs"), path.join(flat, "jobs"));
    const url = pathToFileURL(path.join(flat, "tts-lib.mjs")).href;
    const out = execFileSync(process.execPath, [
      "--input-type=module", "-e",
      "const m = await import(process.argv[1]); console.log(typeof m.runClaude, m.DENIABLE_TOOLS.length > 0);",
      url,
    ], { cwd: root, encoding: "utf8" });
    expect(out.trim()).toBe("function true");
  }, SPAWN_TIMEOUT_MS);
});
