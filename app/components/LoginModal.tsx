"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { logDebug } from "../lib/debug";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Generate fake email from username for Supabase
function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@tom.quest`;
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const storePassword = (value: string) => {
    try {
      sessionStorage.setItem("last_password", value);
    } catch {
      // Ignore storage errors
    }
  };

  useEffect(() => {
    if (isOpen) {
      setMode("signin");
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const rawUsername = username.trim();
    const normalized = normalizeUsername(rawUsername);
    if (!rawUsername) {
      setError("Username is required");
      setLoading(false);
      return;
    }
    if (!normalized) {
      setError("Username must contain letters or numbers");
      setLoading(false);
      return;
    }

    try {
      localStorage.setItem("last_username", rawUsername);
      if (mode === "signin") {
        // Sign in using generated email from username
        const email = usernameToEmail(rawUsername);
        logDebug("request", "Sign in attempt", { username: rawUsername });
        const { error } = await signIn(email, password);
        if (error) {
          logDebug("error", "Sign in failed", { message: error.message });
          if (error.message.includes("Supabase not configured")) {
            setError("Sign in is not available yet");
          } else {
            setError("Invalid username or password");
          }
        } else {
          logDebug("info", "Sign in success", { username: rawUsername });
          storePassword(password);
          onClose();
        }
      } else {
        logDebug("request", "Sign up attempt", { username: rawUsername });
        const { error } = await signUp(rawUsername, password);
        if (error) {
          logDebug("error", "Sign up failed", { message: error.message });
          if (error.message.includes("already registered")) {
            setError("Username already taken");
          } else {
            setError(error.message);
          }
        } else {
          // Auto sign in after signup
          const email = usernameToEmail(rawUsername);
          const { error: signInError } = await signIn(email, password);
          if (signInError) {
            logDebug("error", "Auto sign in failed", { message: signInError.message });
            setError("Account created! Please sign in.");
          } else {
            logDebug("info", "Sign up success", { username: rawUsername });
            storePassword(password);
            onClose();
          }
        }
      }
    } catch {
      logDebug("error", "Auth unexpected error");
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode(mode === "signin" ? "signup" : "signin");
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black border border-white/20 rounded-lg p-6 w-full max-w-md">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/60 hover:text-white"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-xl font-semibold mb-6">
          {mode === "signin" ? "Sign In" : "Create Account"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-white/60 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30"
              placeholder={mode === "signin" ? "Your username" : "Choose a username"}
              required
            />
          </div>

          <div>
            <label className="block text-sm text-white/60 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-white text-black font-medium py-2 rounded hover:bg-white/90 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading..." : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-white/60">
          {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
          <button onClick={switchMode} className="text-white hover:underline">
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
