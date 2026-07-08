"use client";

// The SETTINGS CORNER (DESIGN.md §6 "Settings corner"). A gear affordance that
// lives at the right end of the top bar and opens a small panel holding ONLY:
//   • a MUTE toggle (persisted via useSound; the ceremony audio reads the flag)
//   • register / leave-party actions (registration is click-to-join)
//
// The old "How it works" text has moved to the stage-corner help popup
// (components/help-popup.tsx) — the gear no longer carries instructions.
//
// The panel is a portal popover anchored under the gear, dismissed on
// outside-click / Escape. It only presents actions; the orchestrator wires join
// and leave to the store.

import { useRef, useState } from "react";
import { useSound } from "../lib/sound";
import { GearIcon } from "./glyphs";
import { Popover, type PopoverAnchor } from "./popover";
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
  const [at, setAt] = useState<PopoverAnchor | null>(null);
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
  at: PopoverAnchor;
  registered: boolean;
  canJoin: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const { muted, toggleMuted } = useSound();

  return (
    <Popover
      anchor={at}
      align="right"
      width={280}
      label="Settings"
      onClose={onClose}
      className="p-3"
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
    </Popover>
  );
}
