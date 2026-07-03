"use client";

import { useAuth } from "../lib/auth";
import { useUIStore } from "../lib/stores/ui-store";

/* Tom-only toggle for the diagnostics panel. Lives in the header bar next to
   the auth bubble; the panel itself is rendered by DebugPanel. */
export default function DebugToggle({ className = "" }: { className?: string }) {
  const { isTom } = useAuth();
  if (!isTom) return null;
  return (
    <button
      type="button"
      onClick={() => useUIStore.getState().toggleDebug()}
      className={`text-sm font-mono px-3 h-10 rounded-lg border border-accent/50 text-accent hover:bg-accent/10 transition-colors duration-150 whitespace-nowrap ${className}`}
    >
      debug
    </button>
  );
}
