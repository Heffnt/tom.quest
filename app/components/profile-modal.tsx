"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  displayName: string;
}

export default function ProfileModal({ isOpen, onClose, displayName }: ProfileModalProps) {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

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

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      onClose();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
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

        <h2 className="text-xl font-semibold mb-6">Profile</h2>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-text-muted mb-1">Username</p>
            <p className="text-text">{displayName}</p>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full text-error bg-error/10 font-medium py-2 rounded-lg hover:bg-error/20 transition-colors duration-150 disabled:opacity-50"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
