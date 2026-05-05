"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "../auth";
import { useSettingsStore } from "../stores/settings-store";

const DEBOUNCE_MS = 400;

function loadFromLocalStorage<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function saveToLocalStorage<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function usePersistedSettings<T extends Record<string, unknown>>(
  key: string,
  defaults: T,
): [T, (update: Partial<T>) => void, boolean] {
  const { user, loading: authLoading } = useAuth();
  const cloud = useQuery(api.userSettings.get, user ? { settingKey: key } : "skip") as T | null | undefined;
  const saveCloud = useMutation(api.userSettings.set);
  const setLocalSetting = useSettingsStore((state) => state.setLocal);
  const [settings, setSettings] = useState<T>(defaults);
  const [isHydrated, setIsHydrated] = useState(false);
  const hydrated = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (user && cloud === undefined) return;
    setIsHydrated(false);
    const local = loadFromLocalStorage<T>(key);
    if (user) {
      if (cloud) {
        setSettings({ ...defaults, ...cloud });
        setLocalSetting(key, { ...defaults, ...cloud });
      } else if (local) {
        setSettings({ ...defaults, ...local });
        setLocalSetting(key, { ...defaults, ...local });
        void saveCloud({ settingKey: key, value: local });
      } else {
        setSettings(defaults);
        setLocalSetting(key, defaults);
      }
    } else {
      setSettings({ ...defaults, ...local });
      setLocalSetting(key, { ...defaults, ...local });
    }
    hydrated.current = true;
    setIsHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading, key, cloud, setLocalSetting, saveCloud]);

  const update = useCallback((patch: Partial<T>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      setLocalSetting(key, next);
      if (!hydrated.current) return next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (user?.id) void saveCloud({ settingKey: key, value: next });
        else saveToLocalStorage(key, next);
      }, DEBOUNCE_MS);
      return next;
    });
  }, [user?.id, key, saveCloud, setLocalSetting]);

  return [settings, update, isHydrated];
}
