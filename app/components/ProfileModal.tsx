"use client";

import { useState } from "react";
import { useAuth } from "./AuthProvider";
import { logDebug } from "../lib/debug";

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  displayName: string;
}

export default function ProfileModal({ isOpen, onClose, displayName }: ProfileModalProps) {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const logSource = "Profile";

  if (!isOpen) return null;

  const handleSignOut = async () => {
    logDebug("action", "Sign out clicked", undefined, logSource);
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
      <div className="relative bg-black border border-white/20 rounded-lg p-6 w-full max-w-md">
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
