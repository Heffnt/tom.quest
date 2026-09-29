"use client";

import { useAuthActions, useAuthToken, useConvexAuth } from "@convex-dev/auth/react";
import * as Sentry from "@sentry/nextjs";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { useQuery } from "convex/react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { canSee as canRoleSee, type PageSlug } from "@/convex/pageAccess";

export type UserRole = "user" | "admin" | "tom" | "agent";

export interface AuthUser {
  id: string;
  _id: string;
  name: string;
  email: string | null;
  role: UserRole;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  role: UserRole;
  isAdmin: boolean;
  isTom: boolean;
  isAgent: boolean;
  /**
   * May the viewer see the page with this slug? Its row in
   * convex/pageAccess.ts answers, the same row Convex's read gate reads. Gate
   * the subscriptions to a page's agent-readable reads on this; keep gating
   * writes, and reads Convex keeps Tom-only, on isTom.
   */
  canSee: (page: PageSlug) => boolean;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<{ error: string | null }>;
  signUp: (username: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error(
    "NEXT_PUBLIC_CONVEX_URL is not set. Set it in .env.local for dev or in Vercel project envs for prod.",
  );
}
const convex = new ConvexReactClient(convexUrl);

export function getUsername(user: AuthUser | null): string {
  return user?.name ?? "User";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider client={convex}>
      <AuthStateProvider>{children}</AuthStateProvider>
    </ConvexAuthProvider>
  );
}

function AuthStateProvider({ children }: { children: ReactNode }) {
  const convexAuth = useConvexAuth();
  const token = useAuthToken();
  const { signIn: convexSignIn, signOut } = useAuthActions();
  const viewer = useQuery(api.users.viewer);

  const user = useMemo(() => {
    if (!viewer) return null;
    return {
        id: viewer._id,
        _id: viewer._id,
        name: viewer.name,
        email: viewer.email,
        role: viewer.role,
      };
  }, [viewer]);
  const role = user?.role ?? "user";
  const isAdmin = viewer?.isAdmin ?? false;
  const isTom = viewer?.isTom ?? false;
  const isAgent = viewer?.isAgent ?? false;
  // Signed out is `guest` on the ladder, not `user`.
  const pageRole = user ? role : "guest";
  const canSee = useMemo(
    () => (page: PageSlug) => canRoleSee(pageRole, page),
    [pageRole],
  );
  const loading = !convexAuth.isLoading && convexAuth.isAuthenticated ? viewer === undefined : convexAuth.isLoading;

  const signIn = async (username: string, password: string) => {
    try {
      await convexSignIn("password", { flow: "signIn", username, password });
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Sign in failed" };
    }
  };

  const signUp = async (username: string, password: string) => {
    try {
      await convexSignIn("password", { flow: "signUp", username, password });
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Sign up failed" };
    }
  };

  useEffect(() => {
    if (!user) {
      Sentry.setUser(null);
      return;
    }
    Sentry.setUser({
      id: user.id,
      username: user.name,
      email: user.email ?? undefined,
      role: user.role,
    });
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, token, role, isAdmin, isTom, isAgent, canSee, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
