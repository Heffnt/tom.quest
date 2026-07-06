"use client";

// The nickname prompt: the name+color ask shown before an anonymous visitor's
// first shared mutation (party / other-brew action). Relocated out of the
// deleted components/tabs.tsx and refreshed to the shared button feel (./ui).
// Saving names the visitor and releases the intercepted action; closing
// abandons it (the gesture can simply be repeated).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { btn, cn } from "./ui";

export interface ProfilePromptProps {
  defaultName: string;
  defaultColor: string;
  onSave: (name: string, color: string) => void;
  onClose: () => void;
}

export function ProfilePrompt({
  defaultName,
  defaultColor,
  onSave,
  onClose,
}: ProfilePromptProps) {
  const [name, setName] = useState(defaultName);
  const [color, setColor] = useState(defaultColor);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const valid = name.trim().length > 0;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a nickname"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(name.trim(), color);
        }}
        className="w-full max-w-xs rounded-xl border border-border bg-surface p-4 shadow-2xl"
      >
        <h3 className="font-mono text-xs uppercase tracking-[0.25em] text-text-muted">
          Who&apos;s brewing?
        </h3>
        <p className="mt-1 text-[11px] leading-snug text-text-faint">
          Pick a nickname and color so the party can see whose hands are in the
          pot.
        </p>
        <div className="mt-3 flex items-stretch gap-2">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="nickname…"
            maxLength={24}
            spellCheck={false}
            className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          />
          <label
            title="Your color"
            className="relative inline-block w-9 cursor-pointer overflow-hidden rounded-lg border border-border"
            style={{ background: color }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Pick your color"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={cn(btn.outline, "py-1.5")}
          >
            not now
          </button>
          <button type="submit" disabled={!valid} className={btn.accent}>
            join in
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
