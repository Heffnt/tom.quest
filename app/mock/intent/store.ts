"use client";

// The mockup's UI state: which sections are open and how many rulings show.

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type SectionKey = "toward" | "writing" | "ground" | "decide" | "areas";

interface MockIntentStore {
  open: Record<SectionKey, boolean>;
  rulingsShown: number;
  toggle: (key: SectionKey) => void;
  showMoreRulings: () => void;
}

export const RULINGS_STEP = 40;

export const useMockIntentStore = create<MockIntentStore>()(
  devtools(
    (set) => ({
      open: { toward: true, writing: false, ground: false, decide: false, areas: false },
      rulingsShown: RULINGS_STEP,
      toggle: (key) => set((state) => ({ open: { ...state.open, [key]: !state.open[key] } })),
      showMoreRulings: () => set((state) => ({ rulingsShown: state.rulingsShown + RULINGS_STEP })),
    }),
    { name: "tom.quest mock intent" },
  ),
);
