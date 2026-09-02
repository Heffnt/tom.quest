// app/boolback/lib/presets.ts — saved views (Phase 5).
//
// A preset is ONE kind: a named snapshot of the active view's VIEW-SPEC
// (lib/spec.ts). `save` stores `{ name, spec }` in the Convex boolbackPresets
// `state` field (the ViewSpec object verbatim); `apply` parses it back to a
// ViewSpec and assigns it into the matching view. Presets written before the
// spec rewrite do NOT migrate — hydratePresetSpec returns null for anything
// that isn't a v3 spec, so a stale row simply no-ops.
//
// A preset must NEVER crash the page: hydration is tolerant (parseSpec) and
// never throws.

import type { FilterState } from "./types";
import { parseSpec, type ViewSpec } from "./spec";

/** Bumped for the spec-based rewrite (was 2 before presets stored a ViewSpec). */
export const PRESET_SCHEMA_VERSION = 3;

/**
 * Coerce a stored preset `state` (opaque JSON — object or string) to a valid
 * ViewSpec, or null when it isn't a v3 spec (legacy rows never migrate).
 * Tolerant: never throws.
 */
export function hydratePresetSpec(state: unknown): ViewSpec | null {
  try {
    const text = typeof state === "string" ? state : JSON.stringify(state);
    return parseSpec(text);
  } catch {
    return null;
  }
}

/** A default preset name suggested from the active filter chips. */
export function suggestPresetName(filters: FilterState): string {
  const parts: string[] = [];
  for (const vals of Object.values(filters.facets ?? {})) {
    if (Array.isArray(vals) && vals.length) parts.push(vals[0]);
    if (parts.length >= 2) break;
  }
  for (const r of filters.ranges ?? []) {
    if (parts.length >= 2) break;
    parts.push(`${r.metric} sweep`);
  }
  return parts.join(" · ") || "view";
}
