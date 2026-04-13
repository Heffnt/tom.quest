"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { User, Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabaseClient } from "./supabase";

const PUBLIC_TOM_USER_ID = process.env.NEXT_PUBLIC_TOM_USER_ID || "";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isTom: boolean;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<{ error: string | null }>;
  signUp: (username: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@tom.quest`;
}

export function getUsername(user: User | null): string {
  const meta = user?.user_metadata as { username?: string } | undefined;
  return meta?.username ?? "User";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase] = useState<SupabaseClient | null>(() => createBrowserSupabaseClient());
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => supabase !== null);
  const lastAuth = useRef<{ userId: string | null; token: string | null } | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      lastAuth.current = {
        userId: session?.user?.id ?? null,
        token: session?.access_token ?? null,
      };
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user?.id ?? null;
      const nextToken = session?.access_token ?? null;
      const prev = lastAuth.current;
      if (prev && prev.userId === nextUserId && prev.token === nextToken) return;
      lastAuth.current = { userId: nextUserId, token: nextToken };
      setSession(session);
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, [supabase]);

  const signIn = async (username: string, password: string) => {
    if (!supabase) return { error: "Supabase not configured" };
    const email = usernameToEmail(username);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp = async (username: string, password: string) => {
    if (!supabase) return { error: "Supabase not configured" };
    const normalized = normalizeUsername(username);
    if (!normalized) return { error: "Username must contain letters or numbers" };
    const email = usernameToEmail(username);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    if (!supabase) return;
    try {
      await Promise.race([
        supabase.auth.signOut().then(({ error }) => { if (error) throw error; }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
    } catch {
      await supabase.auth.signOut({ scope: "local" });
    }
  };

  const isTom = !!user && user.id === PUBLIC_TOM_USER_ID;

  return (
    <AuthContext.Provider value={{ user, session, isTom, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
