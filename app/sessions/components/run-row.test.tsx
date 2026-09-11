// ONE TRANSCRIPT ROW, AT ALL THREE OF ITS LEVELS.
//
// The row is the whole surface's promise in miniature: everything the run did
// is on the screen, compact enough to read past and expandable down to the
// bytes the model actually saw. Three ways that promise fails silently, and a
// type checker sees none of them:
//
//   - A LEVEL COLLAPSES. If the compact line stops carrying a kind's facts, or
//     the full level opens to a preview instead of the payload, the page still
//     renders — it just quietly becomes a summary of the transcript rather than
//     the transcript. Thinking is the sharpest case: it is the agent's
//     reasoning, the row is the only place it is ever shown, and a body cut to
//     its first line would look exactly like a body shown whole. So the cases
//     below open each kind and read what came out, and the thinking case pins
//     the WHOLE string rather than a prefix.
//   - THE RAW LEVEL STOPS BEING CHECKABLE. Provenance (which file, which lines,
//     which parser) and the stored entry are what make a row verifiable against
//     the file it came from. A row with no provenance has to SAY so — an empty
//     header reads as a row nobody can question rather than a daemon row that
//     predates the cutover — and the level has to name the query that delivered
//     it, because the two doors are different surfaces with different contracts.
//   - THE FALLBACK IS MISSING. content is v.any() with THREE writers (the
//     session daemon, and the Claude and Codex parsers in worker/runs/ingest.mjs)
//     and `kind` is a union a fourth runtime will grow. A row whose kind no case
//     matches must render as itself, not throw — one unhandled kind would take
//     the whole transcript down, and the row that broke it would be exactly the
//     row nobody had seen before. That is this phase's named blocker, and it has
//     its own case below.
//
// The Codex pairs are here for the same reason lib.test.ts pins the readers: a
// row written by the other parser carries a different object under the same
// kind ({ summary: [...] } for thinking, a JSON STRING for a tool input), and a
// component that reads only Claude's shape renders a Codex run as a wall of
// blanks without failing anything.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranscriptMessage } from "../lib";

// ── The Convex stand-in ─────────────────────────────────────────────────────
// The row pulls in OverflowExpand (the control over a cut payload), which calls
// useQuery. Nothing here asks for a cut payload; the mock is what lets the row
// mount at all. Same idiom as app/tts/components/popover-contract.test.tsx.
const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    useMutation: (ref: unknown) => async () => {
      convex.calls.push(name(ref as never));
    },
  };
});

import RunRow, { type PairedResult } from "./run-row";

afterEach(cleanup);

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_757_000_000_000;

/** What worker/runs/ingest.mjs stamps on every row it parses out of a file. */
const PROVENANCE = {
  fileVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
  file: "/root/.claude/projects/tom-quest/9f2c1d.jsonl",
  lineStart: 12,
  lineEnd: 12,
  block: 0,
  parserVersion: "runs-parser-1",
  sourceKind: "assistant",
};

/** One claudeMessages row, in the shape the parsers and the daemon write. */
function row(over: Record<string, unknown>): TranscriptMessage {
  return {
    _id: "m1",
    _creationTime: 0,
    runId: "claude:box:9f2c1d",
    seq: 1000,
    turn: 1,
    kind: "system",
    content: {},
    createdAt: NOW,
    provenance: PROVENANCE,
    digest: "a1b2c3d4e5f60718",
    ...over,
  } as unknown as TranscriptMessage;
}

// ── Reading the screen ──────────────────────────────────────────────────────

const body = () => document.body.textContent ?? "";

/** The compact line's own parts — label, facts, preview — in the order shown. */
function compactLine(): string {
  const button = document.querySelector("button");
  if (button === null) throw new Error("no compact line on screen");
  return [...button.children].map((el) => el.textContent ?? "").join(" ");
}

/** Every payload block on screen: the full body, then the stored entries. */
function pres(): string[] {
  return [...document.querySelectorAll("pre")].map((el) => el.textContent ?? "");
}

/** Cycle the compact line: once opens full, twice opens raw. */
function click(times = 1) {
  for (let i = 0; i < times; i += 1) {
    const button = document.querySelector("button");
    if (button === null) throw new Error("no compact line to press");
    fireEvent.click(button);
  }
}

