// Shared types + helpers for the TTS Sessions surface (headless Claude Code
// sessions on the Jarvis Box; convex/claudeSessions.ts is the contract).
// Copy rules: descriptive never evaluative, plain hyphenated vocabulary.

import type { Doc } from "@/convex/_generated/dataModel";

// Age text is shared with the Inventory surface — one definition.
export { ageText } from "../tts/lib";

export type Session = Doc<"claudeSessions">;
export type Message = Doc<"claudeMessages">;
export type StreamBuf = Doc<"claudeStreamBuf">;
export type InboundRow = Doc<"claudeInbound">;
export type DaemonHealth = Doc<"claudeDaemonHealth">;

/**
 * A finalized row AS THE PAGE READS IT. claudeSessions.getMessages adds two
 * fields to every row it returns, and both are about the daemon's 32 KB cut:
 * whether anything was cut at all, and how many bytes the whole payload is —
 * so a row can offer to fetch the rest without fetching it to find out.
 * The bytes themselves come from claudeSessions.getMessageOverflow, a page at
 * a time (./components/overflow-expand).
 */
export type TranscriptMessage = Message & {
  hasOverflow?: boolean;
  fullByteLength?: number;
};

export type SessionStatus = Session["status"];

// One home for the session constants: convex/ttsShared.ts (client-safe, no
// server imports) — the staleness window, and the live-status list this page
// and convex/claudeSessions.ts must agree on. The worker daemon's literal
// mirrors are fenced by scripts/check-session-mirrors.mjs, which also fails if
// a second LIVE_STATUSES reappears here.
export { DAEMON_STALE_MS, LIVE_STATUSES, isLive } from "@/convex/ttsShared";
import {
  LEGACY_SESSION_MODEL,
  NO_REPO,
  SESSION_REPO_NAMES,
} from "@/convex/ttsShared";
// The header line the prelude carries, spelled once in the client-safe home
// (convex/ttsSkills.ts writes it into the prompt; modelOfTomHeadOf below reads
// it back off the row).
import { MODEL_OF_TOM_HEADER } from "@/convex/ttsShared";
import type { SessionModel } from "@/convex/ttsShared";

// The model list, its default and its family test all come from the one home
// (convex/ttsShared.ts) — this surface re-exports rather than re-listing, so a
// new model appears in every picker the moment it is added there.
export {
  DEFAULT_SESSION_MODEL,
  SESSION_MODEL_NAMES,
  modelFamily,
} from "@/convex/ttsShared";
export type { SessionModel } from "@/convex/ttsShared";

export const REPO_OPTIONS = [...SESSION_REPO_NAMES, NO_REPO] as const;

/**
 * Which model a session row runs on, for display. A row written before models
 * existed has the field absent and ran on the Claude account default — which
 * is exactly what ttsShared's modelFamily() reads absent as, so the surface
 * shows that model's name rather than a blank. The name itself has one home
 * (LEGACY_SESSION_MODEL), so it is never spelled twice.
 */
export function sessionModel(session: { model?: SessionModel }): SessionModel {
  return session.model ?? LEGACY_SESSION_MODEL;
}

/**
 * The model chip. Deliberately the SAME chip as `kind` and `autonomous`: the
 * model NAME is the signal, and the family is legible from the name itself
 * ("opus" vs "gpt-5.6-sol"). No family colour — colour alone would be the only
 * signal for a reader who cannot see it, and the ratified rules reserve accent
 * for state.
 */
export const MODEL_CHIP_CLASS =
  "border border-border rounded px-1.5 py-0.5 text-xs text-text-muted";

/** Token classes for the status chip — dark tokens only. */
export function statusChipClass(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "border-accent/60 text-accent";
    case "awaiting-permission":
      return "border-accent text-accent bg-accent-dim";
    case "idle":
      return "border-border text-text";
    case "requested":
    case "starting":
      return "border-border text-text-muted";
    case "failed":
      return "border-error/60 text-error";
    case "ended":
      return "border-border text-text-faint";
  }
}

/** Compact age: "just now", "4m", "3h", "2d" — for "waiting 4m" style copy. */
export function shortAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// contentToText / previewLine below are the client-side twins of contentText
// / previewText in convex/claudeSessions.ts. Deliberately named apart so a
// reader is never unsure which side they are looking at: the server pair
// flattens for stored previews (fixed PREVIEW_CHARS cap, no whitespace
// collapsing), this pair renders for the screen (caller-chosen max, newlines
// collapsed). Same job, different cut — keep the two comments in lockstep if
// either behaviour moves.

