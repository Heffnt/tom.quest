"use client";

// The sessions page's column layout: the widths Tom dragged the two side
// columns to and whether each is collapsed. UI-only, kept in this browser.

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export const LEFT_WIDTH = { min: 200, max: 520, initial: 280 };
export const RIGHT_WIDTH = { min: 220, max: 560, initial: 300 };

interface SessionsLayout {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
}

const clamp = (width: number, { min, max }: { min: number; max: number }) =>
  Math.max(min, Math.min(max, Math.round(width)));

export const useSessionsLayout = create<SessionsLayout>()(
  devtools(
    persist(
      (set) => ({
        leftOpen: true,
        rightOpen: true,
        leftWidth: LEFT_WIDTH.initial,
        rightWidth: RIGHT_WIDTH.initial,
        toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
        toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
        setLeftWidth: (width) => set({ leftWidth: clamp(width, LEFT_WIDTH) }),
        setRightWidth: (width) => set({ rightWidth: clamp(width, RIGHT_WIDTH) }),
      }),
      { name: "tom-quest-sessions-layout" },
    ),
    { name: "tom.quest sessions layout" },
  ),
);
