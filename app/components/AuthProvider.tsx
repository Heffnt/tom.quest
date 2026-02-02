"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { createBrowserSupabaseClient, Profile, TuringConnection } from "../lib/supabase";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  turingConnection: TuringConnection | null;
  isTom: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string, username: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshTuringConnection: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase] = useState(() => createBrowserSupabaseClient());
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [turingConnection, setTuringConnection] = useState<TuringConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [isTom, setIsTom] = useState(false);

  const fetchProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    setProfile(data);
  }, [supabase]);

  const fetchTuringConnection = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from("turing_connections")
      .select("*")
      .eq("user_id", userId)
      .single();
    setTuringConnection(data);
  }, [supabase]);

  const checkIsTom = useCallback(async (userId: string) => {
    const response = await fetch("/api/auth/is-tom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const { isTom } = await response.json();
    setIsTom(isTom);
  }, []);

  useEffect(() => {
    const initAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await Promise.all([
          fetchProfile(session.user.id),
          fetchTuringConnection(session.user.id),
          checkIsTom(session.user.id),
        ]);
      }
      setLoading(false);
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await Promise.all([
          fetchProfile(session.user.id),
          fetchTuringConnection(session.user.id),
          checkIsTom(session.user.id),
        ]);
        // Link device to user on login
        const deviceId = localStorage.getItem("device_id");
        if (deviceId) {
          await supabase
            .from("devices")
            .update({ user_id: session.user.id })
            .eq("device_id", deviceId);
        }
      } else {
        setProfile(null);
        setTuringConnection(null);
        setIsTom(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase, fetchProfile, fetchTuringConnection, checkIsTom]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  };

  const signUp = async (email: string, password: string, username: string) => {
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
