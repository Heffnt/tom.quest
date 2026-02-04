"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { User, Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabaseClient, Profile, TuringConnection } from "../lib/supabase";
import { logDebug } from "../lib/debug";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  turingConnection: TuringConnection | null;
  isTom: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (username: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshTuringConnection: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@tom.quest`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase] = useState<SupabaseClient | null>(() => createBrowserSupabaseClient());
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [turingConnection, setTuringConnection] = useState<TuringConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [isTom, setIsTom] = useState(false);

  const getInferredUsername = useCallback((user: User) => {
    const metaUsername = typeof user.user_metadata === "object"
      ? (user.user_metadata as { username?: string }).username
      : undefined;
    const lastUsername = typeof window !== "undefined"
      ? localStorage.getItem("last_username")
      : null;
    const emailUsername = user.email ? user.email.split("@")[0] : null;
    return metaUsername || lastUsername || emailUsername || null;
  }, []);

  const ensureProfile = useCallback(async (user: User) => {
    if (!supabase) return;
    const { data: existing } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();
    if (existing) {
      setProfile(existing);
      return;
    }
    const inferred = getInferredUsername(user);
    if (!inferred) return;
    const { data } = await supabase
      .from("profiles")
      .upsert({ id: user.id, username: inferred }, { onConflict: "id" })
      .select("*")
      .maybeSingle();
    if (data) {
      setProfile(data);
      logDebug("info", "Profile created from inferred username", { username: inferred });
    }
  }, [supabase, getInferredUsername]);

  const fetchProfile = useCallback(async (userId: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    setProfile(data);
  }, [supabase]);

  const fetchTuringConnection = useCallback(async (userId: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from("turing_connections")
      .select("*")
      .eq("user_id", userId)
      .single();
    setTuringConnection(data);
  }, [supabase]);

  const checkIsTom = useCallback(async (userId: string) => {
    try {
      const response = await fetch("/api/auth/is-tom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const { isTom } = await response.json();
      setIsTom(isTom);
    } catch (error) {
      logDebug("error", "Tom check failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      setIsTom(false);
    }
  }, []);

  const linkDeviceToUser = useCallback(async (userId: string) => {
    if (!supabase) return;
    if (typeof window === "undefined") return;
    try {
      const deviceId = localStorage.getItem("device_id");
      if (!deviceId) return;
      await supabase
        .from("devices")
        .update({ user_id: userId })
        .eq("device_id", deviceId);
    } catch (error) {
      logDebug("error", "Device link failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      logDebug("info", "Supabase not configured");
      setLoading(false);
      return;
    }

    const initAuth = async () => {
      logDebug("request", "Auth init");
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          logDebug("info", "Session found", { userId: session.user.id });
          await Promise.all([
            fetchProfile(session.user.id),
            fetchTuringConnection(session.user.id),
            checkIsTom(session.user.id),
          ]);
          await ensureProfile(session.user);
          await linkDeviceToUser(session.user.id);
        }
      } catch (error) {
        logDebug("error", "Auth init failed", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      logDebug("info", "Auth state change", { event, hasSession: !!session });
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await Promise.all([
          fetchProfile(session.user.id),
          fetchTuringConnection(session.user.id),
          checkIsTom(session.user.id),
        ]);
        await ensureProfile(session.user);
        await linkDeviceToUser(session.user.id);
      } else {
        setProfile(null);
        setTuringConnection(null);
        setIsTom(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase, fetchProfile, fetchTuringConnection, checkIsTom, linkDeviceToUser, ensureProfile]);

  const signIn = async (email: string, password: string) => {
    if (!supabase) return { error: new Error("Supabase not configured") };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  };

  const signUp = async (username: string, password: string) => {
    if (!supabase) return { error: new Error("Supabase not configured") };
    const normalized = normalizeUsername(username);
    if (!normalized) return { error: new Error("Username must contain letters or numbers") };
    // Generate a fake email from username (Supabase requires email)
    const email = usernameToEmail(username);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
      },
    });
    return { error: error as Error | null };
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  const refreshProfile = async () => {
    if (user) {
      await fetchProfile(user.id);
    }
  };

  const refreshTuringConnection = async () => {
    if (user) {
      await fetchTuringConnection(user.id);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        turingConnection,
        isTom,
        loading,
        signIn,
        signUp,
        signOut,
        refreshProfile,
        refreshTuringConnection,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
