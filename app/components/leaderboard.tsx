"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { createBrowserSupabaseClient } from "../lib/supabase";

interface LeaderboardEntry {
  id: string;
  username: string;
  time_ms: number;
  created_at: string;
}

interface LeaderboardProps {
  pendingScore: number | null;
  onRequestLogin: () => void;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${s}.${String(ms % 1000).padStart(3, "0")}s`;
}

const MEDAL_COLORS = [
  "text-[--color-accent]",
  "text-[--color-text-muted]",
  "text-[--color-accent]/50",
];

export default function Leaderboard({ pendingScore, onRequestLogin }: LeaderboardProps) {
  const { user, profile } = useAuth();
  const [scores, setScores] = useState<LeaderboardEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchScores = useCallback(async () => {
    const sb = createBrowserSupabaseClient();
    if (!sb) return;
    const { data } = await sb
      .from("symbol_scores")
      .select("id, username, time_ms, created_at")
      .order("time_ms", { ascending: true })
      .limit(20);
    if (data) setScores(data as LeaderboardEntry[]);
  }, []);

  useEffect(() => { fetchScores(); }, [fetchScores]);

  // Reset saved state when a new score comes in
  useEffect(() => { setSaved(false); }, [pendingScore]);

  const saveScore = useCallback(async (ms: number) => {
    const sb = createBrowserSupabaseClient();
    if (!sb || !user) return;
    setSaving(true);
    const uname = profile?.username
      || (typeof user.user_metadata === "object"
        ? (user.user_metadata as { username?: string }).username
        : null)
      || "Anonymous";
    const { error } = await sb.from("symbol_scores").insert({
      user_id: user.id,
      username: uname,
      time_ms: ms,
    });
    setSaving(false);
    if (!error) { setSaved(true); fetchScores(); }
  }, [user, profile, fetchScores]);

  // Auto-save when user logs in with a pending score
  useEffect(() => {
    if (user && pendingScore !== null && !saved && !saving) saveScore(pendingScore);
  }, [user, pendingScore, saved, saving, saveScore]);

  const showSaveButton = pendingScore !== null && !saved;

  return (
    <div className="w-full max-w-sm">
      {/* Save/sign-in prompt */}
      {showSaveButton && (
        <div className="mb-4 text-center">
          {user ? (
            <button
              type="button"
              onClick={() => saveScore(pendingScore)}
              disabled={saving}
              className="text-xs px-4 py-1.5 rounded-lg border border-[--color-accent]/30 text-[--color-accent] hover:bg-[--color-accent]/10 hover:border-[--color-accent]/50 transition-colors duration-150 disabled:opacity-50"
            >
              {saving ? "Saving..." : `Save score (${fmtTime(pendingScore)})`}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestLogin}
              className="text-xs px-4 py-1.5 rounded-lg border border-[--color-accent]/30 text-[--color-accent] hover:bg-[--color-accent]/10 hover:border-[--color-accent]/50 transition-colors duration-150"
            >
              Sign in to save score
            </button>
          )}
        </div>
      )}

      {saved && (
        <p className="mb-4 text-center text-[--color-accent]/60 text-xs">Score saved!</p>
      )}

      {/* Toggle */}
      <button
        type="button"
        onClick={() => { setOpen(!open); if (!open) fetchScores(); }}
        className="w-full text-center text-sm text-[--color-text-faint] hover:text-[--color-text-muted] transition-colors duration-150 flex items-center justify-center gap-1.5"
      >
        <span>{open ? "Hide Leaderboard" : "Leaderboard"}</span>
        <svg
          className={`w-3.5 h-3.5 text-[--color-accent]/50 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Score list */}
      {open && (
        <div className="mt-4 border border-[--color-border] rounded-lg overflow-hidden animate-settle">
          <div className="px-4 py-3 border-b border-[--color-border] bg-[--color-surface]">
            <h3 className="text-sm font-semibold text-[--color-text-muted]">Top Times</h3>
          </div>
          {scores.length === 0 ? (
            <div className="px-4 py-6 text-center text-[--color-text-faint] text-sm">
              No scores yet. Be the first!
            </div>
          ) : (
            <div className="divide-y divide-[--color-border]/50">
              {scores.map((entry, i) => (
                <div key={entry.id} className="px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-mono w-6 text-right ${
                      i < 3 ? MEDAL_COLORS[i] : "text-[--color-text-faint]"
                    }`}>
                      {i + 1}
                    </span>
                    <span className="text-sm text-[--color-text-muted]">{entry.username}</span>
                  </div>
                  <span className="text-sm font-mono text-[--color-text-muted] tabular-nums">
                    {fmtTime(entry.time_ms)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
