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
 * The writer's verbatim note when it cut a payload down to the size cap —
 * carried on any kind, rendered as a footer so the cut is never silent.
 *
 * THREE FIELD NAMES, one fact. The daemon writes `truncationNote`. The run-file
 * ingest writes `truncation`, and on a `context` row `promptTruncation`, because
 * there it cuts the prompt alone and leaves the other context fields standing
 * (worker/runs/ingest.mjs finishResult). Reading only the first would make a
 * file-derived cut silent, which is the one thing this footer exists to stop.
 */
export function truncationNoteOf(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    for (const key of ["truncationNote", "truncation", "promptTruncation"]) {
      if (typeof c[key] === "string" && c[key] !== "") return c[key] as string;
    }
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
// Every session opener begins with the model-of-tom publication, headed by one
// line naming the WikiTom commit and its paths (convex/ttsSkills.ts
// modelOfTomText). There is no fallback copy: until that singleton is present
// the opener fails closed. The header records the prompt's exact publication,
// so the first row shows it as a fact instead of burying it in a long prompt.

export { modelOfTomHeadOf } from "@/convex/ttsShared";
export type { ModelOfTomHead } from "@/convex/ttsShared";

// ── The three writers of a row's content ────────────────────────────────────
// A claudeMessages row is v.any() and now has THREE authors: the session
// daemon (worker/session-host/session.mjs), the Claude run-file parser and the
// Codex run-file parser (both worker/runs/ingest.mjs). The same `kind` carries
// a different object from each, and a run file is read long after it was
// written — so every reader below takes the shapes it can meet and returns a
// value for all of them rather than throwing on the one it did not expect.

/**
 * The thinking text, complete. Claude and the daemon write `{ text }`; Codex
 * writes `{ summary: [...] }`, whose parts are either strings or the CLI's
 * `{ type: "summary_text", text }` blocks. Never cut here — thinking is the
 * agent's reasoning, and the row is the only place it is shown.
 */
export function thinkingTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (Array.isArray(c.summary)) {
      return c.summary
        .map((part) => {
          if (typeof part === "string") return part;
          const text = (part as Record<string, unknown> | null)?.text;
          return typeof text === "string" ? text : safeJson(part);
        })
        .join("\n\n");
    }
  }
  return contentToText(content);
}

/**
 * The tool input as an object where it is one. Claude and the daemon store the
 * input object itself; Codex stores the model's `arguments`, which is a JSON
 * STRING — and the 32 KB cut can leave EITHER of them a half-written one. So
 * parse only when the parse succeeds AND yields an object; otherwise the
 * string is the input, and a malformed one renders as itself rather than
 * raising on a row the reader can do nothing about.
 */
export function toolInputObjectOf(content: unknown): unknown {
  const input = toolInputOf(content);
  if (typeof input !== "string") return input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // Not JSON, or cut mid-object: the string itself is the honest answer.
  }
  return input;
}

export type ChildRunFacts = {
  childRunId: string;
  agentId?: string;
  agentType?: string;
  description?: string;
  model?: string;
  status?: string;
  totalTokens?: number;
  totalDurationMs?: number;
  totalToolUseCount?: number;
};

/**
 * A child-run row's facts, or null when the row does not name a child run.
 * The Claude parser writes this row beside the Task tool-result that launched
 * or finished the subagent; the totals are present only once it completed.
 * Every field but childRunId is optional, and absent means UNKNOWN — the
 * CALLER decides what stands in its place, because a fallback invented here
 * would be indistinguishable from a fact the file actually carried.
 */
export function childRunOf(content: unknown): ChildRunFacts | null {
  if (typeof content !== "object" || content === null) return null;
  const c = content as Record<string, unknown>;
  if (typeof c.childRunId !== "string" || c.childRunId === "") return null;
  const str = (key: string) =>
    typeof c[key] === "string" && c[key] !== "" ? (c[key] as string) : undefined;
  const num = (key: string) =>
    typeof c[key] === "number" && Number.isFinite(c[key]) ? (c[key] as number) : undefined;
  return {
    childRunId: c.childRunId,
    agentId: str("agentId"),
    agentType: str("agentType"),
    description: str("description"),
    model: str("model"),
    status: str("status"),
    totalTokens: num("totalTokens"),
    totalDurationMs: num("totalDurationMs"),
    totalToolUseCount: num("totalToolUseCount"),
  };
}

export type ContextFacts = {
  model?: string;
  host?: string;
  cwd?: string;
  layersKnown: boolean;
  layersGiven: string[];
  skillsUsed: string[];
  tools: string[];
  hooks: string[];
  prompt: string;
};

/**
 * A context row's facts. The row is the run's own `context` object plus the
 * opening prompt, so the page can say what a run was given without reading the
 * run row beside it. layersKnown is false when the row does not say — which is
 * not the same as a run that was given no layers, and a reader must be able to
 * tell those apart. The arrays filter to strings: a parser that learns a new
 * shape must not be able to put an object where a name goes.
 */
