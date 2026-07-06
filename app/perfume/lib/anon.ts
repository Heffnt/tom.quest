// Anonymous identity for the live brew (DESIGN.md §4): visitors are keyed by a
// generated "anon:<uuid>" kept in localStorage — the fragile part the UI warns
// about. The nickname/color chosen at the profile prompt is mirrored here so
// registration can seed the Convex member row and so we know the visitor has
// named themselves (named-ness gates party/other-member-brew mutations).
// Every access is SSR-safe: no window means no identity yet.

import { fundamentals } from "../data/base";

const ANON_KEY = "pf:anon-id";
const PROFILE_KEY = "pf:profile";

const ANON_SHAPE = /^anon:[0-9a-f-]{36}$/;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // insecure-context fallback — collision odds are irrelevant at this scale
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** The stored anon id, without creating one. */
function peekAnonId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ANON_KEY);
    return v && ANON_SHAPE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The anon id, minted and persisted on first use. */
export function getAnonId(): string | null {
  if (typeof window === "undefined") return null;
  const existing = peekAnonId();
  if (existing) return existing;
  const id = `anon:${uuid()}`;
  try {
    window.localStorage.setItem(ANON_KEY, id);
  } catch {
    // storage unavailable: a per-pageload identity still lets mutations run
  }
  return id;
}

export type StoredProfile = { name: string; color: string };

export function loadProfile(): StoredProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredProfile>;
    if (typeof p.name !== "string" || typeof p.color !== "string") return null;
    return { name: p.name, color: p.color };
  } catch {
    return null;
  }
}

export function saveProfile(profile: StoredProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // best effort — the Convex member doc is the real record
  }
}

// Deterministic default color drawn from the fundamentals' palette — the same
// hash convex/perfume.ts uses, so client fallbacks match server defaults.
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return fundamentals[h % fundamentals.length].color;
}
