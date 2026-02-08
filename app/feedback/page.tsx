"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../components/AuthProvider";
import { Feedback } from "../lib/supabase";
import { debugFetch } from "../lib/debug";

type FeedbackEntry = Feedback & { username?: string | null };

export default function FeedbackPage() {
  const { user, isTom, loading, session } = useAuth();
  const router = useRouter();
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tomChecked, setTomChecked] = useState(false);

  useEffect(() => {
    setTomChecked(false);
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    const verifyTom = async () => {
      if (!user) {
        if (!loading) {
          router.replace("/");
        }
        return;
      }
      if (isTom) {
        if (!cancelled) {
          setTomChecked(true);
        }
        return;
      }
      try {
        const res = await debugFetch("/api/auth/is-tom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.isTom) {
          router.replace("/");
          return;
        }
        setTomChecked(true);
      } catch {
        if (!cancelled) {
          router.replace("/");
        }
      }
    };
    verifyTom();
    return () => {
      cancelled = true;
    };
  }, [user, loading, isTom, router]);

  const fetchFeedback = useCallback(async () => {
    if (!session?.access_token) {
      setError("Not authenticated.");
      return;
    }
    setFeedbackLoading(true);
    setError(null);
    try {
      const res = await debugFetch("/api/feedback", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not load feedback.");
        return;
      }
      setFeedback(Array.isArray(data.feedback) ? data.feedback : []);
    } catch {
      setError("Could not load feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (tomChecked) {
      fetchFeedback();
    }
  }, [tomChecked, fetchFeedback]);

  if (!tomChecked) {
    return null;
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Feedback</h1>
          <button
            type="button"
            onClick={fetchFeedback}
            disabled={feedbackLoading}
            className="text-sm px-3 py-1 rounded border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-colors disabled:opacity-50"
          >
            {feedbackLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error && (
          <p className="text-red-400 text-sm mb-4">{error}</p>
        )}

        <div className="space-y-4">
          {feedback.length === 0 && !feedbackLoading ? (
            <p className="text-white/40">No feedback yet.</p>
          ) : (
            feedback.map((entry) => {
              const nameParts = [entry.name || null, entry.username ? `@${entry.username}` : null].filter(Boolean);
              const displayName = nameParts.length > 0 ? nameParts.join(" · ") : "Anonymous";
              return (
                <div
                  key={entry.id}
                  className="bg-white/5 border border-white/10 rounded-lg p-4"
                >
                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm text-white/60">
                      {displayName}
                    </div>
                    <div className="text-xs text-white/40">
                      {new Date(entry.created_at).toLocaleString()}
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{entry.content}</p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
