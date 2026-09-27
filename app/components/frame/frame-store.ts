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

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Edge, OpenState } from "./rules";

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
      { name: "tom-quest-frame", version: 2, skipHydration: true, migrate: () => ({}) as FrameStore },
    ),
    { name: "tom.quest frame" },
  ),
);
