"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUserSetting, saveUserSetting } from "../lib/userSettings";
import { debugFetch, logDebug } from "../lib/debug";

type ResultsTabProps = {
  userId?: string;
};

const RESULTS_FILE_PATH = "/home/ntheffernan/booleanbackdoors/ComplexMultiTrigger/output/results.html";
const RESULTS_STORAGE_KEY = "boolback_results_settings";

export default function ResultsTab({ userId }: ResultsTabProps) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const logSource = "BoolBackResults";

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      logDebug("lifecycle", "BoolBack results load start", { path: RESULTS_FILE_PATH }, logSource);
      const response = await debugFetch(`/api/turing/file?path=${encodeURIComponent(RESULTS_FILE_PATH)}`, {
        cache: "no-store",
        headers: userId ? { "x-user-id": userId } : undefined,
      });
      if (!response.ok) {
        const text = await response.text();
        setError(text || "Failed to load results page.");
        logDebug(
          "error",
          "BoolBack results load failed",
          { status: response.status, body: text },
          logSource
        );
        return;
      }
      const data = (await response.json()) as { content?: unknown };
      setHtml(typeof data.content === "string" ? data.content : "");
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "BoolBack results load failed", { message }, logSource);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const sendSavedSettings = useCallback(async () => {
    let settings: unknown | null = null;
    if (userId) {
      settings = await fetchUserSetting<unknown>(userId, RESULTS_STORAGE_KEY);
      logDebug("lifecycle", "Results settings loaded from Supabase", undefined, logSource);
    } else {
      try {
        const raw = localStorage.getItem(RESULTS_STORAGE_KEY);
        settings = raw ? JSON.parse(raw) : null;
      } catch {
        settings = null;
        logDebug("error", "Results settings parse failed", undefined, logSource);
      }
      logDebug("lifecycle", "Results settings loaded from localStorage", undefined, logSource);
    }
    if (!settings || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({ type: "loadSettings", settings }, "*");
  }, [userId]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== "saveSettings" || !event.data?.settings) return;
      if (userId) {
        void saveUserSetting(userId, RESULTS_STORAGE_KEY, event.data.settings);
        logDebug("lifecycle", "Results settings saved to Supabase", undefined, logSource);
      } else {
        localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(event.data.settings));
        logDebug("lifecycle", "Results settings saved to localStorage", undefined, logSource);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [userId]);

  useEffect(() => {
    if (!iframeLoaded) return;
    void sendSavedSettings();
  }, [iframeLoaded, sendSavedSettings]);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Results</h2>
          <p className="text-xs text-white/60 break-all">{RESULTS_FILE_PATH}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            logDebug("action", "BoolBack results refresh clicked", undefined, logSource);
            void loadFile();
          }}
          disabled={loading}
          className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
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
          title="BoolBack results preview"
          sandbox="allow-scripts"
          className="h-[70vh] w-full rounded-lg border border-white/10 bg-white"
          srcDoc={html}
          onLoad={() => {
            setIframeLoaded(true);
            void sendSavedSettings();
            logDebug("lifecycle", "BoolBack results iframe loaded", undefined, logSource);
          }}
        />
      )}
    </section>
  );
}
