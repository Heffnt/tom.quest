"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../components/AuthProvider";
import { Device, Message, PageVisit } from "../lib/supabase";

interface DeviceWithExtras extends Device {
  username: string | null;
  unread: number;
  last_message_at: string | null;
}

interface DeviceDetails {
  device: DeviceWithExtras;
  pageVisits: PageVisit[];
  messageCount: number;
}

export default function ChatPage() {
  const { user, isTom, loading } = useAuth();
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceWithExtras[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deviceDetails, setDeviceDetails] = useState<DeviceDetails | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tomChecked, setTomChecked] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDevices = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`/api/chat/devices?userId=${user.id}`);
      const data = await res.json();
      if (data.devices) {
        setDevices(data.devices);
      }
    } catch {
      // Ignore errors
    }
  }, [user]);

  const fetchMessages = useCallback(async () => {
    if (!selectedDevice || !user) return;
    try {
      const res = await fetch(
        `/api/chat/messages?deviceId=${selectedDevice}&userId=${user.id}`
      );
      const data = await res.json();
      if (data.messages) {
        setMessages(data.messages);
        setDevices((prev) =>
          prev.map((device) =>
            device.device_id === selectedDevice ? { ...device, unread: 0 } : device
          )
        );
      }
    } catch {
      // Ignore errors
    }
  }, [selectedDevice, user]);

  const fetchDeviceDetails = useCallback(async (deviceId: string) => {
    if (!user) return;
    try {
      const res = await fetch(`/api/chat/devices/${deviceId}?userId=${user.id}`);
      const data = await res.json();
      setDeviceDetails(data);
    } catch {
      // Ignore errors
    }
  }, [user]);

  const handleSelectDevice = useCallback((deviceId: string) => {
    setSelectedDevice(deviceId);
    setDevices((prev) =>
      prev.map((device) =>
        device.device_id === deviceId ? { ...device, unread: 0 } : device
      )
    );
  }, []);

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
        const res = await fetch("/api/auth/is-tom", {
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

  // Fetch devices on mount
  useEffect(() => {
    if (user && isTom) {
      fetchDevices();
    }
  }, [user, isTom, fetchDevices]);

  // Fetch messages when device selected
  useEffect(() => {
    if (selectedDevice) {
      fetchMessages();
    }
  }, [selectedDevice, fetchMessages]);

  // Auto-refresh polling
  useEffect(() => {
    if (autoRefresh && user && isTom) {
      pollIntervalRef.current = setInterval(() => {
        fetchDevices();
        if (selectedDevice) {
          fetchMessages();
        }
      }, 5000);
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [autoRefresh, user, isTom, selectedDevice, fetchDevices, fetchMessages]);

  const sendMessage = async () => {
    if (!input.trim() || !selectedDevice || !user || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: selectedDevice,
          content: input.trim(),
          fromTom: true,
          userId: user.id,
        }),
      });
      if (res.ok) {
        setInput("");
        fetchMessages();
        fetchDevices();
      }
    } catch {
      // Ignore errors
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

  const isActive = (lastSeen: string) => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return new Date(lastSeen).getTime() > fiveMinutesAgo;
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const getActivityTime = (device: DeviceWithExtras) => {
    const timestamp = Date.parse(device.last_message_at || device.last_seen);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  };

  const sortedDevices = [...devices].sort((a, b) => getActivityTime(b) - getActivityTime(a));

  if (!tomChecked) {
    return null;
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Chat Dashboard</h1>
          <label className="flex items-center gap-2 text-sm text-white/60">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device List */}
          <div className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10">
              <h2 className="font-medium">Chats ({devices.length})</h2>
            </div>
            <div className="divide-y divide-white/5 max-h-[600px] overflow-y-auto">
              {sortedDevices.map((device) => {
                const lastActivity = device.last_message_at || device.last_seen;
                return (
                  <button
                    key={device.device_id}
                    onClick={() => handleSelectDevice(device.device_id)}
                    className={`w-full px-4 py-3 text-left hover:bg-white/5 transition-colors ${
                      selectedDevice === device.device_id ? "bg-white/10" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isActive(device.last_seen) ? "bg-white/40" : "bg-white/20"
                          }`}
                        />
                        <span className="font-medium truncate max-w-[150px]">
                          {device.username || device.device_name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {device.unread > 0 && (
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                        )}
                        {device.unread > 0 && (
                          <span className="bg-white text-black text-xs px-2 py-0.5 rounded-full">
                            {device.unread}
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            fetchDeviceDetails(device.device_id);
                            setShowDetails(true);
                          }}
                          className="text-white/40 hover:text-white p-1"
                          title="Device info"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-white/40 mt-1">
                      Last activity: {new Date(lastActivity).toLocaleString()}
                    </p>
                  </button>
                );
              })}
              {sortedDevices.length === 0 && (
                <p className="px-4 py-8 text-center text-white/40">No chats yet</p>
              )}
            </div>
          </div>

          {/* Chat Area */}
          <div className="lg:col-span-2 bg-white/5 border border-white/10 rounded-lg flex flex-col h-[600px]">
            {selectedDevice ? (
              <>
                <div className="px-4 py-3 border-b border-white/10">
                  <h2 className="font-medium">
                    {devices.find((d) => d.device_id === selectedDevice)?.username ||
                      devices.find((d) => d.device_id === selectedDevice)?.device_name ||
                      "Unknown"}
                  </h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.length === 0 ? (
                    <p className="text-center text-white/40 text-sm py-8">No messages yet</p>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${msg.from_tom ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg px-3 py-2 ${
                            msg.from_tom
                              ? "bg-white text-black"
                              : "bg-white/10 text-white"
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                          <p className={`text-xs mt-1 ${msg.from_tom ? "text-black/40" : "text-white/40"}`}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="p-4 border-t border-white/10">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Reply as Tom..."
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
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-white/40">
                Select a device to view conversation
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Device Details Modal */}
      {showDetails && deviceDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDetails(false)} />
          <div className="relative bg-black border border-white/20 rounded-lg p-6 w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto">
            <button
              onClick={() => setShowDetails(false)}
              className="absolute top-4 right-4 text-white/60 hover:text-white"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <h2 className="text-xl font-semibold mb-4">Device Info</h2>

            <div className="space-y-4">
              <div>
                <p className="text-sm text-white/60">Device Name</p>
                <p>{deviceDetails.device.device_name}</p>
              </div>
              {deviceDetails.device.username && (
                <div>
                  <p className="text-sm text-white/60">Username</p>
                  <p>{deviceDetails.device.username}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-white/60">First Seen</p>
                  <p>{new Date(deviceDetails.device.created_at).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-sm text-white/60">Last Seen</p>
                  <p>{new Date(deviceDetails.device.last_seen).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-white/60">Total Visits</p>
                  <p>{deviceDetails.device.total_visits}</p>
                </div>
                <div>
                  <p className="text-sm text-white/60">Total Time</p>
                  <p>{formatDuration(deviceDetails.device.total_time_seconds)}</p>
                </div>
                <div>
                  <p className="text-sm text-white/60">Messages</p>
                  <p>{deviceDetails.messageCount}</p>
                </div>
              </div>

              {deviceDetails.pageVisits.length > 0 && (
                <div>
                  <p className="text-sm text-white/60 mb-2">Recent Pages</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {deviceDetails.pageVisits.map((visit) => (
                      <div key={visit.id} className="flex justify-between text-sm bg-white/5 px-2 py-1 rounded">
                        <span className="truncate">{visit.path}</span>
                        <span className="text-white/40 ml-2">
                          {visit.duration_seconds ? formatDuration(visit.duration_seconds) : "-"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
