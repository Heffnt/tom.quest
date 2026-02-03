"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Message } from "../lib/supabase";
import { logDebug } from "../lib/debug";

interface ChatInterfaceProps {
  isOpen: boolean;
  onClose: () => void;
  displayName: string;
}

export default function ChatInterface({ isOpen, onClose, displayName }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!deviceId) return;
    try {
      logDebug("request", "Fetch chat messages", { deviceId });
      const res = await fetch(`/api/chat/messages?deviceId=${deviceId}`);
      const data = await res.json();
      if (data.messages) {
        setMessages(data.messages);
        logDebug("response", "Fetched chat messages", { count: data.messages.length });
      } else if (data.error) {
        logDebug("error", "Failed to fetch messages", { error: data.error });
      }
    } catch {
      logDebug("error", "Fetch messages failed");
    }
  }, [deviceId]);

  useEffect(() => {
    const storedDeviceId = localStorage.getItem("device_id");
    if (storedDeviceId) {
      setDeviceId(storedDeviceId);
    }
  }, []);

  useEffect(() => {
    if (isOpen && deviceId) {
      fetchMessages();
      // Poll for new messages every 5 seconds
      pollIntervalRef.current = setInterval(fetchMessages, 5000);
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen, deviceId, fetchMessages]);

  const sendMessage = async () => {
    if (!input.trim() || !deviceId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      logDebug("request", "Send chat message", { deviceId, length: input.trim().length });
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          content: input.trim(),
          fromTom: false,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const errorMessage = data?.error || "Failed to send message";
        setSendError(errorMessage);
        logDebug("error", "Send message failed", { error: errorMessage });
        return;
      }
      logDebug("response", "Send message success");
      setInput("");
      fetchMessages();
    } catch {
      setSendError("Failed to send message");
      logDebug("error", "Send message failed");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black border border-white/20 rounded-lg w-full max-w-md mx-4 h-[500px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div>
            <h3 className="font-medium">Chat with Tom</h3>
            <p className="text-xs text-white/60">chatting as {displayName}</p>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <p className="text-center text-white/40 text-sm py-8">
              No messages yet. Say hi to Tom!
            </p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.from_tom ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    msg.from_tom
                      ? "bg-white/10 text-white"
                      : "bg-white text-black"
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  <p className={`text-xs mt-1 ${msg.from_tom ? "text-white/40" : "text-black/40"}`}>
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-white/10">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-white/30"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending}
              className="bg-white text-black px-4 py-2 rounded font-medium hover:bg-white/90 transition-colors disabled:opacity-50"
            >
              Send
            </button>
          </div>
          {sendError && (
            <p className="text-red-400 text-sm mt-2">{sendError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
