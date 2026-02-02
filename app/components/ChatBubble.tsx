"use client";

import { useState, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import LoginModal from "./LoginModal";
import ChatInterface from "./ChatInterface";

export default function ChatBubble() {
  const { user, profile } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [hasReplies, setHasReplies] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  useEffect(() => {
    // Get device name from localStorage or use profile username
    const storedDeviceId = localStorage.getItem("device_id");
    if (storedDeviceId) {
      // Fetch device info to get the name
      fetch(`/api/chat/devices?deviceId=${storedDeviceId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.device) {
            setDeviceName(data.device.device_name);
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Check if Tom has replied to this device
    const checkReplies = async () => {
      const deviceId = localStorage.getItem("device_id");
      if (!deviceId) return;
      try {
        const res = await fetch(`/api/chat/messages?deviceId=${deviceId}`);
        const data = await res.json();
        if (data.messages?.some((m: { from_tom: boolean }) => m.from_tom)) {
          setHasReplies(true);
        }
      } catch {
        // Ignore errors
      }
    };
    checkReplies();
  }, []);

  const displayName = profile?.username || deviceName || "Anonymous";

  return (
    <>
      {/* Chat Bubble */}
      <div className="fixed top-20 left-4 z-40 flex flex-col gap-2">
        <button
          onClick={() => setChatOpen(true)}
          className="flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full px-4 py-2 transition-colors"
        >
          {hasReplies && (
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          )}
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-sm">Tell Tom something!</span>
        </button>

        {/* Login/User Button */}
        <button
          onClick={() => setLoginOpen(true)}
          className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-4 py-2 transition-colors text-white/60 hover:text-white"
        >
          {user ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className="text-sm">{displayName}</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-sm">Sign In</span>
            </>
          )}
        </button>
      </div>

      {/* Chat Interface */}
      <ChatInterface
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        displayName={displayName}
      />

      {/* Login Modal */}
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}
