"use client";

// Sound + mute state for /perfume (DESIGN.md §6: "Brewing plays a classy
// completion animation with sound. The mute toggle governs the sound.").
//
// The mute flag persists to localStorage and syncs across tabs/components via a
// tiny subscription so the settings corner and the brewing ceremony agree. The
// cues are synthesised with WebAudio — there are NO audio assets to ship; a few
// short oscillator+envelope voices stand in for brew-complete / take / gift.
// Every cue respects the persisted mute; the ceremony that TRIGGERS the cue
// also honours prefers-reduced-motion (it shortens or skips the animation, and
// the `prefersReducedMotion` helper below is the single reader of that).

import { useCallback, useEffect, useState } from "react";

const MUTE_KEY = "pf:muted:v1";

// The named cues the brewing ceremony and the stage use. A closed union so call
// sites are type-checked against a real vocabulary rather than free-form strings.
export type SoundCue = "brew-complete" | "take" | "gift";

// ── prefers-reduced-motion (the ceremony's single reader) ────────────────────

/** True when the user asked the OS to reduce motion. SSR-safe (false on the
 * server). The ceremony reads this to skip/shorten its animation and the sound
 * cue keeps its shorter form. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

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

// ── the WebAudio voice ───────────────────────────────────────────────────────
// One lazily-created AudioContext shared by every cue (browsers cap the count).
// A cue is a small chord of decaying sine/triangle tones — enough to read as a
// "classy" chime without any asset. All numbers are seconds/hertz.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // a user gesture (the Brew click) resumes a suspended context
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

type Voice = {
  freq: number;
  type: OscillatorType;
  start: number; // seconds from now
  dur: number; // seconds
  gain: number; // peak gain (0..1)
};

// The three cues, as short additive chords. brew-complete is the grand one
// (a rising major arpeggio that blooms); take and gift are single soft pings.
const CUES: Record<SoundCue, Voice[]> = {
  "brew-complete": [
    { freq: 523.25, type: "sine", start: 0.0, dur: 0.5, gain: 0.16 }, // C5
    { freq: 659.25, type: "sine", start: 0.08, dur: 0.5, gain: 0.15 }, // E5
    { freq: 783.99, type: "sine", start: 0.16, dur: 0.55, gain: 0.15 }, // G5
    { freq: 1046.5, type: "triangle", start: 0.26, dur: 0.6, gain: 0.12 }, // C6 shimmer
  ],
  take: [{ freq: 880, type: "sine", start: 0, dur: 0.16, gain: 0.12 }],
  gift: [
    { freq: 587.33, type: "sine", start: 0, dur: 0.18, gain: 0.1 },
    { freq: 880, type: "sine", start: 0.06, dur: 0.2, gain: 0.1 },
  ],
};

function playVoices(ac: AudioContext, voices: Voice[]): void {
  const now = ac.currentTime;
  for (const v of voices) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = v.type;
    osc.frequency.value = v.freq;
    const t0 = now + v.start;
    // a quick attack then an exponential decay — a bell-ish envelope
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(v.gain, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + v.dur + 0.02);
  }
}

// ── the hook ─────────────────────────────────────────────────────────────────

export type SoundApi = {
  /** Current mute state (persisted). */
  muted: boolean;
  /** Flip mute and persist. */
  toggleMuted: () => void;
  /** Set mute explicitly and persist. */
  setMuted: (muted: boolean) => void;
  /** Play a synthesised cue. No-op when muted (or WebAudio is unavailable). */
  play: (cue: SoundCue) => void;
};

/**
 * Shared sound state. The settings corner drives the toggle; the brewing
 * ceremony calls `play("brew-complete")` and the cauldron rim calls
 * `play("take")`. Every mounted consumer stays in sync (module-level
 * subscription + a storage-event bridge across tabs).
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
      const ac = audioContext();
      if (!ac) return;
      try {
        playVoices(ac, CUES[cue]);
      } catch {
        // audio is best-effort; never let a cue throw into the ceremony
      }
    },
    [muted],
  );

  return { muted, toggleMuted, setMuted, play };
}
