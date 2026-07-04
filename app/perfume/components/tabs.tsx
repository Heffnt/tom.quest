"use client";

// The bench tabs (DESIGN.md, "Live layer"): Party first, then every
// logged-in user with a bench, each in their profile color. The viewer's own
// tab is marked and carries the color picker (writes setProfile). Anonymous
// visitors get no tab — they act through the party tab — and are the audience
// for ProfilePrompt: the nickname+color ask before their first party/
// other-bench mutation.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type BenchTab = { benchKey: string; ownerName: string; color: string };

export interface TabsProps {
  tabs: BenchTab[]; // party entry first (from listBenches)
  activeKey: string;
  ownKey: string | null; // the viewer's bench key; anon keys never match a tab
  onSelect: (benchKey: string) => void;
  onColor: (color: string) => void;
}

export default function Tabs({ tabs, activeKey, ownKey, onSelect, onColor }: TabsProps) {
  return (
    <nav
      aria-label="Benches"
      className="flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5"
    >
      {tabs.map((t) => {
        const active = t.benchKey === activeKey;
        const own = ownKey !== null && t.benchKey === ownKey;
        return (
          <span key={t.benchKey} className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onSelect(t.benchKey)}
              aria-pressed={active}
              title={own ? `${t.ownerName} — your bench` : `Watch ${t.ownerName}'s bench`}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs transition-colors duration-150 ${
                active
                  ? "bg-surface-alt text-text"
                  : "text-text-muted hover:bg-surface-alt/60 hover:text-text"
              }`}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ background: t.color }}
              />
              <span className="max-w-[140px] truncate">{t.ownerName}</span>
              {own && (
                <span className="text-[9px] uppercase tracking-wider text-text-faint">
                  you
                </span>
              )}
            </button>
            {own && <ColorDot color={t.color} onColor={onColor} />}
          </span>
        );
      })}
    </nav>
  );
}

// The native color input, dressed as a small swatch beside the own tab.
function ColorDot({ color, onColor }: { color: string; onColor: (c: string) => void }) {
  return (
    <label
      title="Your color"
      className="relative ml-0.5 inline-block h-4 w-4 cursor-pointer overflow-hidden rounded-full border border-border"
      style={{ background: color }}
    >
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6FE3C4"}
        onChange={(e) => onColor(e.target.value)}
        aria-label="Pick your color"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

// ── the nickname prompt ──────────────────────────────────────────────────────

export interface ProfilePromptProps {
  defaultName: string;
  defaultColor: string;
  // Saving names the visitor and releases the intercepted action; closing
  // abandons it (the gesture can simply be repeated).
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
            className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
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
            className="rounded-md border border-border px-2.5 py-1.5 font-mono text-xs text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
          >
            not now
          </button>
          <button
            type="submit"
            disabled={!valid}
            className="rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 font-mono text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            join in
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