/**
 * Message content is v.any(). Render strings directly; anything else via
 * JSON.stringify (never String(x) — that gives "[object Object]").
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (
    typeof content === "object" &&
    "text" in (content as Record<string, unknown>) &&
    typeof (content as Record<string, unknown>).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return "(unrenderable content)";
  }
}

/** One-line preview: newlines collapsed, truncated. */
export function previewLine(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Best-effort tool name out of a tool-call / permission content payload. */
export function toolNameOf(content: unknown): string {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    for (const key of ["toolName", "name", "tool"]) {
      if (typeof c[key] === "string") return c[key] as string;
    }
  }
  return "tool";
}

/**
 * Best-effort tool-use id out of a tool-call content payload — the id a
 * subagent row's parentToolUseId points back at. content is v.any(), so the
 * same closed-list idiom as toolNameOf rather than one assumed field name.
 */
export function toolUseIdOf(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    for (const key of ["toolUseId", "tool_use_id", "id"]) {
      if (typeof c[key] === "string") return c[key] as string;
    }
  }
  return undefined;
}

/** Best-effort tool input out of a tool-call content payload. */
export function toolInputOf(content: unknown): unknown {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    if ("input" in c) return c.input;
  }
  return content;
}

/**
 * The subagent type of a Task tool-call. `subagent_type` is the SDK's own
 * input field name and is quoted as-is — the surface never renames it.
 */
export function subagentTypeOf(content: unknown): string | undefined {
  const input = toolInputOf(content);
  if (typeof input === "object" && input !== null) {
    const i = input as Record<string, unknown>;
    if (typeof i.subagent_type === "string") return i.subagent_type;
  }
  return undefined;
}

/**
 * What a Task tool-call said the subagent is for — the SDK's own `description`
 * input, quoted as-is. It is the line the retired agent panel showed beside a
 * running subagent; the transcript's fold shows it now, from the same row.
 */
export function taskDescriptionOf(content: unknown): string | undefined {
  const input = toolInputOf(content);
  if (typeof input === "object" && input !== null) {
    const i = input as Record<string, unknown>;
    if (typeof i.description === "string" && i.description !== "") {
      return i.description;
    }
  }
  return undefined;
}

// ── tool-result / error unwrapping ───────────────────────────────────────────
// A tool-result row's content is the daemon's WRAPPER object
// ({ toolUseId, content, isError?, truncationNote? }), not the tool output.
// contentToText on the wrapper serializes the scaffolding — the exact defect
// the render-honesty round removed. These three read the wrapper's fields.
// Both shapes of the inner content are handled: the daemon now flattens to a
// plain string, but rows written before that fix still carry the SDK's array
// of typed blocks.

/**
 * The tool output itself, as plain text. Never the serialized wrapper: string
 * content passes through, a block array joins its items' `.text` (non-text
 * blocks via JSON.stringify), anything else is JSON.
 */
export function toolResultTextOf(content: unknown): string {
  const inner =
    typeof content === "object" && content !== null && "content" in content
      ? (content as { content: unknown }).content
      : content;
  if (typeof inner === "string") return inner;
  if (Array.isArray(inner)) {
    return inner
      .map((b) => {
        const text = (b as Record<string, unknown> | null)?.text;
        return typeof text === "string" ? text : safeJson(b);
      })
      .join("\n");
  }
  if (inner === null || inner === undefined) return "";
  return safeJson(inner);
}

/** Whether the daemon marked this tool result as a failure. */
export function isErrorOf(content: unknown): boolean {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as Record<string, unknown>).isError === true
  );
}

/**
 * The daemon's verbatim note when it cut a payload down to the size cap —
 * carried on any kind, rendered as a footer so the cut is never silent.
 */
export function truncationNoteOf(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null) {
    const note = (content as Record<string, unknown>).truncationNote;
    if (typeof note === "string") return note;
  }
  return undefined;
}

/**
 * Error-row text. The daemon writes two shapes: `{ message }` (its own
 * failures) and `{ subtype, result, total_cost_usd }` (an SDK error result,
 * the one place cost is persisted). Both render as prose, never as JSON.
 */
export function errorTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    if (typeof c.message === "string") return c.message;
    if (typeof c.subtype === "string") {
      const result =
        typeof c.result === "string" ? c.result : contentToText(c.result);
      const head = result === "" ? c.subtype : `${c.subtype}: ${result}`;
      return typeof c.total_cost_usd === "number"
        ? `${head}\ncost $${c.total_cost_usd}`
        : head;
    }
  }
  return contentToText(content);
}

