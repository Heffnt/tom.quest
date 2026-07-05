// app/boolback/lib/share.ts — shareable view URLs (?v=…).
//
// The whole view state (filters + sorts + visible columns + chart/anatomy
// config + which center view is showing) round-trips through one base64url query param
// so a link reproduces exactly what the sender is looking at. Persistence via
// usePersistedSettings stays per-browser; a shared URL OVERRIDES it for that
// load (table-pane hydrates from the shared view instead of the saved one).

import type { AnatomyConfig, ChartConfig, FilterState, SortKey } from "./types";
import type { CenterView } from "../components/table-pane";

export interface SharedView {
  filters?: FilterState;
  sorts?: SortKey[];
  visibleCols?: string[];
  chart?: ChartConfig;
  anatomy?: AnatomyConfig;
  view?: CenterView;
}

// -- base64url of UTF-8 JSON (unicode-safe; btoa alone chokes on non-latin1) --

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeSharedView(view: SharedView): string {
  return b64urlEncode(JSON.stringify(view));
}

/** null on any malformed input — a bad link degrades to the default view. */
export function decodeSharedView(param: string): SharedView | null {
  try {
    const parsed: unknown = JSON.parse(b64urlDecode(param));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SharedView;
  } catch {
    return null;
  }
}

/** The full share URL for the current page with ?v= replaced. */
export function buildShareUrl(view: SharedView): string {
  const url = new URL(window.location.href);
  url.searchParams.set("v", encodeSharedView(view));
  return url.toString();
}

// -- one-shot read of the current page's ?v= (cached; client-only) -----------

let cached: SharedView | null | undefined;

export function readSharedView(): SharedView | null {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return null; // SSR: leave the cache unset
  const param = new URLSearchParams(window.location.search).get("v");
  cached = param ? decodeSharedView(param) : null;
  return cached;
}
