import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/temp.mjs";
import {
  REPLAY_NO_REF,
  REPLAY_NO_REQUEST,
  REPLAY_NO_SESSION,
  renderSession,
  replayContext,
  requestIndex,
  sessionArchiveDir,
  sessionRefOf,
  toolsAfterRequest,
} from "./evals-replay.mjs";

function tree() {
  return tempDir("evals-replay-");
}

/** A session in the archive, at the day the caller names. Entries are written
 *  one per line, so an entry's 1-based line is its index plus one. */
function archive(dir, { session, day = "2026/08/16", entries }) {
  const home = path.join(dir, "sessions", ...day.split("/"), `claude-${session}`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "session.jsonl.gz"),
    zlib.gzipSync(entries.map((entry) => JSON.stringify(entry)).join("\n")),
  );
  return home;
}

const tom = (text) => ({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text } });
const said = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const used = (name, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const returned = (text) => ({ type: "user", message: { content: [{ type: "tool_result", content: text }] } });

const SESSION = "ba5da329-eb12-4446-916d-1dd694df76dc";
const item = (over = {}) => ({
  id: "explanation-x1",
  job: "explanation",
  sentence: "this is too dense",
  input: { topic: "pooled AUROC", contextLines: [] },
  provenance: { session: `C--Users-heffn-Desktop\\${SESSION}.jsonl line 5` },
  ...over,
});

describe("sessionRefOf", () => {
  it("reads the session id and the reaction line out of the provenance string", () => {
    expect(sessionRefOf(item())).toEqual({ session: SESSION, line: 5 });
  });

  it("answers null for an item that cites nothing, a line of 1, or no line", () => {
    expect(sessionRefOf({ provenance: {} })).toBeNull();
    expect(sessionRefOf({ provenance: { session: "no id here line 5" } })).toBeNull();
    // Line 1 would leave nothing before the reaction to read.
    expect(sessionRefOf(item({ provenance: { session: `${SESSION}.jsonl line 1` } }))).toBeNull();
    expect(sessionRefOf(item({ provenance: { session: `${SESSION}.jsonl` } }))).toBeNull();
  });
});

describe("sessionArchiveDir", () => {
  it("finds a session filed under a day that is not the item's own", () => {
    const dir = tree();
    const home = archive(dir, { session: SESSION, day: "2026/08/16", entries: [tom("hello")] });
    expect(sessionArchiveDir(dir, SESSION)).toBe(home);
  });

  it("answers null for a tree with no archive and for a session not in it", () => {
    const empty = tree();
    expect(sessionArchiveDir(empty, SESSION)).toBeNull();
    archive(empty, { session: SESSION, entries: [tom("hello")] });
    expect(sessionArchiveDir(empty, "0000aaaa-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("the request boundary", () => {
  // 1 Tom asks, 2 the agent answers, 3 the agent explains, 4 Tom reacts.
  const entries = [tom("what is a pooled AUROC"), said("let me think"), said("the explanation"), tom("too dense")];

  it("names the last thing Tom typed before the reaction", () => {
    expect(requestIndex(entries, 4)).toBe(0);
  });

  it("answers -1 when nothing before the reaction is Tom's", () => {
    expect(requestIndex([said("a"), said("b"), tom("react")], 3)).toBe(-1);
  });

  it("counts the tools the agent used after the request and before the reaction", () => {
    const withTools = [tom("read this"), used("Read", { file: "x" }), returned("contents"), said("done"), tom("react")];
    expect(toolsAfterRequest(withTools, 0, 5)).toEqual(["Read"]);
  });

  it("counts no tool the agent used BEFORE the request, because the session carries what it returned", () => {
    const before = [tom("read this"), used("Read"), returned("contents"), said("done"), tom("now explain"), said("explaining"), tom("react")];
    expect(toolsAfterRequest(before, 4, 7)).toEqual([]);
  });
});

describe("renderSession", () => {
  it("names Tom, the agent and each tool call beside what it returned", () => {
    const entries = [tom("read this"), used("Read", { file: "x" }), returned("the contents"), said("done"), tom("now explain")];
    const text = renderSession(entries, 4).join("\n");
    expect(text).toContain("Tom:\nread this");
    expect(text).toContain("You used Read:");
    expect(text).toContain("It returned:\nthe contents");
    expect(text).toContain("You:\ndone");
    expect(text).toContain("Tom:\nnow explain");
  });

  it("leaves out a sidechain, which the parent only ever saw as a tool result", () => {
    const entries = [tom("ask"), { ...said("subagent working"), isSidechain: true }, tom("now explain")];
    expect(renderSession(entries, 2).join("\n")).not.toContain("subagent working");
  });
});

describe("replayContext", () => {
  it("carries the whole session before the request", () => {
    const dir = tree();
    archive(dir, {
      session: SESSION,
      entries: [tom("read this"), used("Read"), returned("the handoff"), said("read it"), tom("now explain"), said("THE EXPLANATION"), tom("too dense")],
    });
    const found = replayContext(dir, item({ provenance: { session: `${SESSION}.jsonl line 7` } }));
    const text = found.lines.join("\n");
    expect(found.requestLine).toBe(5);
    expect(text).toContain("the handoff");
    expect(text).toContain("now explain");
    expect(text).not.toContain("THE EXPLANATION");
    expect(text).not.toContain("too dense");
  });

  it("refuses an item whose explanation rests on a tool call made after the request", () => {
    const dir = tree();
    archive(dir, {
      session: SESSION,
      entries: [tom("explain this file"), used("Read", { file: "x" }), returned("contents"), said("THE EXPLANATION"), tom("too dense")],
    });
    const found = replayContext(dir, item({ provenance: { session: `${SESSION}.jsonl line 5` } }));
    expect(found.lines).toBeUndefined();
    expect(found.unreplayable).toContain("1 tool call");
    expect(found.unreplayable).toContain("Read");
  });

  it("refuses an item whose input does not fit one prompt, rather than trimming it", () => {
    const dir = tree();
    archive(dir, { session: SESSION, entries: [tom("x".repeat(400)), said("THE EXPLANATION"), tom("too dense")] });
    const found = replayContext(dir, item({ provenance: { session: `${SESSION}.jsonl line 3` } }), { maxChars: 100 });
    expect(found.lines).toBeUndefined();
    expect(found.unreplayable).toContain("over the 100");
  });

  it("refuses an item whose own session already carries the sentence it is labelled by", () => {
    const dir = tree();
    archive(dir, { session: SESSION, entries: [tom("this is too dense, try again"), said("THE EXPLANATION"), tom("this is too dense")] });
    const found = replayContext(dir, item({ provenance: { session: `${SESSION}.jsonl line 3` } }));
    expect(found.unreplayable).toContain("sentence the item is labelled by");
  });

  it("names which of the three absences it met", () => {
    const dir = tree();
    expect(replayContext(dir, { provenance: {} }).unreplayable).toBe(REPLAY_NO_REF);
    expect(replayContext(dir, item()).unreplayable).toBe(REPLAY_NO_SESSION);
    archive(dir, { session: SESSION, entries: [said("a"), said("b"), said("c"), said("d"), tom("react")] });
    expect(replayContext(dir, item()).unreplayable).toBe(REPLAY_NO_REQUEST);
  });
});
