"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthProvider";
import { debugFetch } from "../lib/debug";

export default function FeedbackButton() {
  const { user, profile, session } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const defaultName = useMemo(() => {
    const metaName = typeof user?.user_metadata === "object"
      ? (user.user_metadata as { username?: string }).username
      : null;
    return profile?.username || metaName || "";
  }, [profile?.username, user?.user_metadata]);

  useEffect(() => {
    if (!open) return;
    setName((current) => current || defaultName);
    setError(null);
    setSuccess(null);
  }, [open, defaultName]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Please enter a message.");
      return;
    }
    setSending(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await debugFetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          name: name.trim() || null,
          content: trimmed,
          userId: user?.id ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not send feedback.");
        return;
      }
      setMessage("");
      setSuccess("Thanks for the feedback.");
    } catch {
      setError("Could not send feedback.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 rounded-full border border-white/20 bg-black/80 px-4 py-2 text-sm text-white/80 hover:text-white hover:border-white/40 transition-colors"
      >
        Feedback
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-black border border-white/20 rounded-lg p-6 w-full max-w-md">
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 text-white/60 hover:text-white"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <h2 className="text-xl font-semibold mb-6">Send Feedback</h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-white/60 mb-1">Name (optional)</label>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30"
                  placeholder="Your name"
                />
              </div>

              <div>
                <label className="block text-sm text-white/60 mb-1">Message</label>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  className="w-full min-h-[140px] bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30 resize-none"
                  placeholder="What's on your mind?"
                  maxLength={2000}
                  required
                />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}
              {success && <p className="text-green-300 text-sm">{success}</p>}

              <button
                type="submit"
                disabled={sending}
                className="w-full bg-white text-black font-medium py-2 rounded hover:bg-white/90 transition-colors disabled:opacity-50"
              >
                {sending ? "Sending..." : "Send feedback"}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
