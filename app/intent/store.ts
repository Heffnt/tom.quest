"use client";

// The intent page's UI state: which view is open, the list's filters, and the
// line whose evidence is in the drawer. Nothing here is server data; the line in the drawer is the
// query's own row, held while it is open.

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { NO_FILTERS, type Filters, type IntentLine } from "./lib";

export type IntentView = "agent" | "lines" | "rulings" | "vocabulary" | "disagreements";

export const INTENT_VIEWS: IntentView[] = ["agent", "lines", "rulings", "vocabulary", "disagreements"];

interface IntentStore {
  view: IntentView;
  filters: Filters;
  selected: IntentLine | null;
  setView: (view: IntentView) => void;
  setFilters: (filters: Partial<Filters>) => void;
  select: (line: IntentLine | null) => void;
}

export const useIntentStore = create<IntentStore>()(
  devtools(
    (set) => ({
      view: "agent",
      filters: NO_FILTERS,
      selected: null,
      setView: (view) => set({ view }),
      setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
      select: (selected) => set({ selected }),
    }),
    { name: "tom.quest intent" },
  ),
);
