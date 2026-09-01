"use client";

// THE ONE INFO MECHANISM (ratified by Tom, 2026-08-29; built 2026-08-30).
//
// The rule, verbatim from CLAUDE.md: "One info mechanism: a tap-to-open
// popover (never hover-only, never native `title=` — both are dead on touch).
// Content is a plain-language explanation of what the control does on the
// backend, with the exact function call in small mono."
//
// What this replaces: a hover-only tooltip showing nothing but the function
// name. On a touch screen it could not be opened at all, and on a desktop it
// answered the wrong question — `tts.deleteBlock({id})` tells a reader who
// already knows the codebase what they already knew, and tells everyone else
// nothing. So the call is still here, in small mono, but it is the FOOTNOTE:
// the body is one or two plain sentences about what pressing the neighbouring
// control actually does.
//
// Three properties the ratified UI rules require, each load-bearing here:
//   - TAP, not hover. `open` is state, flipped by a click.
//   - NO LAYOUT SHIFT. The panel is absolutely positioned, so opening it never
//     moves the control the reader was aiming at.
//   - VISIBLY CLICKABLE. The ⓘ changes on hover and again while open; it is a
//     control, not decoration, and accent alone would not say so.

import { useEffect, useRef, useState } from "react";

export default function Info({
  call,
  children,
  label,
}: {
  /** The exact backend call the neighbouring control fires (UI = code). */
  call?: string;
  /** Plain language: what that call does. One or two sentences. */
  children?: React.ReactNode;
  /**
   * MIGRATION SHIM. The pre-popover call sites passed only `label`, holding
   * the function call and nothing else. A site still using it renders the call
   * with no explanation — honest about being unmigrated rather than inventing
   * prose for it. Delete this prop when the last one is gone (ledger:
   * info-captions-unmigrated).
   */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close on Escape or on a press anywhere else. Both are what a reader
  // expects of an opened panel, and without them the only way out is pressing
  // the same small target again.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  const callText = call ?? label;

  return (
    <span ref={wrapRef} className="relative inline-flex items-baseline">
      <button
        type="button"
        aria-expanded={open}
        aria-label="what this does"
        onClick={(e) => {
          // The ⓘ frequently sits inside a row that is itself clickable
          // (a todo opens its detail). Without this, asking what a control
          // does would also fire it.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`text-[10px] leading-none rounded-full px-1 py-0.5 transition-colors ${
          open
            ? "text-accent bg-accent-dim"
            : "text-text-faint hover:text-text hover:bg-surface-alt"
        }`}
      >
        ⓘ
      </button>
      {open && (
        // Absolutely positioned, so nothing below it moves. Opens ABOVE the
        // control, left-aligned to it, and clamped to a readable width — a
        // panel as wide as its longest line is unreadable at these sizes.
        <span
          role="note"
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 mb-1.5 z-40 w-64 max-w-[80vw] rounded-md border border-border bg-surface shadow-lg p-2.5 text-left"
        >
          {children && (
            <span className="block text-xs leading-relaxed text-text">
              {children}
            </span>
          )}
          {callText && (
            <span
              className={`block font-mono text-[10px] leading-snug text-text-muted break-all ${
                children ? "mt-2 pt-2 border-t border-border" : ""
              }`}
            >
              {callText}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
