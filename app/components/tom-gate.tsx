"use client";

// Auth gate shared by every Tom-only page (Jarvis, Agents, Forge, Intent, Log,
// Questions, Secrets): the house loading state while auth resolves, the
// restricted card for anyone the page's row refuses, children for everyone it
// admits. Purely presentational — callers still use useAuth() themselves for
// the query "skip" idiom; this only owns the two gate states' JSX so it cannot
// drift between pages.
//
// `page` is load-bearing: it is the page's slug, and its row in
// convex/pageAccess.ts decides who gets in (canSee) and names the page in the
// card. Every write behind this gate is refused by Convex independently.

import { useAuth } from "@/app/lib/auth";
import { PAGE_ACCESS, type PageSlug } from "@/convex/pageAccess";

export default function TomGate({
  page,
  children,
}: {
  /** The page's slug, e.g. "agents". */
  page: PageSlug;
  children: React.ReactNode;
}) {
  const { loading, canSee } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!canSee(page)) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          {PAGE_ACCESS[page].label} access is restricted to Tom.
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
