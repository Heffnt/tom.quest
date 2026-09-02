"use client";

// Auth gate shared by every Tom-only surface (Forge, Focus, Inventory,
// Jarvis, Sessions): the house loading state while auth resolves, the
// restricted card for anyone else, children for Tom. Purely presentational —
// callers still use useAuth() themselves for the query "skip" idiom; this
// only owns the two gate states' JSX so it cannot drift between surfaces.
//
// `label` is load-bearing, not decoration: it is the surface name, and it
// decides whether the read-only `agent` role gets in. Only the labels listed
// in convex/agentSurfaces.ts ("TTS", "Turing") admit it — "Sessions",
// "Forge" and "Jarvis" stay Tom-only, as does every write behind this gate,
// which Convex refuses independently.

import { useAuth } from "@/app/lib/auth";

export default function TomGate({
  label,
  children,
}: {
  /** Surface name for the restricted card, e.g. "Sessions". */
  label: string;
  children: React.ReactNode;
}) {
  const { loading, canReadSurface } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!canReadSurface(label)) {
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