export function contextFactsOf(content: unknown): ContextFacts {
  const c =
    typeof content === "object" && content !== null
      ? (content as Record<string, unknown>)
      : {};
  const str = (key: string) =>
    typeof c[key] === "string" && c[key] !== "" ? (c[key] as string) : undefined;
  const list = (key: string) =>
    Array.isArray(c[key])
      ? (c[key] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  return {
    model: str("model") ?? str("modelRequested"),
    host: str("host"),
    cwd: str("cwd"),
    layersKnown: typeof c.layersKnown === "boolean" ? c.layersKnown : false,
    layersGiven: list("layersGiven"),
    skillsUsed: list("skillsUsed"),
    tools: list("tools"),
    hooks: list("hooks"),
    prompt: typeof c.prompt === "string" ? c.prompt : "",
  };
}

/**
 * A Claude tool result too large for the transcript points at a file on the
 * host — the CLI's `<persisted-output>` marker, which worker/runs/ingest.mjs
 * reads off the result and stores as `persistedOutput`. Nothing serves that
 * file: the page has the path and not the bytes, so this is a fact line, never
 * a link.
 *
 * THE SIZE ARRIVES AS THE CLI'S OWN STRING. The parser stores what the marker
 * said, verbatim (`{ path, sizeText }` — worker/runs/ingest.mjs persistedOutput),
 * so "1.2MB" is quoted rather than reinterpreted as a byte count nobody
 * measured. `bytes` is kept beside it for a writer that reports a number.
 */
export function persistedOutputOf(
  content: unknown,
): { path?: string; sizeText?: string; bytes?: number } | null {
  if (typeof content !== "object" || content === null) return null;
  const saved = (content as Record<string, unknown>).persistedOutput;
  if (typeof saved !== "object" || saved === null) return null;
  const s = saved as Record<string, unknown>;
  const path = typeof s.path === "string" && s.path !== "" ? s.path : undefined;
  const sizeText =
    typeof s.sizeText === "string" && s.sizeText !== "" ? s.sizeText : undefined;
  const bytes =
    typeof s.bytes === "number" && Number.isFinite(s.bytes) ? s.bytes : undefined;
  if (path === undefined && sizeText === undefined && bytes === undefined) return null;
  return {
    ...(path === undefined ? {} : { path }),
    ...(sizeText === undefined ? {} : { sizeText }),
    ...(bytes === undefined ? {} : { bytes }),
  };
}

/**
 * "340ms" / "1.2s" / "2m 04s". A duration is a fact off the file, so a
 * negative or non-finite one is not rendered as zero: it returns "" and the
 * caller shows nothing rather than a number nobody measured.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Token classes for a run status chip — the same vocabulary as
 * statusChipClass above, so a run and a session read as one surface.
 * "abandoned" and "unknown" are the muted pair: neither is a failure, both are
 * the absence of an ending, and accent stays reserved for what is live.
 */
export function runStatusChipClass(status: string): string {
  switch (status) {
    case "running":
      return "border-accent/60 text-accent";
    case "ended":
      return "border-border text-text";
    case "failed":
      return "border-error/60 text-error";
    default:
      return "border-border text-text-muted";
  }
}

/**
 * "$0.42". ABSENT MUST RETURN "": costUsd is written only when the price table
 * prices the model (worker/runs/prices.mjs returns null otherwise), so an
 * absent cost means nobody knows what the run cost — and "$0.00" would be the
 * page claiming the run was free.
 */
export function costText(costUsd?: number): string {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return "";
  return `$${costUsd.toFixed(2)}`;
}

// The list is a triage surface — needs-you outranks recency. Bands, top to
// bottom: running, spinning up, idle, over. The retired "waiting on Tom" band
// was the permission band; nothing has produced it since 2026-08-29, and an
// idle session is exactly "waiting for Tom's next turn" — so the coded order
// already is the ruling as it stands.
export const TRIAGE_BAND: Record<SessionStatus, number> = {
  running: 1,
  starting: 2,
  requested: 2,
  idle: 3,
  ended: 4,
  failed: 4,
};

/**
 * The list's triage order, as a pure sort. Within a band: the longest-waiting
 * permission sits at the very top, the terminal band reads newest-first, and
 * everything else keeps listSessions' own newest-first order (sort is stable).
 * A copy is sorted, never the caller's array.
 */
export function orderSessions<
  T extends { status: SessionStatus; statusChangedAt: number; createdAt: number },
>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const band = TRIAGE_BAND[a.status] - TRIAGE_BAND[b.status];
    if (band !== 0) return band;
    if (TRIAGE_BAND[a.status] === 0) return a.statusChangedAt - b.statusChangedAt;
    if (TRIAGE_BAND[a.status] === 4) return b.createdAt - a.createdAt;
    return 0;
  });
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
