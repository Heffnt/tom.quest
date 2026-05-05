"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth, getUsername } from "../lib/auth";

interface LeaderboardEntry {
  id: string;
  username: string;
  time_ms: number;
  created_at: string;
}

export interface PendingResult {
  winId: number;
  ms: number;
}

interface LeaderboardProps {
  result: PendingResult | null;
  onRequestLogin: () => void;
}

// The endless symbol game stores hit count in timeMs for historical UI naming.
function fmtScore(hits: number): string {
  return `${hits} hit${hits === 1 ? "" : "s"}`;
}

const MEDAL_COLORS = ["text-accent", "text-text-muted", "text-accent/50"];

export default function Leaderboard({ result, onRequestLogin }: LeaderboardProps) {
  const { user } = useAuth();
  const scores = (useQuery(api.symbolScores.topScores, { limit: 10 }) ?? []) as LeaderboardEntry[];
  const submitScore = useMutation(api.symbolScores.submitScore);
  const [savedWinId, setSavedWinId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const saveScore = useCallback(async () => {
    if (!user || !result) return;
    setSaving(true);
    try {
      await submitScore({
        username: getUsername(user),
        timeMs: result.ms,
      });
      setSavedWinId(result.winId);
    } finally {
      setSaving(false);
    }
  }, [user, result, submitScore]);

  const isSaved = result !== null && savedWinId === result.winId;

  return (
    <div className="w-full max-w-sm">
      {result !== null && (
        <div className="mb-4 text-center">
          {isSaved ? (
            <p className="text-accent/60 text-xs">Saved ✓</p>
          ) : user ? (
            <button
              type="button"
              onClick={() => void saveScore()}
              disabled={saving}
              className="text-xs px-4 py-1.5 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/50 transition-colors duration-150 disabled:opacity-50"
            >
              {saving ? "Saving..." : `Save ${fmtScore(result.ms)}`}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestLogin}
              className="text-xs px-4 py-1.5 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/50 transition-colors duration-150"
            >
              Sign in to save {fmtScore(result.ms)}
            </button>
          )}
        </div>
      )}

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-surface">
          <h3 className="text-sm font-semibold text-text-muted">Top Scores</h3>
        </div>
        {scores.length === 0 ? (
          <div className="px-4 py-6 text-center text-text-faint text-sm">
            No scores yet. Be the first!
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {scores.map((entry, i) => (
              <div key={entry.id} className="px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-mono w-6 text-right ${i < 3 ? MEDAL_COLORS[i] : "text-text-faint"}`}>
                    {i + 1}
                  </span>
                  <span className="text-sm text-text-muted">{entry.username}</span>
                </div>
                <span className="text-sm font-mono text-text-muted tabular-nums">
                  {fmtScore(entry.time_ms)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
