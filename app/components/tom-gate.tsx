"use client";

// Auth gate shared by every Tom-only surface (Forge, Jarvis, Sessions, TTS,
// and the TTS mockup when it is not rendering sample data): the house loading
// state while auth resolves, the restricted card for anyone else, children for
// Tom. Purely presentational —
// callers still use useAuth() themselves for the query "skip" idiom; this
// only owns the two gate states' JSX so it cannot drift between surfaces.

import { useAuth } from "@/app/lib/auth";

export default function TomGate({
  label,
  children,
}: {
  /** Surface name for the restricted card, e.g. "Sessions". */
  label: string;
  children: React.ReactNode;
}) {
  const { loading, isTom } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!isTom) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          {label} access is restricted to Tom.
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
