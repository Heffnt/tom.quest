"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ProjectViewerProps = {
  title: string;
  filePath: string;
};

function getStorageKey(filePath: string) {
  return `project_settings_${filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

export default function ProjectViewer({ title, filePath }: ProjectViewerProps) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const storageKey = getStorageKey(filePath);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/turing/file?path=${encodeURIComponent(filePath)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || "Failed to load file.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setHtml(typeof data.content === "string" ? data.content : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // Listen for settings from iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "saveSettings" && event.data?.settings) {
        localStorage.setItem(storageKey, JSON.stringify(event.data.settings));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [storageKey]);

  // Send saved settings to iframe when it loads
  const handleIframeLoad = useCallback(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved && iframeRef.current?.contentWindow) {
      try {
        const settings = JSON.parse(saved);
        iframeRef.current.contentWindow.postMessage({ type: "loadSettings", settings }, "*");
      } catch {
        // Ignore parse errors
      }
    }
  }, [storageKey]);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col px-4 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-xs text-white/60 break-all">{filePath}</p>
        </div>
        <button
          type="button"
          onClick={loadFile}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={`${title} preview`}
          sandbox="allow-scripts"
          className="w-full flex-1 rounded-lg border border-white/10 bg-white"
          srcDoc={html}
          onLoad={handleIframeLoad}
        />
      )}
    </div>
  );
}
