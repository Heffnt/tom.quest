"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode, useRef } from "react";
import { User, Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabaseClient, Profile, TuringConnection } from "../lib/supabase";
import { logDebug, debugFetch } from "../lib/debug";

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
  const lastAuthRef = useRef<{ userId: string | null; accessToken: string | null } | null>(null);
  const logSource = "Auth";

  const getInferredUsername = useCallback((user: User) => {
    const metaUsername = typeof user.user_metadata === "object"
      ? (user.user_metadata as { username?: string }).username
      : undefined;
    const emailUsername = user.email ? user.email.split("@")[0] : null;
    return metaUsername || emailUsername || null;
  }, []);

  const ensureProfile = useCallback(async (user: User) => {
    if (!supabase) return;
    logDebug("lifecycle", "Ensure profile start", { userId: user.id }, logSource);
    const { data: existing, error: existingError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();
    if (existingError) {
      logDebug("error", "Ensure profile lookup failed", { message: existingError.message }, logSource);
    }
    if (existing) {
      setProfile(existing);
      logDebug("info", "Profile already exists", { userId: user.id }, logSource);
      return;
    }
    const inferred = getInferredUsername(user);
    if (!inferred) return;
    const { data, error: upsertError } = await supabase
      .from("profiles")
      .upsert({ id: user.id, username: inferred }, { onConflict: "id" })
      .select("*")
      .maybeSingle();
    if (upsertError) {
      logDebug("error", "Profile upsert failed", { message: upsertError.message }, logSource);
    }
    if (data) {
      setProfile(data);
      logDebug("info", "Profile created from inferred username", { username: inferred }, logSource);
    }
  }, [supabase, getInferredUsername]);

  const fetchProfile = useCallback(async (userId: string) => {
    if (!supabase) return;
    logDebug("lifecycle", "Fetch profile start", { userId }, logSource);
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) {
      logDebug("error", "Fetch profile failed", { message: error.message }, logSource);
    }
    setProfile(data);
  }, [supabase]);

  const fetchTuringConnection = useCallback(async (userId: string) => {
    if (!supabase) return;
    logDebug("lifecycle", "Fetch turing connection start", { userId }, logSource);
    const { data, error } = await supabase
      .from("turing_connections")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error) {
      logDebug("error", "Fetch turing connection failed", { message: error.message }, logSource);
    }
    setTuringConnection(data);
  }, [supabase]);

  const checkIsTom = useCallback(async (userId: string) => {
    try {
      const response = await debugFetch("/api/auth/is-tom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const { isTom } = await response.json();
      setIsTom(isTom);
    } catch (error) {
      logDebug("error", "Tom check failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      }, logSource);
      setIsTom(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      logDebug("info", "Supabase not configured", undefined, logSource);
      setLoading(false);
      return;
    }

    const initAuth = async () => {
      logDebug("lifecycle", "Auth init start", undefined, logSource);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setSession(session);
        setUser(session?.user ?? null);
        lastAuthRef.current = {
          userId: session?.user?.id ?? null,
          accessToken: session?.access_token ?? null,
        };
        if (session?.user) {
          logDebug("info", "Session found", { userId: session.user.id }, logSource);
          await Promise.all([
            fetchProfile(session.user.id),
            fetchTuringConnection(session.user.id),
            checkIsTom(session.user.id),
          ]);
          await ensureProfile(session.user);
        }
      } catch (error) {
        logDebug("error", "Auth init failed", {
          message: error instanceof Error ? error.message : "Unknown error",
        }, logSource);
      } finally {
        setLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      const nextUserId = session?.user?.id ?? null;
      const nextAccessToken = session?.access_token ?? null;
      const lastAuth = lastAuthRef.current;
      const isSameAuth = lastAuth
        && lastAuth.userId === nextUserId
        && lastAuth.accessToken === nextAccessToken;
      if (isSameAuth) return;
      lastAuthRef.current = { userId: nextUserId, accessToken: nextAccessToken };
      logDebug("lifecycle", "Auth state change", { event, hasSession: !!session }, logSource);
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await Promise.all([
          fetchProfile(session.user.id),
          fetchTuringConnection(session.user.id),
          checkIsTom(session.user.id),
        ]);
        await ensureProfile(session.user);
      } else {
        setProfile(null);
        setTuringConnection(null);
        setIsTom(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase, fetchProfile, fetchTuringConnection, checkIsTom, ensureProfile]);

  const signIn = async (email: string, password: string) => {
    if (!supabase) {
      logDebug("error", "Sign in failed: Supabase not configured", undefined, logSource);
      return { error: new Error("Supabase not configured") };
    }
    logDebug("action", "Sign in requested", { email }, logSource);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      logDebug("error", "Sign in failed", { message: error.message }, logSource);
    } else {
      logDebug("info", "Sign in success", { email }, logSource);
    }
    return { error: error as Error | null };
  };

  const signUp = async (username: string, password: string) => {
    if (!supabase) {
      logDebug("error", "Sign up failed: Supabase not configured", undefined, logSource);
      return { error: new Error("Supabase not configured") };
    }
    const normalized = normalizeUsername(username);
    if (!normalized) {
      logDebug("error", "Sign up failed: invalid username", { username }, logSource);
      return { error: new Error("Username must contain letters or numbers") };
    }
    // Generate a fake email from username (Supabase requires email)
    const email = usernameToEmail(username);
    logDebug("action", "Sign up requested", { username, email }, logSource);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
      },
    });
    if (error) {
      logDebug("error", "Sign up failed", { message: error.message }, logSource);
    } else {
      logDebug("info", "Sign up success", { username, email }, logSource);
    }
    return { error: error as Error | null };
  };

  const signOut = async () => {
    if (!supabase) return;
    const timeoutMs = 5000;
    logDebug("action", "Sign out requested", undefined, logSource);
    const attemptRemoteSignOut = async () => {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
    };
    try {
      await Promise.race([
        attemptRemoteSignOut(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("Sign out timed out"));
          }, timeoutMs);
        }),
      ]);
      logDebug("info", "Sign out success", undefined, logSource);
    } catch (error) {
      logDebug("error", "Remote sign out failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      }, logSource);
      await supabase.auth.signOut({ scope: "local" });
      logDebug("info", "Local sign out completed", undefined, logSource);
    }
  };

  const refreshProfile = async () => {
    if (user) {
      logDebug("lifecycle", "Refresh profile requested", { userId: user.id }, logSource);
      await fetchProfile(user.id);
    }
  };

  const refreshTuringConnection = async () => {
    if (user) {
      logDebug("lifecycle", "Refresh turing connection requested", { userId: user.id }, logSource);
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
