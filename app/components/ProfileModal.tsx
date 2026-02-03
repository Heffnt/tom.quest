"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { createBrowserSupabaseClient } from "../lib/supabase";
import { logDebug } from "../lib/debug";

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  displayName: string;
}

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

export default function ProfileModal({ isOpen, onClose, displayName }: ProfileModalProps) {
  const { user, signOut } = useAuth();
  const [supabase] = useState(() => createBrowserSupabaseClient());
  const [showPassword, setShowPassword] = useState(false);
  const [storedPassword, setStoredPassword] = useState<string | null>(null);
  const [timeSpentSeconds, setTimeSpentSeconds] = useState<number | null>(null);
  const [timeLoading, setTimeLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setShowPassword(false);
    try {
      setStoredPassword(sessionStorage.getItem("last_password"));
    } catch {
      setStoredPassword(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const loadTime = async () => {
      if (!supabase || !user) {
        setTimeSpentSeconds(null);
        return;
      }
      setTimeLoading(true);
      try {
        const { data, error } = await supabase
          .from("devices")
          .select("total_time_seconds")
          .eq("user_id", user.id);
        if (error) {
          logDebug("error", "Profile time fetch failed", { message: error.message });
          setTimeSpentSeconds(null);
        } else {
          const total = (data ?? []).reduce((sum, row) => sum + (row.total_time_seconds ?? 0), 0);
          setTimeSpentSeconds(total);
        }
      } catch (error) {
        logDebug("error", "Profile time fetch failed", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
        setTimeSpentSeconds(null);
      } finally {
        setTimeLoading(false);
      }
    };
    loadTime();
  }, [isOpen, supabase, user]);

  if (!isOpen) return null;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      try {
        sessionStorage.removeItem("last_password");
      } catch {
        // Ignore storage errors
      }
      onClose();
    } finally {
      setSigningOut(false);
    }
  };

  const passwordAvailable = !!storedPassword;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-12 sm:items-center sm:py-0">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black border border-white/20 rounded-lg p-6 w-full max-w-md mx-4 max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-h-[calc(100vh-2rem)]">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/60 hover:text-white"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-xl font-semibold mb-6">Profile</h2>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-white/60 mb-1">Username</p>
            <p className="text-white">{displayName}</p>
          </div>

          <div>
            <p className="text-sm text-white/60 mb-1">Password</p>
            <div className="flex items-center gap-3">
              <input
                type={showPassword ? "text" : "password"}
                value={storedPassword ?? ""}
                placeholder="Not available"
                readOnly
                className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                disabled={!passwordAvailable}
                className="text-sm px-3 py-2 rounded border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-colors disabled:opacity-50"
              >
                {showPassword ? "Hide" : "Reveal"}
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm text-white/60 mb-1">Time on tom.Quest</p>
            <p className="text-white">
              {timeLoading
                ? "Loading..."
                : timeSpentSeconds !== null
                  ? formatDuration(timeSpentSeconds)
                  : "Not available"}
            </p>
          </div>

          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full bg-white text-black font-medium py-2 rounded hover:bg-white/90 transition-colors disabled:opacity-50"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
