// Shared types + helpers for the TTS Sessions surface (headless Claude Code
// sessions on the worker box; convex/claudeSessions.ts is the contract).
// Copy rules: descriptive never evaluative, plain hyphenated vocabulary.

import type { Doc } from "@/convex/_generated/dataModel";

// Age text is shared with the Inventory surface — one definition.
export { ageText } from "../tts/lib";

export type Session = Doc<"claudeSessions">;
export type Message = Doc<"claudeMessages">;
export type StreamBuf = Doc<"claudeStreamBuf">;
export type InboundRow = Doc<"claudeInbound">;
export type PermissionRow = Doc<"claudePermissions">;
export type DaemonHealth = Doc<"claudeDaemonHealth">;

export type SessionStatus = Session["status"];

// One home for the session constants: convex/ttsShared.ts (client-safe, no
// server imports). The worker daemon's literal mirrors are fenced by
// scripts/check-session-mirrors.mjs.
export {
  DAEMON_STALE_MS,
  NO_REPO,
  SESSION_REPO_NAMES,
  sessionRepoLabel,
} from "@/convex/ttsShared";

export const LIVE_STATUSES: readonly SessionStatus[] = [
  "requested",
  "starting",
  "idle",
  "running",
  "awaiting-permission",
];

export function isLive(status: SessionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

// The repo picker is SESSION_REPO_NAMES (re-exported above, straight from the
// one home) rendered as toggles: a session may hold MORE THAN ONE repo since
// Tom's 2026-08-30 ruling, so there is no single-choice list any more. Picking
// nothing IS the "none" posture — an empty scratch workspace — which is why no
// separate "none" entry appears in the picker.

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
