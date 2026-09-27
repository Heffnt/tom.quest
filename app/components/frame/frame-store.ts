"use client";

// The frame's UI state, per page: which drawers are open, how far each was
// last pulled out, which side drawer was opened last (it lies over the other),
// and what each closed drawer's handle showed when it was last closed (so the
// handle can mark a change since then). Persisted to localStorage; never in
// the URL (app/AGENTS.md routing).
//
// skipHydration: the server renders every drawer closed at its default size,
// so the stored state is read in an effect after the first client render
// (Frame calls rehydrate). Reading it during the first render would disagree
// with the server's HTML.
//
// What storage holds is untrusted: an older round's shape, a hand edit or a
// half-written value. It is read through storedFrameState, which keeps only
// well-formed entries, so a bad value falls back to the defaults and is
// overwritten on the next write rather than crashing the page.

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { EDGES, type Edge, type OpenState } from "./rules";

type PerEdge<T> = Partial<Record<Edge, T>>;

interface FrameStore {
  open: Record<string, OpenState>;
  /** Per page and edge, the size in pixels the drawer was last open at. */
  size: Record<string, PerEdge<number>>;
  lastSide: Record<string, "left" | "right">;
  /** Per page and edge, the handle's signal signature when the drawer last closed. */
  seen: Record<string, PerEdge<string>>;
  setOpen: (page: string, edge: Edge, open: boolean, size?: number) => void;
  markSeen: (page: string, edge: Edge, signature: string) => void;
}

type FrameState = Pick<FrameStore, "open" | "size" | "lastSide" | "seen">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Per page, per edge, the entries whose value passes `ok`; anything else is dropped. */
function perPageEdge<T>(v: unknown, ok: (x: unknown) => x is T): Record<string, PerEdge<T>> {
  const out: Record<string, PerEdge<T>> = {};
  if (!isRecord(v)) return out;
  for (const [page, edges] of Object.entries(v)) {
    if (!isRecord(edges)) continue;
    const kept: PerEdge<T> = {};
    for (const edge of EDGES) if (ok(edges[edge])) kept[edge] = edges[edge];
    out[page] = kept;
  }
  return out;
}

/** The well-formed part of whatever storage held; never throws. */
export function storedFrameState(v: unknown): FrameState {
  const s = isRecord(v) ? v : {};
  const lastSide: Record<string, "left" | "right"> = {};
  if (isRecord(s.lastSide)) {
    for (const [page, side] of Object.entries(s.lastSide)) if (side === "left" || side === "right") lastSide[page] = side;
  }
  return {
    open: perPageEdge(s.open, (x): x is boolean => typeof x === "boolean"),
    size: perPageEdge(s.size, (x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0),
    lastSide,
    seen: perPageEdge(s.seen, (x): x is string => typeof x === "string"),
  };
}

export const useFrameStore = create<FrameStore>()(
  devtools(
    persist(
      (set) => ({
        open: {},
        size: {},
        lastSide: {},
        seen: {},
        setOpen: (page, edge, open, size) =>
          set((s) => ({
            open: { ...s.open, [page]: { ...s.open[page], [edge]: open } },
            size: size === undefined ? s.size : { ...s.size, [page]: { ...s.size[page], [edge]: size } },
            lastSide: open && (edge === "left" || edge === "right") ? { ...s.lastSide, [page]: edge } : s.lastSide,
          })),
        markSeen: (page, edge, signature) =>
          set((s) => ({ seen: { ...s.seen, [page]: { ...s.seen[page], [edge]: signature } } })),
      }),
      {
        name: "tom-quest-frame",
        version: 2,
        skipHydration: true,
        // An older version's state is dropped whole; the current one is kept entry by entry.
        migrate: () => ({}) as FrameStore,
        merge: (stored, current) => ({ ...current, ...storedFrameState(stored) }),
      },
    ),
    { name: "tom.quest frame" },
  ),
);
