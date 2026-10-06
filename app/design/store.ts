"use client";

// The design page's UI state: the list's filter and the part whose panel is
// open. The open part is also the page's hash (#<part id>), so a link names it.

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type ListFilter = "all" | "unverified" | "issue" | "partial" | "removed-still-run" | "no-sentence";

interface DesignStore {
  filter: ListFilter;
  selected: string | null;
  setFilter: (filter: ListFilter) => void;
  select: (selected: string | null) => void;
}

export const useDesignStore = create<DesignStore>()(
  devtools(
    (set) => ({
      filter: "all",
      selected: null,
      setFilter: (filter) => set({ filter }),
      select: (selected) => set({ selected }),
    }),
    { name: "tom.quest design" },
  ),
);
