"use client";

// Sound + mute state for /perfume (DESIGN.md §6: "Brewing plays a classy
// completion animation with sound. The mute toggle governs the sound.").
//
// Phase 3 (this shell) owns the mute TOGGLE and its persistence; Phase 4 owns
// the actual ceremony audio. So this module is a stub with a real, working mute
// state and a `play(...)` that no-ops for now — Phase 4 fills in `play` (wiring
// an <audio>/WebAudio source) without touching the toggle or its callers.
//
// The mute flag persists to localStorage and syncs across tabs/components via a
// tiny subscription so the settings corner and any future player agree.

import { useCallback, useEffect, useState } from "react";

const MUTE_KEY = "pf:muted:v1";

// The named cues Phase 4 will implement. Kept as a closed union so call sites
// (the eventual brewing ceremony) are type-checked against a real vocabulary
// rather than free-form strings.
export type SoundCue = "brew-complete" | "take" | "gift";

// ── cross-component mute state (module-level, no context needed) ─────────────

function readMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<(muted: boolean) => void>();

function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // best effort — the in-memory state still updates below
  }
  for (const fn of listeners) fn(muted);
}

// ── the hook ─────────────────────────────────────────────────────────────────

export type SoundApi = {
  /** Current mute state (persisted). */
  muted: boolean;
  /** Flip mute and persist. */
  toggleMuted: () => void;
  /** Set mute explicitly and persist. */
  setMuted: (muted: boolean) => void;
  /** Play a cue. NO-OP until Phase 4 wires the audio; respects `muted`. */
  play: (cue: SoundCue) => void;
};

/**
 * Shared sound state. The settings corner drives the toggle; Phase 4's brewing
 * ceremony calls `play("brew-complete")`. Every mounted consumer stays in sync
 * (module-level subscription + a storage-event bridge across tabs).
 */
export function useSound(): SoundApi {
  const [muted, setMutedState] = useState<boolean>(false);

  // hydrate after mount (SSR-safe) and subscribe to same-tab + cross-tab changes
  useEffect(() => {
    setMutedState(readMuted());
    const onLocal = (next: boolean) => setMutedState(next);
    listeners.add(onLocal);
    const onStorage = (e: StorageEvent) => {
      if (e.key === MUTE_KEY) setMutedState(readMuted());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    writeMuted(next);
  }, []);

  const toggleMuted = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      writeMuted(next);
      return next;
    });
  }, []);

  const play = useCallback(
    (cue: SoundCue) => {
      if (muted) return;
      // Phase 4: play the cue here. Intentionally a no-op for now so the mute
      // toggle and its persistence can ship and be tested independently.
      void cue;
    },
    [muted],
  );

  return { muted, toggleMuted, setMuted, play };
}
