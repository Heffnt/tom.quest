"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMode("signin");
      setError(null);
      setUsername("");
      setPassword("");
      setTimeout(() => usernameRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const rawUsername = username.trim();
    const normalized = normalizeUsername(rawUsername);
    if (!rawUsername) { setError("Username is required"); setLoading(false); return; }
    if (!normalized) { setError("Username must contain letters or numbers"); setLoading(false); return; }
    try {
      if (mode === "signin") {
        const { error } = await signIn(rawUsername, password);
        if (error) {
          setError("Invalid username or password");
        } else {
          onClose();
        }
      } else {
        const { error } = await signUp(rawUsername, password);
        if (error) {
          setError(error.includes("already") || error.includes("exists")
            ? "Username already taken"
            : error);
        } else {
          const { error: signInError } = await signIn(rawUsername, password);
          if (signInError) {
            setError("Account created! Please sign in.");
          } else {
            onClose();
          }
        }
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "signin" ? "Sign in" : "Create account"}
        className="relative bg-surface border border-border rounded-lg p-6 w-full max-w-sm animate-settle"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-text-muted hover:text-text transition-colors duration-150"
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
            <label htmlFor="login-username" className="block text-sm text-text-muted mb-1">Username</label>
            <input
              ref={usernameRef}
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text focus:border-accent focus:outline-none transition-colors duration-150"
              placeholder={mode === "signin" ? "Your username" : "Choose a username"}
              required
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm text-text-muted mb-1">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text focus:border-accent focus:outline-none transition-colors duration-150"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-error text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent text-bg font-medium py-2 rounded-lg hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
          >
            {loading ? "Loading..." : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-text-muted">
          {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); }}
            className="text-text hover:text-accent transition-colors duration-150"
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
