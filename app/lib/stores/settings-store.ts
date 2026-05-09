"use client";

import { create } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";

interface SettingsStore {
  values: Record<string, Record<string, unknown>>;
  hydrated: boolean;
  setLocal: <T extends Record<string, unknown>>(key: string, value: T) => void;
  getLocal: <T extends Record<string, unknown>>(key: string) => T | null;
  setHydrated: (hydrated: boolean) => void;
}

const useSettingsStore = create<SettingsStore>()(
  devtools(
    persist(
      (set, get) => ({
        values: {},
        hydrated: false,
        setLocal: (key, value) =>
          set((state) => ({
            values: {
              ...state.values,
              [key]: value,
            },
          })),
        getLocal: <T extends Record<string, unknown>>(key: string) =>
          (get().values[key] as T | undefined) ?? null,
        setHydrated: (hydrated) => set({ hydrated }),
      }),
      {
        name: "tom.quest settings",
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({ values: state.values }),
        onRehydrateStorage: () => (state) => {
          state?.setHydrated(true);
        },
      },
    ),
    { name: "tom.quest settings" },
  ),
);

export function useSettingsHydrated(): boolean {
  return useSettingsStore((state) => state.hydrated);
}

export function getLocalSetting<T extends Record<string, unknown>>(key: string): T | null {
  return useSettingsStore.getState().getLocal<T>(key);
}

export function setLocalSetting<T extends Record<string, unknown>>(key: string, value: T): void {
  useSettingsStore.getState().setLocal(key, value);
}
