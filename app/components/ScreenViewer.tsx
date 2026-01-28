"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useWebSocket } from "../hooks/useWebSocket";

interface ScreenViewerProps {
  screenName: string;
  wsBaseUrl: string | null;
  apiKey: string;
}

export function ScreenViewer({ screenName, wsBaseUrl, apiKey }: ScreenViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fullWsUrl = wsBaseUrl ? `${wsBaseUrl}/ws/screens/${encodeURIComponent(screenName)}?api_key=${encodeURIComponent(apiKey)}` : null;

  const handleMessage = useCallback((data: string) => {
    setOutput(data);
  }, []);

  const { status, send, connect, disconnect } = useWebSocket(fullWsUrl, {
    onMessage: handleMessage,
    autoConnect: false,
  });

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (expanded && status === "disconnected" && fullWsUrl) {
      connect();
    }
  }, [expanded, status, fullWsUrl, connect]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && input.trim()) {
      send(input);
      setInput("");
    } else if (e.key === "c" && e.ctrlKey) {
      send("\x03");
    }
  };

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-white/5 hover:bg-white/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">{screenName}</span>
          <span className={`w-2 h-2 rounded-full ${
            status === "connected" ? "bg-green-400" :
            status === "connecting" ? "bg-yellow-400" : "bg-white/20"
          }`} />
        </div>
        <span className="text-white/40">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="border-t border-white/10">
          {status === "disconnected" ? (
            <div className="p-4 flex items-center justify-center">
              <button
                onClick={connect}
                disabled={!fullWsUrl}
                className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
              >
                Connect
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-end px-2 py-1 border-b border-white/5 bg-white/5">
                <button
                  onClick={() => setOutput("")}
                  className="px-2 py-1 text-xs text-white/40 hover:text-white/60 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={disconnect}
                  className="px-2 py-1 text-xs text-red-400/60 hover:text-red-400 transition-colors"
                >
                  Disconnect
                </button>
              </div>
              <div
                ref={terminalRef}
                className="h-48 overflow-y-auto p-3 font-mono text-xs whitespace-pre-wrap break-all bg-black/50"
              >
                {output || <span className="text-white/30">Waiting for output...</span>}
              </div>
              <div className="border-t border-white/10 flex items-center bg-black/30">
                <span className="px-2 text-green-400 text-xs">$</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Send command to screen..."
                  className="flex-1 px-2 py-2 bg-transparent text-white text-xs font-mono focus:outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
