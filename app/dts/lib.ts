// Shared types + date/age helpers for the /dts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts dtsTodos).

import type { Doc } from "@/convex/_generated/dataModel";

export type Todo = Doc<"dtsTodos">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;

// The intent vocabulary is owned by convex/dtsShared.ts (dtsItemLink is the
// single producer of ?item=&intent= links); this is just its local name.
export type { DtsLinkIntent as LinkIntent } from "@/convex/dtsShared";

/** "Aug 30, 2026" — absolute date, shown small/faint next to countdown text. */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "2026-08-30" in local time — for date-history lines and date-input prefills. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * <input type="date"> value → epoch ms at noon LOCAL time (avoids the
 * UTC-midnight off-by-one when the value round-trips through a date key).
 */
export function parseDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T12:00:00`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Descriptive age: "12 min ago", "3 h ago", "1 day ago", "41 days ago". */
export function ageText(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
