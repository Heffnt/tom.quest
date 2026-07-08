"use client";

// CountBadge — the shared "×n" stack-count mark (DESIGN.md §1 "item").
//
// The count of an item's copies "sits on or outside the square's edge, never
// inside it" — this is the one small mark that renders that fact everywhere a
// stack shows up: the carried hand (lib/use-hand.tsx HandGhost), an in-brew
// chip and a cauldron perfume (components/brew-graph.tsx ItemChip /
// TintedPerfume), a presence cursor's held stack (components/cursors.tsx), and
// an item frame's owned-count corner (components/item-frame.tsx
// FrameCountBadge). Those five call sites had drifted into near-identical but
// not-quite-identical class strings; this component is the one canonical
// definition, parameterized only by the two things that actually differ:
//
//   - `variant`
//     - "chip" (default) — the free-floating mark pinned to an icon's corner
//       via `-translate` offsets (hand ghost, in-brew chip, cauldron perfume,
//       presence cursor): `rounded-full border border-border bg-surface px-1
//       font-mono text-[10px] font-bold text-text`. Renders nothing for
//       count <= 1 (a lone copy needs no count).
//     - "frame" — the item-frame owned-count corner (FrameCountBadge): a
//       squarer `rounded` chip (`border-border/70`, `bg-surface/95`,
//       `leading-4 tabular-nums`) anchored inside the frame's own relative
//       box rather than translated off an icon corner. Renders for any
//       count > 0 (an inventory frame shows "×1" same as "×3" — the frame
//       state itself, not the mark, is what says "one copy").
//   - `size` — "md" (default, text-[10px], the icon/chip/perfume/frame case)
//     or "sm" (text-[9px], the presence-cursor case, whose icon renders
//     smaller so its mark does too).
//
// Placement (the `-right-2 -top-2` / `-right-1.5 -top-1.5` / `absolute
// bottom-0.5 right-0.5` offsets, which differ per call site's icon size and
// layout) is NOT baked in here — callers compose it via `className`, since it
// never collides with the badge's own color/border/type utilities.

import type { ReactNode } from "react";
import { cn } from "./ui";

export type CountBadgeVariant = "chip" | "frame";
export type CountBadgeSize = "sm" | "md";

export interface CountBadgeProps {
  /** The stack size to show as "×n". */
  count: number;
  /** "chip" (default): rounded-full mark for a carried/graph/cauldron/cursor
   *  icon, hidden at count<=1. "frame": the item-frame owned-count corner,
   *  a squarer mark shown for any count>0. */
  variant?: CountBadgeVariant;
  /** "md" (default) is text-[10px]; "sm" is text-[9px] for a smaller icon
   *  (the presence-cursor held stack). */
  size?: CountBadgeSize;
  /** Placement/layout classes (e.g. "absolute -right-2 -top-2") — additive,
   *  composed alongside the variant's own look. */
  className?: string;
  /** aria-hidden by default (the mark is decorative next to a labeled icon);
   *  pass false when the badge is the only carrier of the count. */
  "aria-hidden"?: boolean;
  children?: ReactNode;
}

/** The shared "×n" stack-count mark — see file header for the variant/size
 * rationale and which existing call site each maps to. */
export function CountBadge({
  count,
  variant = "chip",
  size = "md",
  className,
  "aria-hidden": ariaHidden = true,
}: CountBadgeProps) {
  const visible = variant === "frame" ? count > 0 : count > 1;
  if (!visible) return null;

  const text = size === "sm" ? "text-[9px]" : "text-[10px]";

  return (
    <span
      aria-hidden={ariaHidden}
      className={cn(
        "pointer-events-none font-mono font-bold text-text",
        text,
        variant === "frame"
          ? "rounded border border-border/70 bg-surface/95 px-1 leading-4 tabular-nums"
          : "rounded-full border border-border bg-surface px-1",
        className,
      )}
    >
      ×{count}
    </span>
  );
}

export default CountBadge;
