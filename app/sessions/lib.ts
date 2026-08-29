// Shared types + helpers for the DTS Sessions surface (headless Claude Code
// sessions on the worker box; convex/claudeSessions.ts is the contract).
// Copy rules: descriptive never evaluative, plain hyphenated vocabulary.

import type { Doc } from "@/convex/_generated/dataModel";

// Age text is shared with the Inventory surface — one definition.
export { ageText } from "../dts/lib";

export type Session = Doc<"claudeSessions">;
export type Message = Doc<"claudeMessages">;
export type StreamBuf = Doc<"claudeStreamBuf">;
export type InboundRow = Doc<"claudeInbound">;
export type PermissionRow = Doc<"claudePermissions">;
export type DaemonHealth = Doc<"claudeDaemonHealth">;

export type SessionStatus = Session["status"];

// Mirrors DAEMON_STALE_MS = 90_000 in convex/claudeSessions.ts (a Convex
// module cannot be imported into client bundles without pulling server code
// along). Three missed 30s heartbeats before the surface calls the worker
// stale — keep the two constants in lockstep.
export const DAEMON_STALE_MS = 90_000;

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

export const REPO_OPTIONS = [
  "tom.quest",
  "ComplexMultiTrigger",
  "WikiTom",
  "none",
] as const;

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