/** The provenance header the raw level prints for a file-derived row. */
const PROVENANCE_LINE =
  "9f2c1d.jsonl · lines 12–12 · block 0 · version 0123456789ab";

// ── One case per kind ───────────────────────────────────────────────────────

describe("a row at its three levels, one kind at a time", () => {
  it("context: the run's givens, then the opening prompt, then the stored entry", () => {
    // ingest.mjs:380 — the synthetic seq-0 row: claudeContext plus the model
    // and the prompt the run opened with.
    const content = {
      model: "claude-opus-4-6",
      layersKnown: true,
      layersGiven: ["operate", "write"],
      layersDenied: ["know"],
      skillsOffered: ["graphify"],
      skillsUsed: ["graphify"],
      tools: ["Bash", "Read"],
      hooks: [],
      cwd: "/root/tom.quest",
      prompt: "MODEL-OF-TOM FILES (WikiTom commit 0123456789ab): operate\n\nwork the batch",
    };
    render(<RunRow row={row({ seq: 0, kind: "context", content })} source="run" />);

    expect(compactLine()).toBe(
      "context claude-opus-4-6 tom.quest operate+write 1 skills 2 tools " +
        "MODEL-OF-TOM FILES (WikiTom commit 0123456789ab): operate work the batch",
    );
    expect(pres()).toEqual([]);

    click();
    expect(pres()[0]).toBe(content.prompt);

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(body()).toContain("seq 0 · read by runs.rows");
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  it("thinking: the character count, then the reasoning itself, then the stored entry", () => {
    // ingest.mjs:331 / session.mjs — { text }.
    const text = "one thought, kept whole and never summarised";
    render(<RunRow row={row({ kind: "thinking", content: { text } })} source="run" />);

    expect(text.length).toBe(44);
    expect(compactLine()).toBe(
      "thinking 44 chars one thought, kept whole and never summarised",
    );

    click();
    expect(pres()[0]).toBe(text);

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify({ text }, null, 2));
  });

  it("tool-call: the tool's name and its input, then the whole input, then the stored entry", () => {
    // ingest.mjs:334 — { id, name, input }, the input object itself.
    const content = { id: "toolu_1", name: "Bash", input: { command: "ls -la" } };
    render(<RunRow row={row({ kind: "tool-call", content })} source="run" />);

    // Bash is shown as the command it ran, not as JSON around it.
    expect(compactLine()).toBe("Bash ls -la");

    click();
    expect(pres()[0]).toBe("ls -la");

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  it("tool-result: the call it answers and the output, then the output whole, then the stored entry", () => {
    // ingest.mjs:302 — the WRAPPER: { toolUseId, content, isError }.
    const content = {
      toolUseId: "toolu_1",
      content: "file-a\nfile-b",
      isError: false,
    };
    render(
      <RunRow
        row={row({ kind: "tool-result", content })}
        toolNames={new Map([["toolu_1", "Bash"]])}
        source="run"
      />,
    );

    expect(compactLine()).toBe("→ Bash file-a file-b");

    click();
    // The tool's own output, never the wrapper serialized around it.
    expect(pres()[0]).toBe("file-a\nfile-b");

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  it("child-run: what the subagent was and what it cost, then its facts, then the stored entry", () => {
    // ingest.mjs:309 — written beside the Task tool-result that finished it.
    const content = {
      childRunId: "claude:box:9f2c1d/agent-1",
      agentId: "agent-1",
      agentType: "Explore",
      description: "find the parsers",
      model: "claude-opus-4-6",
      status: "completed",
      totalTokens: 1234,
      totalDurationMs: 5000,
      totalToolUseCount: 7,
    };
    render(<RunRow row={row({ kind: "child-run", content })} source="run" />);

    expect(compactLine()).toBe(
      "child Explore claude-opus-4-6 completed 1234 tok find the parsers",
    );

    click();
    expect(pres()[0]).toBe(JSON.stringify(content, null, 2));

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  it("system: the source line it came from, then the entry, then the stored entry", () => {
    // ingest.mjs:346 — a system line the parser kept rather than dropped.
    const content = { subtype: "init", content: "session started" };
    render(
      <RunRow
        row={row({
          kind: "system",
          content,
          provenance: { ...PROVENANCE, sourceKind: "system/init" },
        })}
        source="run"
      />,
    );

    expect(compactLine()).toBe(
      'system system/init { "subtype": "init", "content": "session started" }',
    );

    click();
    expect(pres()[0]).toBe(JSON.stringify(content, null, 2));

    click();
    expect(body()).toContain("parser runs-parser-1 · source system/init");
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  it("permission: the tool it was asked about, then the ask, then the stored entry", () => {
    // The daemon's historical shape (worker/session-host/__tests__/
    // fork-transcript.test.mjs). Nothing writes these any more.
    const content = { toolName: "Bash", status: "allowed" };
    render(<RunRow row={row({ kind: "permission", content })} source="run" />);

    expect(compactLine()).toBe(
      'permission Bash { "toolName": "Bash", "status": "allowed" }',
    );

    click();
    expect(pres()[0]).toBe(JSON.stringify(content, null, 2));

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });

  // THE BLOCKER. `kind` is a union, and a runtime this page has never met will
  // write one no case here matches. The row is labelled with the kind verbatim
  // and both levels still open — a row nobody anticipated is shown, not lost,
  // and never takes the transcript around it down with it.
  it("an unrecognised kind: the kind verbatim, then the entry, then the stored entry", () => {
    const content = { text: "a row from a runtime this page has never seen" };
    render(
      <RunRow row={row({ kind: "future-runtime-row", content })} source="run" />,
    );

    expect(compactLine()).toBe(
      "future-runtime-row a row from a runtime this page has never seen",
    );

    click();
    expect(pres()[0]).toBe("a row from a runtime this page has never seen");

    click();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });
});

// ── The blocker, stated as the thing it must not do ─────────────────────────

// witness: a switch with no default, or a reader that assumes its own kind's
// shape. THIS IS THE PHASE'S NAMED BLOCKER: a kind no union member matches must
// render, and rendering it must not throw — one unhandled kind would take down
// every row after it, and the row that did it would be the one row nobody had
// ever seen.
it("does not throw on a kind no union member matches", () => {
  expect(() =>
    render(
      <RunRow
        row={row({ kind: "future-runtime-row", content: { whatever: [1, 2] } })}
        source="run"
      />,
    ),
  ).not.toThrow();
  expect(() => click(2)).not.toThrow();
  expect(body()).toContain("future-runtime-row");
  expect(body()).toContain(PROVENANCE_LINE);
});

// ── The rows that are full already ──────────────────────────────────────────

describe("the conversation is never folded", () => {
  it("a user row shows its prompt with no click, and offers the raw level beside it", () => {
    const text = "Work the batch below with Tom.";
    render(<RunRow row={row({ kind: "user", content: { text } })} source="run" />);

    expect(screen.getByText(text)).toBeTruthy();
    const raw = screen.getByRole("button", { name: "raw" });
    expect(raw).toBeTruthy();

    fireEvent.click(raw);
    // The prose is still there; the raw level was added under it, not swapped in.
    expect(screen.getByText(text)).toBeTruthy();
    expect(body()).toContain(PROVENANCE_LINE);
    expect(screen.getByRole("button", { name: "hide the stored entry" })).toBeTruthy();
  });

  it("an assistant-text row shows its prose with no click, and offers the raw level beside it", () => {
    const text = "The parser reads the file; the row shows what it read.";
    render(
      <RunRow row={row({ kind: "assistant-text", content: { text } })} source="run" />,
    );

    expect(body()).toContain(text);
    const raw = screen.getByRole("button", { name: "raw" });
    expect(raw).toBeTruthy();

    fireEvent.click(raw);
    expect(body()).toContain(text);
    expect(body()).toContain("seq 1000 · read by runs.rows");
  });

  it("an error row is shown in full and is never folded away", () => {
    const content = { message: "model changed from opus to sonnet" };
    render(<RunRow row={row({ kind: "error", content })} source="run" />);

    expect(screen.getByText(content.message)).toBeTruthy();
    // There is no compact line to press: the only control is the raw one.
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["raw"]);

    fireEvent.click(buttons[0]);
    // Still in full, with the stored entry added under it.
    expect(screen.getByText(content.message)).toBeTruthy();
    expect(pres().at(-1)).toBe(JSON.stringify(content, null, 2));
  });
});

// ── Thinking opens complete ─────────────────────────────────────────────────

// witness: a full level that renders the preview, or a reader that cuts. The
// compact line counts CHARACTERS, so a body shorter than the count it announced
// is the row contradicting itself — which is the only way this failure is
// visible from the outside.
it("a thinking row counts its characters, and opens to every one of them", () => {
  const text = `first line\n${"x".repeat(4000)}\nlast line`;
  expect(text.length).toBe(4021);
  render(<RunRow row={row({ kind: "thinking", content: { text } })} source="run" />);

  expect(compactLine()).toBe(
    `thinking 4021 chars first line ${"x".repeat(69)}…`,
  );
  // Nothing of the reasoning is on screen yet beyond that one line.
  expect(pres()).toEqual([]);

  click();
  // The whole string, not a prefix of it.
  expect(pres()[0]).toBe(text);
  expect(pres()[0]).toHaveLength(4021);
});

// ── The retired kind ────────────────────────────────────────────────────────

it("a permission row is one line and gets no card of its own", () => {
  // The permission table is retired and nothing produces these any more
  // (§20.2). The rows that exist are history — and the record never hides a row
  // it holds, so it renders as one line like every other folded kind.
  render(
    <RunRow
      row={row({ kind: "permission", content: { toolName: "Bash", status: "allowed" } })}
      source="run"
    />,
  );

  expect(document.querySelectorAll("button")).toHaveLength(1);
  expect(pres()).toEqual([]);
  expect(compactLine()).toBe(
    'permission Bash { "toolName": "Bash", "status": "allowed" }',
  );
});

// ── The other parser's shapes ───────────────────────────────────────────────

describe("a Codex row reads the same as its Claude twin", () => {
  it("thinking: { summary: [...] } renders as { text } does", () => {
    // ingest.mjs:450 — the reasoning summary, as the CLI's own blocks.
    render(
      <RunRow
        row={row({
          kind: "thinking",
          content: {
            summary: [
              { type: "summary_text", text: "first thought" },
              { type: "summary_text", text: "second thought" },
            ],
          },
        })}
        source="run"
      />,
    );
    const codexLine = compactLine();
    click();
    const codexBody = pres()[0];
    cleanup();

    render(
      <RunRow
        row={row({
          kind: "thinking",
          content: { text: "first thought\n\nsecond thought" },
        })}
        source="run"
      />,
    );
    expect(compactLine()).toBe(codexLine);
    click();
    expect(pres()[0]).toBe(codexBody);

    expect(codexBody).toBe("first thought\n\nsecond thought");
    expect(codexLine).toBe("thinking 29 chars first thought second thought");
  });

  it("tool-call: a JSON-string input renders as the input object does", () => {
    // ingest.mjs:451 stores payload.arguments, which the CLI writes as a JSON
    // STRING — the same call from the Claude parser carries the object itself.
    render(
      <RunRow
        row={row({
          kind: "tool-call",
          content: { id: "call_1", name: "shell", input: '{"command":["ls","-la"]}' },
        })}
        source="run"
      />,
    );
    const codexLine = compactLine();
    click();
    const codexBody = pres()[0];
    cleanup();

    render(
      <RunRow
        row={row({
          kind: "tool-call",
          content: { id: "toolu_1", name: "shell", input: { command: ["ls", "-la"] } },
        })}
        source="run"
      />,
    );
    expect(compactLine()).toBe(codexLine);
    expect(pres()).toEqual([]);
    click();
    expect(pres()[0]).toBe(codexBody);

    expect(codexLine).toBe('shell { "command": [ "ls", "-la" ] }');
    expect(codexBody).toBe(JSON.stringify({ command: ["ls", "-la"] }, null, 2));
  });
});

// ── The raw level's two halves ──────────────────────────────────────────────

it("a row with no provenance says so rather than showing an empty header", () => {
  // A daemon row predates the run-file cutover: there is no file behind it, and
  // an empty header would read as a row nobody can check.
  render(
    <RunRow
      row={row({ kind: "thinking", content: { text: "a daemon row" }, provenance: undefined })}
      source="session"
    />,
  );
  click(2);

  expect(screen.getByText("daemon row · no run file")).toBeTruthy();
  expect(body()).not.toContain("parser runs-parser-1");
  expect(body()).toContain("seq 1000 · read by claudeSessions.getMessages");
});

it("the raw level names the query that delivered the row", () => {
  render(<RunRow row={row({ kind: "thinking", content: { text: "t" } })} source="run" />);
  click(2);
  expect(body()).toContain("seq 1000 · read by runs.rows");
  expect(body()).not.toContain("claudeSessions.getMessages");
  cleanup();

  render(
    <RunRow row={row({ kind: "thinking", content: { text: "t" } })} source="session" />,
  );
  click(2);
  expect(body()).toContain("seq 1000 · read by claudeSessions.getMessages");
  expect(body()).not.toContain("runs.rows");
});

// ── A call and the result that answered it ──────────────────────────────────

describe("a paired tool-call and tool-result", () => {
  const call = row({
    seq: 1000,
    kind: "tool-call",
    content: { id: "toolu_7", name: "Bash", input: { command: "pnpm test" } },
  });
  const ok = row({
    _id: "m2",
    seq: 1001,
    kind: "tool-result",
    content: { toolUseId: "toolu_7", content: "42 passed", isError: false },
    provenance: { ...PROVENANCE, lineStart: 13, lineEnd: 13, block: 1 },
    digest: "0f1e2d3c4b5a6978",
  });
  const failed = row({
    _id: "m2",
    seq: 1001,
    kind: "tool-result",
    content: { toolUseId: "toolu_7", content: "1 failed", isError: true },
    provenance: { ...PROVENANCE, lineStart: 13, lineEnd: 13, block: 1 },
  });

  it("shows how long the call took, and opens to the input and then the output", () => {
    const result: PairedResult = { row: ok, durationMs: 1200 };
    render(<RunRow row={call} result={result} source="run" />);

    expect(compactLine()).toBe("Bash 1.2s pnpm test");

    click();
    expect(pres()[0]).toBe("pnpm test\n\n→\n42 passed");
  });

  it("says the call failed when the result it is paired with is an error", () => {
    render(
      <RunRow row={call} result={{ row: failed, durationMs: 1200 }} source="run" />,
    );
    expect(compactLine()).toBe("Bash 1.2s failed pnpm test");
  });

  it("shows BOTH stored entries at the raw level, each naming its own seq", () => {
    render(<RunRow row={call} result={{ row: ok, durationMs: 1200 }} source="run" />);
    click(2);

    expect(body()).toContain("seq 1000 · read by runs.rows");
    expect(body()).toContain("seq 1001 · read by runs.rows");
    expect(body()).toContain(PROVENANCE_LINE);
    expect(body()).toContain(
      "9f2c1d.jsonl · lines 13–13 · block 1 · version 0123456789ab",
    );
    // The call's entry and the result's entry, both of them, verbatim.
    expect(pres()).toContain(JSON.stringify(call.content, null, 2));
    expect(pres()).toContain(JSON.stringify(ok.content, null, 2));
  });
});

// ── The pointer at a file nothing serves ────────────────────────────────────

it("a persisted output is a fact line and never a link", () => {
  // ingest.mjs:303 — a Claude tool result too large for the transcript points
  // at a file on the Jarvis Box. Nothing serves that file, so a link would go
  // nowhere and say it went somewhere.
  const content = {
    toolUseId: "toolu_9",
    content:
      "<persisted-output>\nOutput too large (1.2MB). Full output saved to: /root/.claude/tool-results/toolu_9.txt\n",
    isError: false,
    persistedOutput: {
      path: "/root/.claude/tool-results/toolu_9.txt",
      sizeText: "1.2MB",
    },
  };
  render(<RunRow row={row({ kind: "tool-result", content })} source="run" />);
  click();

  expect(screen.getByText("persisted output · toolu_9.txt · 1.2MB")).toBeTruthy();
  expect(document.querySelector("a")).toBeNull();
});
