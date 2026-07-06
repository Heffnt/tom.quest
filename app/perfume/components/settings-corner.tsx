"use client";

// The SETTINGS CORNER (DESIGN.md §6 "Settings corner holds mute and site
// instructions"). A gear affordance that lives at the right end of the top bar
// and opens a small panel with:
//   • a MUTE toggle (persisted via useSound; Phase-4 audio reads the same flag)
//   • "How it works" — concise player-facing instructions drawn from the spec
//   • register / leave-party actions (registration is click-to-join)
//
// The panel is a portal popover anchored under the gear, dismissed on
// outside-click / Escape. It only presents actions; the orchestrator wires join
// and leave to the store.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSound } from "../lib/sound";
import { btn, cn } from "./ui";

export interface SettingsCornerProps {
  /** Whether the viewer is a registered member (drives join vs leave). */
  registered: boolean;
  /** Whether the viewer can register (a logged-in, resolved identity). */
  canJoin: boolean;
  /** Click-to-join (registration). */
  onJoin: () => void;
  /** Leave the party (self-removal). */
  onLeave: () => void;
}

export default function SettingsCorner({
  registered,
  canJoin,
  onJoin,
  onLeave,
}: SettingsCornerProps) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const gearRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = gearRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right, y: r.bottom + 6 });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={gearRef}
        type="button"
        onClick={toggle}
        aria-label="Settings"
        aria-expanded={open}
        aria-pressed={open}
        title="Settings"
        className={cn(btn.icon, "h-7 w-7 p-0 text-sm")}
      >
        <GearIcon />
      </button>
      {open && at && (
        <SettingsPanel
          at={at}
          registered={registered}
          canJoin={canJoin}
          onJoin={() => {
            onJoin();
            setOpen(false);
          }}
          onLeave={() => {
            onLeave();
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SettingsPanel({
  at,
  registered,
  canJoin,
  onJoin,
  onLeave,
  onClose,
}: {
  at: { x: number; y: number };
  registered: boolean;
  canJoin: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const { muted, toggleMuted } = useSound();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // right-anchored: `at.x` is the gear's RIGHT edge; align the panel's right to it
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = at.x - r.width;
    let y = at.y;
    if (x < 8) x = 8;
    if (y + r.height > window.innerHeight - 8) y = window.innerHeight - r.height - 8;
    setPos({ x, y: Math.max(8, y) });
  }, [at]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Settings"
      className="fixed z-[80] w-[280px] rounded-xl border border-border bg-surface p-3 shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* mute */}
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
            Sound
          </p>
          <p className="text-[11px] leading-snug text-text-faint">
            The brewing ceremony plays a chime.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!muted}
          onClick={toggleMuted}
          aria-label={muted ? "Unmute" : "Mute"}
          className={cn(
            btn.outline,
            "h-7 gap-1.5 px-2",
            !muted && "border-accent/60 text-accent",
          )}
        >
          {muted ? "muted" : "sound on"}
        </button>
      </div>

      <div className="my-3 h-px bg-border" />

      {/* how it works */}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-xs uppercase tracking-wider text-text-muted">
          How it works
          <span className="text-text-faint transition-transform group-open:rotate-90">
            ▸
          </span>
        </summary>
        <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-text-faint">
          <p>
            <strong className="text-text-muted">Brews.</strong> A brew is a
            shared, pass-around workspace. Drag ingredients from an inventory into
            the brew graph; their frequencies combine toward a perfume&apos;s
            recipe.
          </p>
          <p>
            <strong className="text-text-muted">Real vs. hypothetical.</strong>{" "}
            Solid items are real stock; dashed items are what-if placeholders. Fill
            hypotheticals from inventory before you can brew.
          </p>
          <p>
            <strong className="text-text-muted">Brew controls.</strong> Three
            controls act on the whole brew: <em>Fill</em> makes every hypothetical
            real, <em>Return</em> sends real ingredients back to their owners, and{" "}
            <em>Empty</em> clears the brew.
          </p>
          <p>
            <strong className="text-text-muted">Brewing.</strong> When a
            brew&apos;s tally matches a recipe (or a whole multiple of it), brew it
            to place the perfume(s) on the cauldron. Brewing spends your real
            ingredients for good.
          </p>
          <p>
            <strong className="text-text-muted">Taking &amp; gifting.</strong> Take
            perfumes off the cauldron into your inventory. Gift an item by dragging
            it onto a member&apos;s inventory tab — instant, no acceptance step.
          </p>
          <p>
            <strong className="text-text-muted">Party &amp; ownership.</strong> The
            party brew is open to everyone. On your own brews you own the stock;
            others may rearrange where items sit but never change what you own.
            Hand a brew off to pass ownership, or copy any brew to make your own.
          </p>
          <p>
            <strong className="text-text-muted">Pin.</strong> Pin one recipe to a
            brew to see ghost slots for what it still needs. Undo/redo affects only
            your own moves; brewing, taking and gifting are permanent.
          </p>
        </div>
      </details>

      <div className="my-3 h-px bg-border" />

      {/* membership */}
      <div>
        <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
          Membership
        </p>
        {registered ? (
          <>
            <p className="mt-1 text-[11px] leading-snug text-text-faint">
              You&apos;re in the party. You can leave anytime.
            </p>
            <button
              type="button"
              onClick={onLeave}
              className={cn(btn.danger, "mt-2 w-full justify-center border border-border")}
            >
              leave the party
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[11px] leading-snug text-text-faint">
              {canJoin
                ? "Join to get your own inventory and brews."
                : "Sign in to join the party and brew for keeps."}
            </p>
            <button
              type="button"
              onClick={onJoin}
              disabled={!canJoin}
              className={cn(btn.accent, "mt-2 w-full justify-center")}
            >
              join the party
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
