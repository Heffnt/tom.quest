"use client";

import { useState, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import ChatInterface from "./ChatInterface";
import { logDebug } from "../lib/debug";

export default function ChatBubble() {
  const { user, profile, isTom } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [hasReplies, setHasReplies] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [lastUsername, setLastUsername] = useState<string | null>(null);

  useEffect(() => {
    // Get device name from localStorage or use profile username
    const storedDeviceId = localStorage.getItem("device_id");
    if (storedDeviceId) {
      // Fetch device info to get the name
      logDebug("request", "Fetch device info", { deviceId: storedDeviceId });
      fetch(`/api/chat/devices?deviceId=${storedDeviceId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.device) {
            setDeviceName(data.device.device_name);
            logDebug("response", "Device info loaded");
          } else if (data.error) {
            logDebug("error", "Device info error", { error: data.error });
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    setLastUsername(localStorage.getItem("last_username"));
  }, []);

  useEffect(() => {
    // Check if Tom has replied to this device
    const checkReplies = async () => {
      const deviceId = localStorage.getItem("device_id");
      if (!deviceId) return;
      try {
        logDebug("request", "Check chat replies", { deviceId });
        const res = await fetch(`/api/chat/messages?deviceId=${deviceId}`);
        const data = await res.json();
        if (data.messages?.some((m: { from_tom: boolean }) => m.from_tom)) {
          setHasReplies(true);
        }
        if (data.error) {
          logDebug("error", "Check replies error", { error: data.error });
        }
      } catch {
        // Ignore errors
      }
    };
    checkReplies();
  }, []);

  const displayName =
    profile?.username ||
    (typeof user?.user_metadata === "object"
      ? (user.user_metadata as { username?: string }).username
      : null) ||
    lastUsername ||
    deviceName ||
    "Anonymous";

  if (isTom) return null;

  return (
    <>
      {/* Chat Bubble */}
      <div className="fixed top-20 right-4 z-40">
        <button
          onClick={() => setChatOpen(true)}
          aria-label="Open chat"
          className="relative flex items-center justify-center bg-white/10 hover:bg-white/20 border border-white/20 rounded-full w-12 h-12 transition-colors"
        >
          {hasReplies && (
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full animate-pulse" />
          )}
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
      </div>

      {/* Chat Interface */}
      <ChatInterface
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        displayName={displayName}
      />
    </>
  );
}
