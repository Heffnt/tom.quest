// @vitest-environment node
//
// The Codex runner (worker/session-host/codex-query.mjs), exercised end to
// end against a fake binary: fixtures/fake-codex.mjs prints canned JSONL and
// records the argv it was given, so both halves of the runner are pinned —
// the event translation (what a Codex session's transcript looks like) and
// the process contract (the resume flags, interrupt → throw, exit≠0 →
// throw). No Agent SDK import anywhere: this must run in the repo's vitest.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so neither this file nor the fixture ships.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-codex.mjs");

// CODEX_BIN is read at module load, so it is set before the import below.
process.env.CODEX_BIN = FAKE;
const { codexQuery, codexArgs, translateEvent } = await import("../codex-query.mjs");

let tmp;
let argsFile;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-query-test-"));
  argsFile = path.join(tmp, "args.jsonl");
});
afterEach(() => {
  // Retries: on Windows a just-exited child can still hold its cwd for a
  // few ms, and every test drains its iterator to `done` (which awaits the
  // exit) before this runs — the retries cover the remaining gap.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// The async iterable of user turns session.mjs hands the runner: one item
// per turn, pushed by the test, closed to end the session.
function turnSource() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(text) {
      const w = waiters.shift();
      if (w) w({ value: text, done: false });
      else items.push(text);
    },
    close() {
      closed = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        let next;
        if (items.length > 0) next = { value: items.shift(), done: false };
        else if (closed) return;
        else next = await new Promise((r) => waiters.push(r));
        if (next.done) return;
        yield {
          type: "user",
          message: { role: "user", content: next.value },
          parent_tool_use_id: null,
        };
      }
    },
  };
}

function start(options = {}) {
  const prompt = turnSource();
  const q = codexQuery({
    prompt,
    options: {
      cwd: tmp,
      env: { ...process.env, FAKE_CODEX_ARGS_FILE: argsFile },
      model: "gpt-5.6-sol",
      effort: "xhigh",
      ...options,
    },
  });
  return { prompt, q, it: q[Symbol.asyncIterator]() };
}

// Collect messages until a `result` (one turn's worth), or the iterator ends.
async function readTurn(it) {
  const out = [];
  for (;;) {
    const { value, done } = await it.next();
    if (done) return out;
    out.push(value);
    if (value.type === "result") return out;
  }
}

const recordedArgs = () =>
  fs
    .readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const blocks = (msgs, type) =>
  msgs.filter((m) => m.type === type).flatMap((m) => m.message.content);

describe("codexArgs", () => {
  it("first turn: exec with -C, model, effort, bypass, no --ephemeral", () => {
    const args = codexArgs({ cwd: "/w", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2)).toEqual(["-C", "/w"]);
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-5.6-sol"]);
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--json");
    expect(args).not.toContain("--ephemeral");
    expect(args.at(-1)).toBe("-"); // prompt on stdin
    expect(args.join(" ")).not.toMatch(/sandbox_workspace_write/);
  });

  it("resume: exec resume <thread> with model + effort repeated and no -C", () => {
    const args = codexArgs({ threadId: "t-1", cwd: "/w", model: "gpt-5.6-terra", effort: "medium" });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "t-1"]);
    expect(args).not.toContain("-C");
    expect(args).not.toContain("-s");
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-5.6-terra"]);
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args.at(-1)).toBe("-");
  });
});

describe("translateEvent", () => {
  it("turns thread.started into system/init carrying the thread id", () => {
    expect(translateEvent({ type: "thread.started", thread_id: "abc" })).toEqual([
      { type: "system", subtype: "init", session_id: "abc", agent: "codex" },
    ]);
  });

  it("records a bare error as a system row without ending the turn", () => {
    const out = translateEvent({ type: "error", message: "stream reset" });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("user");
    expect(out[0].message.content[0]).toEqual({ type: "text", text: "codex: stream reset" });
    expect(out.some((m) => m.type === "result")).toBe(false);
  });

  it("turns turn.failed into an error result with the message", () => {
    const [m] = translateEvent({ type: "turn.failed", error: { message: "boom" } });
    expect(m).toMatchObject({ type: "result", is_error: true, result: "boom" });
  });

  it("emits a tool_use with the result when only item.completed arrived", () => {
    const out = translateEvent({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 2 },
    });
    expect(out.map((m) => m.type)).toEqual(["assistant", "user"]);
    expect(out[0].message.content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } });
    expect(out[1].message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", content: "a\n", is_error: true });
  });

  it("ignores turn.started and item.updated", () => {
    expect(translateEvent({ type: "turn.started" })).toEqual([]);
    expect(translateEvent({ type: "item.updated", item: { id: "x", type: "command_execution" } })).toEqual([]);
  });
});

