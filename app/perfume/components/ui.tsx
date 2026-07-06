"use client";

// Shared button/tab treatment for the /perfume shell (DESIGN.md §7 — the one
// sanctioned aesthetic change: a "feel refresh for buttons and tabs within the
// current look"). This is NOT a restyle: the dark-slate palette, the accent, the
// radii family and the mono type all stay. What this module standardizes is the
// interaction feel — crisper hover / active / focus-visible states, consistent
// radii and weights — so every control in the new shell (top bar, drawer
// handles, settings corner) reads as one system.
//
// USAGE for later phases: import the class strings below and drop them on a
// <button>. They are plain Tailwind utility bundles (no runtime, tree-shake with
// the page). Compose with `cn(...)` when you need to add per-call layout/size.
//
//   <button className={cn(btn.ghost, "px-2.5 py-1")}>…</button>
//
// The vocabulary here is presentational only and coins no domain identifiers.

import type {
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

/** Tiny classnames joiner (no dependency). Falsy entries are dropped. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── the shared interaction base ──────────────────────────────────────────────
// Every button/tab shares this: consistent transition, a crisp keyboard ring
// that never shows on mouse (focus-visible only), and a subtle press feedback.
// Radius/weight/type live in the variants so callers pick the right "size" of
// control without re-deriving the feel.

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

const BASE = cn(
  "inline-flex items-center justify-center gap-1.5 select-none",
  "font-mono transition-[color,background-color,border-color,box-shadow,transform] duration-150",
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
  FOCUS,
);

// ── button variants ──────────────────────────────────────────────────────────
// Each is a complete, ready-to-drop class string. Sizes are folded in so the
// shell stays consistent; add layout-only classes (widths, margins) at the call
// site if needed.

export const btn = {
  /** Low-emphasis control on a bare surface (icon buttons, menu rows). */
  ghost: cn(
    BASE,
    "rounded-md border border-transparent px-2.5 py-1 text-xs text-text-muted",
    "hover:bg-surface-alt/70 hover:text-text",
    "aria-pressed:bg-surface-alt aria-pressed:text-text",
  ),
  /** Bordered neutral control (the '+' create, secondary menu actions). */
  outline: cn(
    BASE,
    "rounded-md border border-border px-2.5 py-1 text-xs text-text-muted",
    "hover:border-accent/60 hover:text-text",
  ),
  /** The one accented call-to-action (join the party, confirm). */
  accent: cn(
    BASE,
    "rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent",
    "hover:bg-accent/20 hover:border-accent",
  ),
  /** Destructive menu action (delete). Error tint, subtle until hovered. */
  danger: cn(
    BASE,
    "rounded-md border border-transparent px-2.5 py-1 text-xs text-text-muted",
    "hover:bg-error/10 hover:text-error",
  ),
  /** A small square icon button (gear, '+', chevrons). Pair with an h/w. */
  icon: cn(
    BASE,
    "rounded-md border border-border text-text-muted",
    "hover:border-accent hover:text-accent",
    "aria-pressed:border-accent aria-pressed:text-accent",
  ),
} as const;

// ── tab / chip treatment ─────────────────────────────────────────────────────
// The selected pill sits on surface-alt; the rest are quiet until hovered. Used
// by the top bar's brew chips and the input-panel tabs alike.

export const tab = {
  /** A selectable pill (brew chip, input tab). Drive selection with
   *  aria-pressed / data-active for the active treatment. */
  base: cn(
    BASE,
    "rounded-md px-2.5 py-1 text-xs text-text-muted",
    "hover:bg-surface-alt/60 hover:text-text",
    "aria-pressed:bg-surface-alt aria-pressed:text-text",
    "data-[active=true]:bg-surface-alt data-[active=true]:text-text",
  ),
} as const;

// ── the drawer edge-tab handle (narrow layout) ───────────────────────────────
// A vertical tab clinging to the viewport edge that opens an overlay drawer.
// Kept here so the feel matches the rest of the shell.

export const drawerHandle = cn(
  BASE,
  "flex-col rounded-md border border-border bg-surface/90 px-1.5 py-3 text-[10px] uppercase tracking-wider text-text-muted backdrop-blur",
  "hover:border-accent/60 hover:text-text",
  "aria-pressed:border-accent aria-pressed:text-accent",
);

// ── a convenience <Button> for the shell's own use ───────────────────────────
// Later phases can keep using the raw class strings; this wrapper just saves the
// shell files a few lines. `variant` picks a bundle; extra className composes.

type Variant = keyof typeof btn;

export function Button({
  variant = "ghost",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children?: ReactNode;
}) {
  return (
    <button type="button" className={cn(btn[variant], className)} {...rest}>
      {children}
    </button>
  );
}
