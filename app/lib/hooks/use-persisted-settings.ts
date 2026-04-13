"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { createBrowserSupabaseClient } from "../supabase";

const DEBOUNCE_MS = 400;

async function loadFromSupabase<T>(userId: string, key: string): Promise<T | null> {
  const sb = createBrowserSupabaseClient();
  if (!sb) return null;
  const { data } = await sb
    .from("user_settings")
    .select("value")
    .eq("user_id", userId)
    .eq("setting_key", key)
    .maybeSingle();
  return (data?.value as T) ?? null;
}

async function saveToSupabase<T>(userId: string, key: string, value: T): Promise<void> {
  const sb = createBrowserSupabaseClient();
  if (!sb) return;
  await sb.from("user_settings").upsert(
    { user_id: userId, setting_key: key, value, updated_at: new Date().toISOString() },
    { onConflict: "user_id,setting_key" },
  );
}

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

/**
 * Hydrate the initial settings on mount or when the user logs in/out.
 *
 * Inputs:
 *   - userId: current user id, or null if guest
 *   - key: settings key (e.g. "turing_gpu_grid")
 *   - defaults: the default shape to merge with whatever we find
 *
 * Returns: the merged settings to set as state.
 *
 * POLICY DECISION (user-supplied): See the request below the function.
 */
async function hydrate<T extends Record<string, unknown>>(
  userId: string | null,
  key: string,
  defaults: T,
): Promise<T> {
  if (!userId) return { ...defaults, ...loadFromLocalStorage<T>(key) };
  const cloud = await loadFromSupabase<T>(userId, key);
  if (cloud) return { ...defaults, ...cloud };
  const local = loadFromLocalStorage<T>(key);
  if (local) {
    await saveToSupabase(userId, key, local);
    return { ...defaults, ...local };
  }
  return defaults;
}

export function usePersistedSettings<T extends Record<string, unknown>>(
  key: string,
  defaults: T,
): [T, (update: Partial<T>) => void, boolean] {
  const { user, loading: authLoading } = useAuth();
  const [settings, setSettings] = useState<T>(defaults);
  const [isHydrated, setIsHydrated] = useState(false);
  const hydrated = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      setIsHydrated(false);
      const merged = await hydrate(user?.id ?? null, key, defaults);
      if (!cancelled) {
        setSettings(merged);
        hydrated.current = true;
        setIsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading, key]);

  const update = useCallback((patch: Partial<T>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      if (!hydrated.current) return next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (user?.id) void saveToSupabase(user.id, key, next);
        else saveToLocalStorage(key, next);
      }, DEBOUNCE_MS);
      return next;
    });
  }, [user?.id, key]);

  return [settings, update, isHydrated];
}
