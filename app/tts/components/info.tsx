"use client";

// THE ONE INFO MECHANISM (ratified by Tom, 2026-08-29; built 2026-08-30;
// ground-up layer added 2026-08-31).
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
//
// THE TWO REGISTERS (the writing standard, convex/ttsShared.ts
// WRITING_STANDARD). Every piece of prose TTS shows is one of exactly two
// kinds, and this component now carries both:
//   - DISPLAY TEXT — `children`. Short, assumes Tom's background, always
//     visible once the popover is open. One or two sentences.
//   - A GROUND-UP EXPLANATION — `explanation`. Self-contained: it defines
//     every term at first use and is complete with no other document, because
//     these get forwarded verbatim to other people and other agents. The
//     standard fixes its form as a complete HTML document shown FULLSCREEN,
//     which is what GroundUpView (./ground-up-view) already renders for a
//     todo's own explanation — the same renderer, the same sandboxed iframe,
//     reached here from the "more" control inside the popover.
// MIGRATION COMPLETE (2026-08-31). Every caption in app/tts now passes both
// registers, and the last two native `title=` captions — the repeats strip's
// calendar-skip label and the calendar's per-day plus — were moved onto this
// component in the same change. `explanation` stays optional because the type
// cannot express "required at every current call site", but a new caption
// without one is now an omission rather than acknowledged debt.
//
// ONE MECHANISM, ONE DOCUMENT. Ten captions share five documents: the four
// repeats captions all open the repeats document, the six verdict and status
// chips all open the verdicts document, and so on. A document per caption would
// teach a fragment each and none of them would be self-contained, which is the
// one thing the writing standard forbids. What differs per caption is the
// display text.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import GroundUpView from "./ground-up-view";

export default function Info({
  call,
  children,
  explanation,
  explanationTitle,
}: {
  /** The exact backend call the neighbouring control fires (UI = code). */
  call?: string;
  /** Plain language: what that call does. One or two sentences. */
  children?: React.ReactNode;
  /**
   * The ground-up layer: ONE COMPLETE HTML DOCUMENT, `<!DOCTYPE html>` to
   * `</html>`, self-contained (no script, no network, no external anything),
   * shown fullscreen behind the "more" control. Written to the writing
   * standard; the documents themselves live in ../explanations.
   */
  explanation?: string;
  /** The line at the top of the fullscreen view. Defaults to the call. */
  explanationTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
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

  // Escape closes the fullscreen explanation too. It is a separate listener
  // because the popover is already closed by the time it is showing (opening
  // the document closes the panel it was opened from), so the handler above
  // is not mounted.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);

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
          {call && (
            <span
              className={`block font-mono text-[10px] leading-snug text-text-muted break-all ${
                children ? "mt-2 pt-2 border-t border-border" : ""
              }`}
            >
              {call}
            </span>
          )}
          {explanation && (
            // Underlined at rest: clickable text that is not styled as a
            // button is underlined (CLAUDE.md UI rules), and this one has to
            // read as the way into a longer document rather than as a label.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // The panel closes as the document opens: the document covers
                // the screen, and leaving an absolutely positioned panel open
                // underneath it would put the reader back on a stale popover
                // pinned to a control that may have scrolled away.
                setOpen(false);
                setFull(true);
              }}
              className="mt-2 block text-[11px] leading-none text-accent underline underline-offset-2 hover:opacity-80"
            >
              more
            </button>
          )}
        </span>
      )}
      {full &&
        explanation &&
        typeof document !== "undefined" &&
        // Sent to <body> for two reasons: the fullscreen view is a <div> and
        // this component is a <span> (a div inside a span is invalid markup),
        // and any ancestor of the ⓘ that clips or transforms its children
        // would otherwise clip a view meant to cover the screen. React events
        // still travel the component tree through a portal, so the click
        // guard below is still needed to keep presses off the row behind.
        createPortal(
          <div onClick={(e) => e.stopPropagation()}>
            <GroundUpView
              title={explanationTitle ?? call ?? "explanation"}
              content={explanation}
              onClose={() => setFull(false)}
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