/** JSON.stringify that never throws (cycles, BigInt) — used by the unwrappers. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "(unrenderable content)";
  }
}

/**
 * Local wall-clock "14:05" — 24-hour, zero-padded, no Intl (the surface must
 * render identically on the server pass and in the browser).
 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── The cut payload, and what a reassembly is allowed to claim ──────────────
// The daemon cuts any payload over 32 KB and stores the whole of it in chunks
// (claudeMessageOverflow). One read returns up to 1 MB and hands back a cursor,
// so a large payload takes several — and the page has to say, on the row,
// whether what it is showing is the whole thing. Three claims, and they are
// not the same claim:
//   complete   — the read came back whole IN ONE CALL and the server checked
//                its bytes AND its hash against the row's stamp
//                (claudeSessions.messageOverflow). The strongest, and the only
//                one that says the text was verified.
//   whole      — every chunk came back over several reads and the bytes sum to
//                the stamp's byteLength. The hash is not re-checked across
//                pages, so this says so rather than borrowing the word.
//   incomplete — the walk stopped at a missing chunk, or the bytes do not sum,
//                or the hash was checked and did not match.
// Counting chunks would call a hole complete, which is why every claim here is
// about BYTES against the row's own stamp.
//
// THE MISMATCH (review finding). The server computes `complete` only when the
// read started at index 0, reached the end, and the bytes summed — and then it
// is the sha256 comparison itself (convex/claudeSessions.ts messageOverflow).
// So a SINGLE read that ended, whose bytes equal the stamp, with complete
// false, is not a payload the hash was never checked on: it is a payload whose
// hash was checked and DID NOT MATCH. Saying "complete" there would be the
// worst lie this function can tell — corrupted bytes announced as verified.

export type OverflowProgress = {
  /** UTF-8 bytes reassembled so far, summed by the caller across reads. */
  bytes: number;
  /** What the row's stamp says the whole payload is. */
  byteLength?: number;
  /** The last read reached the final chunk the row names. */
  end: boolean;
  /** The server verified the whole payload's bytes and hash in one read. */
  complete: boolean;
  /** How many reads it took. */
  reads: number;
  /** A read is still in flight. */
  reading: boolean;
};

export function describeOverflow(p: OverflowProgress): string {
  const of = p.byteLength === undefined ? "" : ` of ${p.byteLength}`;
  if (p.reading) return `reading — ${p.bytes}${of} bytes so far`;
  if (p.complete) return `complete — ${p.bytes} bytes, checked against the stored hash`;
  if (p.end && p.byteLength !== undefined && p.bytes === p.byteLength) {
    // One read, ended, bytes summed, and the server still said not complete:
    // the hash was compared and came back different (see the note above).
    if (p.reads <= 1) {
      return `incomplete — ${p.bytes} bytes came back but they do not match the stored hash`;
    }
    return `complete — ${p.bytes} bytes in ${p.reads} reads; the hash is checked only when the whole payload comes back in one read`;
  }
  if (!p.end) {
    return `incomplete — the stored chunks stop after ${p.bytes}${of} bytes; one is missing`;
  }
  return `incomplete — ${p.bytes}${of} bytes came back`;
}

// ── The model-of-tom prelude, as a transcript row reads it ──────────────────
// Every session opener begins with the model-of-tom files, headed by one line
// naming the WikiTom commit they were read at and listing their paths
// (convex/ttsSkills.ts modelOfTomText). That header is how a transcript
// records what the session began with, so the first row shows it as a fact of
// its own instead of burying it in the first line of a long prompt.

export type ModelOfTomHead = {
  /** null while the fallback copy is serving (no commit was recorded). */
  commit: string | null;
  paths: string[];
};

/** The header of a prompt that carries the prelude, or null if it does not. */
export function modelOfTomHeadOf(text: string): ModelOfTomHead | null {
  const line = text.split("\n", 1)[0] ?? "";
  if (!line.startsWith(MODEL_OF_TOM_HEADER)) return null;
  const commit = /WikiTom commit ([0-9a-f]{7,40})/i.exec(line)?.[1] ?? null;
  const paths = (/\):\s*(.+)$/.exec(line)?.[1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return { commit, paths };
}

/**
 * Compact rendering of a permission/tool input: for Bash show the command
 * itself; otherwise pretty-printed JSON.
 */
export function compactInput(toolName: string, input: unknown): string {
  if (
    toolName.toLowerCase() === "bash" &&
    typeof input === "object" &&
    input !== null &&
    typeof (input as Record<string, unknown>).command === "string"
  ) {
    return (input as { command: string }).command;
  }
  return contentToText(input);
}
