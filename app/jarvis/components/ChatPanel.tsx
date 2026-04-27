"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useGateway } from "./useGateway";

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
};

type ChatMessage = {
  id?: string;
  timestamp?: string | number;
  role?: string;
  model?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  content?: ContentBlock[];
};

type SessionMessageEventPayload = {
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  message?: ChatMessage;
};

function formatTimestamp(value: string | number | undefined) {
  if (value == null) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

function sessionLabel(session: {
  key: string;
  displayName?: string;
  derivedTitle?: string;
  label?: string;
  origin?: { label?: string };
}) {
  return session.displayName || session.derivedTitle || session.label || session.origin?.label || session.key;
}

function mergeLiveMessage(messages: ChatMessage[], payload: SessionMessageEventPayload) {
  if (!payload.message) return messages;
  const next = [...messages];
  const messageId = payload.messageId ?? payload.message.id;
  const existingIndex = messageId
    ? next.findIndex((message) => (message.id ?? "") === messageId)
    : -1;
  const nextMessage = {
    ...payload.message,
    id: messageId ?? payload.message.id,
  };
  if (existingIndex >= 0) {
    next[existingIndex] = nextMessage;
    return next;
  }
  next.push(nextMessage);
  return next;
}

export default function ChatPanel({
  selectedSessionKey: controlledSessionKey,
  onSelectedSessionKeyChange,
  showSessionPicker = true,
}: {
  selectedSessionKey?: string;
  onSelectedSessionKeyChange?: (sessionKey: string) => void;
  showSessionPicker?: boolean;
} = {}) {
  const {
    chatAbort,
    chatHistory,
    chatSend,
    connected,
    sessionsList,
    sessionsMessagesSubscribe,
    sessionsMessagesUnsubscribe,
    subscribe,
  } = useGateway();
  const [sessions, setSessions] = useState<Array<{
    key: string;
    displayName?: string;
    derivedTitle?: string;
    label?: string;
    origin?: { label?: string };
    updatedAt: number | null;
  }>>([]);
  const [uncontrolledSessionKey, setUncontrolledSessionKey] = useState("agent:main:main");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const selectedSessionKey = controlledSessionKey ?? uncontrolledSessionKey;
  const setSelectedSessionKey = useCallback((sessionKey: string) => {
    if (controlledSessionKey == null) {
      setUncontrolledSessionKey(sessionKey);
    }
    onSelectedSessionKeyChange?.(sessionKey);
  }, [controlledSessionKey, onSelectedSessionKeyChange]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [sessions],
  );

  const loadSessions = useCallback(async () => {
    if (!connected) return;
    setLoadingSessions(true);
    try {
      const result = await sessionsList({
        limit: 50,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      setSessions(result.sessions);
      const current = selectedSessionKey;
      if (!result.sessions.some((session) => session.key === current)) {
        const mainSession = result.sessions.find((session) => session.key === "agent:main:main");
        const nextKey = mainSession?.key ?? result.sessions[0]?.key ?? current;
        setSelectedSessionKey(nextKey);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load sessions");
    } finally {
      setLoadingSessions(false);
    }
  }, [connected, selectedSessionKey, sessionsList, setSelectedSessionKey]);

  const loadHistory = useCallback(async (sessionKey: string) => {
    if (!connected) return;
    setLoadingHistory(true);
    try {
      const result = await chatHistory(sessionKey, { limit: 100, maxChars: 100_000 });
      const transcriptMessages = result.messages.filter(
        (message) => typeof (message as { role?: unknown }).role === "string",
      ) as ChatMessage[];
      setMessages(transcriptMessages);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load chat history");
      setMessages([]);
    } finally {
      setLoadingHistory(false);
    }
  }, [chatHistory, connected]);

  useEffect(() => {
    if (!connected) return;
    void loadSessions();
    const unsubscribe = subscribe("sessions.changed", () => {
      void loadSessions();
    });
    return unsubscribe;
  }, [connected, loadSessions, subscribe]);

  useEffect(() => {
    if (!connected || !selectedSessionKey) return;
    void loadHistory(selectedSessionKey);
  }, [connected, loadHistory, selectedSessionKey]);

  useEffect(() => {
    if (!connected || !selectedSessionKey) return;
    let disposed = false;
    const unsubscribeEvent = subscribe("session.message", (payload) => {
      const typedPayload = payload as SessionMessageEventPayload;
      if (typedPayload.sessionKey !== selectedSessionKey) return;
      if (typedPayload.runId) {
        setActiveRunId(typedPayload.runId);
      }
      setMessages((current) => mergeLiveMessage(current, typedPayload));
    });
    void sessionsMessagesSubscribe(selectedSessionKey).catch((nextError) => {
      if (!disposed) {
        setError(nextError instanceof Error ? nextError.message : "Failed to subscribe to session messages");
      }
    });
    return () => {
      disposed = true;
      unsubscribeEvent();
      void sessionsMessagesUnsubscribe(selectedSessionKey).catch(() => {});
    };
  }, [connected, selectedSessionKey, sessionsMessagesSubscribe, sessionsMessagesUnsubscribe, subscribe]);

  const handleSend = async () => {
    const message = composer.trim();
    if (!connected || !message || sending || !selectedSessionKey) return;
    setSending(true);
    try {
      const result = await chatSend(selectedSessionKey, message, {
        deliver: true,
      });
      if ("runId" in result && typeof result.runId === "string") {
        setActiveRunId(result.runId);
      }
      setComposer("");
      setError(null);
      await loadHistory(selectedSessionKey);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleAbort = async () => {
    if (!connected || aborting || !selectedSessionKey) return;
    setAborting(true);
    try {
      await chatAbort(selectedSessionKey, activeRunId ?? undefined);
      setActiveRunId(null);
      await loadHistory(selectedSessionKey);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to abort run");
    } finally {
      setAborting(false);
    }
  };

  return (
    <section className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-medium text-white/80">Chat With Jarvis</h2>
            <p className="text-xs text-white/35 mt-1">
              Direct OpenClaw Gateway chat using the selected session key.
            </p>
          </div>
          {showSessionPicker && (
            <div className="min-w-[16rem] flex-1 max-w-md">
              <label className="block text-[11px] text-white/35 mb-1">Session</label>
              <select
                value={selectedSessionKey}
                onChange={(event) => setSelectedSessionKey(event.target.value)}
                disabled={loadingSessions || sortedSessions.length === 0}
                className="w-full rounded border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/80"
              >
                {sortedSessions.map((session) => (
                  <option key={session.key} value={session.key}>
                    {sessionLabel(session)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-400 mt-3">{error}</p>
        )}
      </div>

      <div className="px-4 py-3 border-b border-white/5 bg-black/30">
        {!connected ? (
          <p className="text-xs text-white/35">Waiting for gateway connection…</p>
        ) : loadingHistory ? (
          <p className="text-xs text-white/35">Loading transcript…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-white/35">No messages yet.</p>
        ) : (
          <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
            {messages.map((message, index) => (
              <div key={message.id ?? `${message.role ?? "message"}-${index}`} className="space-y-1">
                <div className="flex items-center gap-2 text-[11px] text-white/35">
                  <span
                    className={
                      message.role === "assistant"
                        ? "text-green-400"
                        : message.role === "user"
                          ? "text-blue-400"
                          : "text-yellow-400"
                    }
                  >
                    {message.role ?? "unknown"}
                  </span>
                  {message.model && <span>{message.model}</span>}
                  {message.usage?.cost?.total != null && (
                    <span>${message.usage.cost.total.toFixed(4)}</span>
                  )}
                  <span className="ml-auto">{formatTimestamp(message.timestamp)}</span>
                </div>
                <div className="rounded border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-white/75 space-y-2">
                  {(message.content ?? []).map((block, blockIndex) => {
                    if (block.type === "text" && block.text) {
                      return (
                        <p key={blockIndex} className="whitespace-pre-wrap break-words">
                          {block.text}
                        </p>
                      );
                    }
                    if (block.type === "tool_use") {
                      return (
                        <div key={blockIndex} className="font-mono text-yellow-300/80">
                          tool: {block.name}
                        </div>
                      );
                    }
                    if (block.type === "tool_result" && block.content) {
                      return (
                        <div key={blockIndex} className="font-mono text-white/45 whitespace-pre-wrap break-words">
                          {block.content}
                        </div>
                      );
                    }
                    if (block.type === "thinking") {
                      return (
                        <div key={blockIndex} className="italic text-purple-300/50">
                          thinking…
                        </div>
                      );
                    }
                    return null;
                  })}
                  {message.errorMessage && (
                    <div className="text-red-400">{message.errorMessage}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          placeholder="Send a message to the selected OpenClaw session..."
          rows={4}
          className="w-full rounded border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/85 placeholder:text-white/20"
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[11px] text-white/30 font-mono">
            {selectedSessionKey}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAbort}
              disabled={!connected || aborting || !activeRunId}
              className={`px-3 py-2 rounded border text-xs ${
                !connected || aborting || !activeRunId
                  ? "border-white/10 text-white/25 cursor-not-allowed"
                  : "border-red-400/40 text-red-300 hover:bg-red-400/10"
              }`}
            >
              {aborting ? "Aborting…" : "Abort Run"}
            </button>
            <button
              onClick={handleSend}
              disabled={!connected || sending || composer.trim().length === 0}
              className={`px-3 py-2 rounded border text-xs ${
                !connected || sending || composer.trim().length === 0
                  ? "border-white/10 text-white/25 cursor-not-allowed"
                  : "border-white/20 text-white/75 hover:bg-white/[0.05]"
              }`}
            >
              {sending ? "Sending…" : "Send Message"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
