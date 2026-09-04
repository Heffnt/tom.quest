"use client";

// The one model picker. Three surfaces choose a model — the new-session form,
// the autonomous fleet's default, and the header of an open session — and all
// three list the SAME names, from the one home (convex/ttsShared.ts
// SESSION_MODELS). A model added there appears in every picker with no edit
// here.
//
// A native <select> on purpose: it is the control a phone already knows, and
// opening it never moves the page (the ratified rule that interactions must
// not shift layout).

import { SESSION_MODEL_NAMES, type SessionModel } from "../lib";

export default function ModelSelect({
  value,
  onChange,
  disabled,
  compact,
  ariaLabel,
}: {
  value: SessionModel;
  onChange: (model: SessionModel) => void;
  disabled?: boolean;
  /** Chip-sized, for the session header; otherwise form-sized. */
  compact?: boolean;
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as SessionModel)}
      className={`bg-surface-alt border border-border rounded text-text focus:outline-none focus:border-accent hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none ${
        compact ? "shrink-0 px-1.5 py-0.5 text-xs" : "px-3 py-2 text-sm"
      }`}
    >
      {SESSION_MODEL_NAMES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
