// fork-transcript.mjs — the file a forked session's previous transcript is
// written to, and how it is rendered.
//
// A "reopen as" (convex/claudeSessions.ts forkSessionAs, 2026-09-04) is a
// NEW session row on a different model family — the old SDK or Codex thread
// cannot be resumed by the other runner, so the transcript itself is the only
// continuity. session.mjs (#writeForkTranscript) pages the old session's rows
// off GET /sessions/transcript and writes what renderTranscript returns into
// the workdir before the first turn; the reopen prompt in claudeSessions.ts
// tells the model the file is there (and may be missing).
//
// WHY ITS OWN FILE: the same reason banned-tools.mjs is one. session.mjs
// imports the Agent SDK (installed only on the box) and lib.mjs imports the
// worker-env symlink (a plain text file on a Windows checkout), so neither
// can be loaded by the repo's vitest; this module depends on nothing and
// __tests__/fork-transcript.test.mjs pins the rendering.

// The filename inside the workdir. claudeSessions.ts names the same file in
// the reopen prompt; change both together.
export const FORK_TRANSCRIPT_FILE = ".tts-transcript.md";
// Per-row caps for the rendering: the model needs the SHAPE of what
// happened, not a 32KB grep result; anything the new session actually needs
// it can re-run.
const INPUT_PREVIEW = 300;
const RESULT_PREVIEW = 400;

// One-line preview of a value, whitespace collapsed, cut at `max`.
function preview(value, max) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value ?? "") ?? "");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

// Render transcript rows (GET /sessions/transcript shape: { seq, turn, kind,
// content, parentToolUseId?, createdAt }, seq ascending) as Markdown a model
// can read in one pass: turn headers, user and assistant text in full,
// thinking omitted (it is the old model's scratch, not the conversation),
// tool calls one line each with a truncated input, tool results truncated,
// system/error rows verbatim.
export function renderTranscript(rows, { forkedFrom } = {}) {
  const out = [
    `# Transcript of session ${forkedFrom ?? ""}`.trimEnd(),
    "",
    "This session continues the one below on a different model. Thinking is omitted; tool inputs and results are truncated.",
    "",
  ];
  let turn;
  for (const r of rows) {
    if (r.turn !== turn) {
      turn = r.turn;
      out.push(`## Turn ${turn}`, "");
    }
    const c = r.content ?? {};
    const sub = r.parentToolUseId ? " (subagent)" : "";
    switch (r.kind) {
      case "user":
        out.push("**User:**", "", String(c.text ?? ""), "");
        break;
      case "assistant-text":
        out.push(`**Assistant${sub}:**`, "", String(c.text ?? ""), "");
        break;
      case "thinking":
        break;
      case "tool-call":
        out.push(
          `- tool ${c.toolName ?? "?"}${sub}: ${preview(c.input, INPUT_PREVIEW)}`,
        );
        break;
      case "tool-result":
        out.push(
          `  - result${c.isError ? " (error)" : ""}: ${preview(c.content, RESULT_PREVIEW)}`,
        );
        break;
      case "system":
        out.push(`> system: ${String(c.text ?? "")}`, "");
        break;
      case "error":
        out.push(
          `> error: ${String(c.message ?? c.result ?? JSON.stringify(c))}`,
          "",
        );
        break;
      default:
        // "permission" (historical) and anything newer: one line, previewed.
        out.push(`> ${r.kind}: ${preview(c, INPUT_PREVIEW)}`, "");
    }
  }
  return out.join("\n") + "\n";
}
