"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface Message {
  id: string;
  timestamp: string;
  role: string;
  content: ContentBlock[];
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
  type?: string;
}

interface Props {
  sessionKey: string;
  bridgeFetch: (path: string) => Promise<Response>;
}

export default function TranscriptViewer({ sessionKey, bridgeFetch }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const encoded = encodeURIComponent(sessionKey);
        const res = await bridgeFetch(`/sessions/${encoded}/history?limit=100`);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (!cancelled) setMessages(data.messages || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionKey, bridgeFetch]);

  useEffect(() => {
    if (!loading && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [loading, messages.length]);

  const toggleMessage = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (loading) return <div className="px-6 py-3 text-xs text-white/30">Loading transcript…</div>;
  if (error) return <div className="px-6 py-3 text-xs text-red-400">Error: {error}</div>;

  const chatMessages = messages.filter((m) => m.role);
  if (chatMessages.length === 0) return <div className="px-6 py-3 text-xs text-white/30">No messages</div>;

  return (
    <div className="px-6 py-3 space-y-1 max-h-[32rem] overflow-y-auto border-t border-white/5 bg-black/40">
      {chatMessages.map((msg, i) => {
        const msgId = msg.id || String(i);
        const isCollapsed = collapsed.has(msgId);
        return (
          <div
            key={msgId}
            className="text-xs cursor-pointer hover:bg-white/[0.02] rounded px-2 py-1.5 -mx-2 transition-colors"
            onClick={() => toggleMessage(msgId)}
          >
            <div className="flex items-center gap-2">
              <span className="text-white/20 text-[10px] select-none">
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span
                className={`font-medium ${
                  msg.role === "user"
                    ? "text-blue-400"
                    : msg.role === "assistant"
                    ? "text-green-400"
                    : "text-yellow-400"
                }`}
              >
                {msg.role}
              </span>
              {msg.model && (
                <span className="text-white/20">{msg.model}</span>
              )}
              {msg.usage?.cost?.total != null && (
                <span className="text-white/20">
                  ${msg.usage.cost.total.toFixed(4)}
                </span>
              )}
              {msg.errorMessage && (
                <span className="text-red-400 truncate max-w-xs">
                  {msg.errorMessage.length > 80
                    ? msg.errorMessage.slice(0, 80) + "…"
                    : msg.errorMessage}
                </span>
              )}
              <span className="text-white/15 ml-auto text-[10px]">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            {!isCollapsed && (
              <div className="pl-5 mt-1 border-l border-white/10 space-y-1">
                {msg.content.map((block, j) => {
                  if (block.type === "text" && block.text) {
                    return (
                      <p key={j} className="text-white/70 whitespace-pre-wrap break-words">
                        {block.text}
                      </p>
                    );
                  }
                  if (block.type === "tool_use") {
                    const inputKeys = block.input && typeof block.input === "object"
                      ? Object.keys(block.input as Record<string, unknown>).join(", ")
                      : null;
                    return (
                      <div key={j} className="text-yellow-400/80 font-mono">
                        🔧 {block.name}
                        {inputKeys && (
                          <span className="text-white/20 ml-2">({inputKeys})</span>
                        )}
                      </div>
                    );
                  }
                  if (block.type === "tool_result") {
                    return (
                      <div key={j} className="text-white/30 font-mono whitespace-pre-wrap break-words">
                        ← {block.content}
                      </div>
                    );
                  }
                  if (block.type === "thinking") {
                    return (
                      <div key={j} className="text-purple-400/50 italic">
                        💭 thinking…
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