describe("codexQuery against the fake binary", () => {
  it("yields init first, then the real thread id via thread.started, then every item type", async () => {
    const { prompt, it } = start();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: "system", subtype: "init", agent: "codex" });
    expect(first.value.session_id).toBeUndefined(); // no thread yet

    prompt.push("SCENARIO:full");
    const msgs = await readTurn(it);

    // thread.started → a second init, now with the id session.mjs stores.
    expect(msgs[0]).toEqual({ type: "system", subtype: "init", session_id: "thread-fake-0001", agent: "codex" });

    const uses = blocks(msgs, "assistant").filter((b) => b.type === "tool_use");
    const results = blocks(msgs, "user").filter((b) => b.type === "tool_result");
    const texts = blocks(msgs, "assistant").filter((b) => b.type === "text");
    const thinking = blocks(msgs, "assistant").filter((b) => b.type === "thinking");
    const systemTexts = blocks(msgs, "user").filter((b) => b.type === "text").map((b) => b.text);

    // command_execution: started → tool_use once; completed → result only.
    expect(uses.filter((u) => u.name === "Bash")).toHaveLength(1);
    expect(uses.find((u) => u.name === "Bash")).toMatchObject({ id: "item_0", input: { command: "echo hello" } });
    expect(results.find((r) => r.tool_use_id === "item_0")).toMatchObject({ content: "hello\n", is_error: false });

    // reasoning → thinking; agent_message → text.
    expect(thinking.map((b) => b.thinking)).toEqual(["I should write the file."]);
    expect(texts.map((b) => b.text)).toEqual(["done"]);

    // file_change: one tool_use per change, named by kind, each with a result.
    const fileUses = uses.filter((u) => u.id.startsWith("item_2:"));
    expect(fileUses.map((u) => [u.name, u.input.file_path])).toEqual([
      ["Write", "/w/a.txt"],
      ["Edit", "/w/b.txt"],
      ["Delete", "/w/c.txt"],
    ]);
    expect(results.filter((r) => r.tool_use_id.startsWith("item_2:")).map((r) => r.content)).toEqual([
      "add: /w/a.txt",
      "update: /w/b.txt",
      "delete: /w/c.txt",
    ]);

    // mcp_tool_call (completed only) and web_search.
    expect(uses.find((u) => u.id === "item_3")).toMatchObject({ name: "github.get_issue", input: { number: 7 } });
    expect(results.find((r) => r.tool_use_id === "item_3")).toMatchObject({ content: "issue #7: open", is_error: false });
    expect(uses.find((u) => u.id === "item_4")).toMatchObject({ name: "WebSearch", input: { query: "codex exec json" } });

    // todo_list → system rows (initial and final), as JSON of the list.
    expect(systemTexts.some((t) => t.startsWith("codex plan:") && t.includes('"completed":false'))).toBe(true);
    expect(systemTexts.some((t) => t.startsWith("codex plan (final):") && t.includes('"completed":true'))).toBe(true);

    // collab_tool_call → codex.<tool> with prompt + receivers; result = agents_states.
    const spawn = uses.find((u) => u.id === "item_6");
    expect(spawn).toMatchObject({ name: "codex.spawn_agent", input: { prompt: "review the diff", receivers: ["child-1"] } });
    expect(uses.filter((u) => u.id === "item_6")).toHaveLength(1); // started + completed = one tool_use
    expect(results.find((r) => r.tool_use_id === "item_6").content).toBe("child-1: running");
    const wait = uses.find((u) => u.id === "item_7");
    expect(wait).toMatchObject({ name: "codex.wait", input: { receivers: ["child-1"] } });
    expect(wait.input.prompt).toBeUndefined();
    expect(results.find((r) => r.tool_use_id === "item_7").content).toBe("child-1: completed — diff looks fine");

    // The advisory error is a system row, not a result — the turn went on.
    expect(systemTexts).toContain("codex: stream reset; retrying");
    const resultMsgs = msgs.filter((m) => m.type === "result");
    expect(resultMsgs).toHaveLength(1);
    expect(resultMsgs[0]).toMatchObject({ subtype: "success", is_error: false, usage: { input_tokens: 10 } });
    // And the non-JSON stdout line produced nothing.
    expect(msgs.every((m) => JSON.stringify(m).includes("sandbox helper chatter") === false)).toBe(true);

    prompt.close();
    expect((await it.next()).done).toBe(true);
  });

  it("first turn spawns exec -C; later turns resume the thread with -m and effort repeated", async () => {
    const { prompt, it } = start({ model: "gpt-5.6-terra", effort: "medium" });
    await it.next(); // init
    prompt.push("first");
    await readTurn(it);
    prompt.push("second");
    await readTurn(it);
    prompt.close();
    await it.next();

    const runs = recordedArgs();
    expect(runs).toHaveLength(2);
    expect(runs[0].prompt).toBe("first");
    expect(runs[0].argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(runs[0].argv).toContain("-C");
    expect(runs[1].prompt).toBe("second");
    expect(runs[1].argv.slice(0, 3)).toEqual(["exec", "resume", "thread-fake-0001"]);
    expect(runs[1].argv).not.toContain("-C");
    for (const run of runs) {
      const i = run.argv.indexOf("-m");
      expect(run.argv[i + 1]).toBe("gpt-5.6-terra");
      expect(run.argv).toContain('model_reasoning_effort="medium"');
      expect(run.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(run.argv).not.toContain("--ephemeral");
      expect(run.argv.at(-1)).toBe("-");
    }
  });

  it("resumes an existing thread id from options.resume on the very first turn", async () => {
    const { prompt, q, it } = start({ resume: "thread-from-restart" });
    const first = await it.next();
    expect(first.value.session_id).toBe("thread-from-restart");
    prompt.push("after restart");
    await readTurn(it);
    expect(recordedArgs()[0].argv.slice(0, 3)).toEqual(["exec", "resume", "thread-from-restart"]);
    expect(q.threadId()).toBe("thread-from-restart");
    prompt.close();
    expect((await it.next()).done).toBe(true);
  });

  it("turn.failed ends the turn as an error result and the process is done", async () => {
    const { prompt, it } = start();
    await it.next();
    prompt.push("SCENARIO:fail");
    const msgs = await readTurn(it);
    const result = msgs.find((m) => m.type === "result");
    expect(result).toMatchObject({ is_error: true, result: "usage_limit_reached: weekly cap" });
    // The runner stays usable: a next turn resumes.
    prompt.push("again");
    const next = await readTurn(it);
    expect(next.at(-1)).toMatchObject({ type: "result", is_error: false });
    prompt.close();
    expect((await it.next()).done).toBe(true);
  });

  it("exit ≠ 0 without a turn end throws, carrying the stderr tail", async () => {
    const { prompt, it } = start();
    await it.next();
    prompt.push("SCENARIO:crash");
    const seen = [];
    let error;
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (done) break;
        seen.push(value);
      }
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/exited 3 before the turn completed/);
    expect(error.message).toMatch(/panicked/);
    // What arrived before the crash was still yielded.
    expect(blocks(seen, "assistant").some((b) => b.text === "about to die")).toBe(true);
  });

  it("interrupt() resolves and the iterator then throws", async () => {
    const { prompt, q, it } = start();
    await it.next();
    prompt.push("SCENARIO:hang");
    const first = await it.next(); // thread.started init
    expect(first.value.subtype).toBe("init");
    const second = await it.next(); // "working..."
    expect(blocks([second.value], "assistant")[0]).toMatchObject({ text: "working..." });
    const pending = it.next();
    await q.interrupt();
    await expect(pending).rejects.toThrow(/interrupted/);
  });

  it("AbortController → the same throw", async () => {
    const abortController = new AbortController();
    const { prompt, it } = start({ abortController });
    await it.next();
    prompt.push("SCENARIO:hang");
    await it.next();
    await it.next();
    const pending = it.next();
    abortController.abort();
    await expect(pending).rejects.toThrow(/interrupted/);
  });
});
