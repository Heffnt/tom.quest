"use client";

// Auth gate shared by every Tom-only surface (Forge, Focus, Inventory,
// Jarvis, Sessions): the house loading state while auth resolves, the
// restricted card for anyone else, children for Tom. Purely presentational —
// callers still use useAuth() themselves for the query "skip" idiom; this
// only owns the two gate states' JSX so it cannot drift between surfaces.
//
// The `agent` role — what a TTS session's headless browser signs in as — also
// passes, but only for the labels in convex/agentSurfaces (today: "TTS"). It
// has to: a session that only ever saw the restricted card could not check the
// page it just changed, which is the whole reason it has a browser. What it
// sees is the page; every write behind it still goes through requireTom in
// Convex, so the rendered controls refuse.

import { useAuth } from "@/app/lib/auth";
import { isAgentReadableSurface } from "@/convex/agentSurfaces";

export default function TomGate({
  label,
  children,
}: {
  /** Surface name for the restricted card, e.g. "Sessions". */
  label: string;
  children: React.ReactNode;
}) {
  const { loading, isTom, isAgent } = useAuth();
  const mayView = isTom || (isAgent && isAgentReadableSurface(label));

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!mayView) {
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
