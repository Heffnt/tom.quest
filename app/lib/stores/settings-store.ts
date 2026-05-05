"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface SettingsStore {
  values: Record<string, Record<string, unknown>>;
  setLocal: <T extends Record<string, unknown>>(key: string, value: T) => void;
  getLocal: <T extends Record<string, unknown>>(key: string) => T | null;
}

export const useSettingsStore = create<SettingsStore>()(
  devtools(
    (set, get) => ({
      values: {},
      setLocal: (key, value) =>
        set((state) => ({
          values: {
            ...state.values,
            [key]: value,
          },
        })),
      getLocal: (key) => (get().values[key] as never) ?? null,
    }),
    { name: "tom.quest settings" },
  ),
);
