"use client";

import { useState, useEffect } from "react";

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

  if (loading) return <div className="px-6 py-3 text-xs text-white/30">Loading transcript…</div>;
  if (error) return <div className="px-6 py-3 text-xs text-red-400">Error: {error}</div>;

  const chatMessages = messages.filter((m) => m.role);
  if (chatMessages.length === 0) return <div className="px-6 py-3 text-xs text-white/30">No messages</div>;

  return (
    <div className="px-6 py-3 space-y-3 max-h-96 overflow-y-auto border-t border-white/5 bg-black/40">
      {chatMessages.map((msg, i) => (
        <div key={msg.id || i} className="text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`font-medium ${
                msg.role === "user" ? "text-blue-400" : "text-green-400"
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
                {msg.errorMessage}
              </span>
            )}
          </div>
          <div className="pl-2 border-l border-white/10 space-y-1">
            {msg.content.map((block, j) => {
              if (block.type === "text" && block.text) {
                return (
                  <p key={j} className="text-white/70 whitespace-pre-wrap break-words">
                    {block.text.length > 1000 ? block.text.slice(0, 1000) + "…" : block.text}
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
                  <div key={j} className="text-white/30 font-mono truncate">
                    ← {block.content?.slice(0, 200)}
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
        </div>
      ))}
    </div>
  );
}
