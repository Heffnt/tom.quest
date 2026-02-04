"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "./AuthProvider";
import ChatInterface from "./ChatInterface";
import { logDebug } from "../lib/debug";

export default function ChatBubble() {
  const { user, profile, isTom } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [lastUsername, setLastUsername] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [userUnread, setUserUnread] = useState(0);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDeviceInfo = useCallback(async () => {
    if (!deviceId) return;
    try {
      logDebug("request", "Fetch device info", { deviceId });
      const res = await fetch(`/api/chat/devices?deviceId=${deviceId}`);
      const data = await res.json();
      if (data.device) {
        setDeviceName(data.device.device_name);
        logDebug("response", "Device info loaded");
      }
      if (typeof data.user_unread === "number") {
        setUserUnread(data.user_unread);
      }
      if (data.error) {
        logDebug("error", "Device info error", { error: data.error });
      }
    } catch {
      // Ignore errors
    }
  }, [deviceId]);

  useEffect(() => {
    const storedDeviceId = localStorage.getItem("device_id");
    if (storedDeviceId) {
      setDeviceId(storedDeviceId);
    }
    setLastUsername(localStorage.getItem("last_username"));
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    fetchDeviceInfo();
    pollIntervalRef.current = setInterval(fetchDeviceInfo, 5000);
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [deviceId, fetchDeviceInfo]);

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
          onClick={() => {
            setChatOpen(true);
            setUserUnread(0);
          }}
          aria-label="Open chat"
          className="relative flex items-center justify-center bg-white/10 hover:bg-white/20 border border-white/20 rounded-full w-12 h-12 transition-colors"
        >
          {userUnread > 0 && (
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
