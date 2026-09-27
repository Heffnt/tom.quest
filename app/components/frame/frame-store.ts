"use client";

// The frame's UI state: which drawers are open on which page, and what each
// closed drawer's rail showed when it was last closed (so the rail can mark a
// change since then). Persisted to localStorage per page and per edge; never
// in the URL (app/AGENTS.md routing).
//
// skipHydration: the server renders every drawer closed, so the stored state
// is read in an effect after the first client render (Frame calls rehydrate).
// Reading it during the first render would disagree with the server's HTML.

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Edge, OpenState } from "./rules";

interface FrameStore {
  open: Record<string, OpenState>;
  /** Per page and edge, the rail's signal signature when the drawer last closed. */
  seen: Record<string, Partial<Record<Edge, string>>>;
  setOpen: (page: string, next: OpenState) => void;
  markSeen: (page: string, edge: Edge, signature: string) => void;
}

export const useFrameStore = create<FrameStore>()(
  devtools(
    persist(
      (set) => ({
        open: {},
        seen: {},
        setOpen: (page, next) => set((s) => ({ open: { ...s.open, [page]: next } })),
        markSeen: (page, edge, signature) =>
          set((s) => ({ seen: { ...s.seen, [page]: { ...s.seen[page], [edge]: signature } } })),
      }),
      { name: "tom-quest-frame", skipHydration: true },
    ),
    { name: "tom.quest frame" },
  ),
);
