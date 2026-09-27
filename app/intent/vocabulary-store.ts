"use client";

// The vocabulary page's UI state: which view is open, the kind picked, and the
// word typed. Nothing here is server data.

import { create } from "zustand";
import { devtools } from "zustand/middleware";

type VocabularyView = "terms" | "disagreements";

interface VocabularyStore {
  view: VocabularyView;
  kind: string;
  word: string;
  setView: (view: VocabularyView) => void;
  setKind: (kind: string) => void;
  setWord: (word: string) => void;
}

export const useVocabularyStore = create<VocabularyStore>()(
  devtools(
    (set) => ({
      view: "terms",
      kind: "all",
      word: "",
      setView: (view) => set({ view }),
      setKind: (kind) => set({ kind }),
      setWord: (word) => set({ word }),
    }),
    { name: "tom.quest vocabulary" },
  ),
);
