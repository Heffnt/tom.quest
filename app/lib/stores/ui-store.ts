"use client";

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

const MIN_DEBUG_WIDTH = 280;
const MAX_DEBUG_WIDTH = 560;

function clampWidth(width: number): number {
  return Math.max(MIN_DEBUG_WIDTH, Math.min(MAX_DEBUG_WIDTH, Math.round(width)));
}

interface UIStore {
  debugOpen: boolean;
  debugWidth: number;
  toggleDebug: () => void;
  closeDebug: () => void;
  setDebugWidth: (width: number) => void;
}

export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set) => ({
        debugOpen: false,
        debugWidth: 360,
        toggleDebug: () => set((state) => ({ debugOpen: !state.debugOpen })),
        closeDebug: () => set({ debugOpen: false }),
        setDebugWidth: (width) => set({ debugWidth: clampWidth(width) }),
      }),
      {
        name: "tom-quest-ui",
        partialize: (state) => ({
          debugOpen: state.debugOpen,
          debugWidth: state.debugWidth,
        }),
      },
    ),
    { name: "tom.quest ui" },
  ),
);

export function uiSnapshot() {
  const state = useUIStore.getState();
  return {
    debugOpen: state.debugOpen,
    debugWidth: state.debugWidth,
  };
}
