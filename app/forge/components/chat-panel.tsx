"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { useTuring } from "@/app/lib/hooks/use-turing";
import type { ServeStatus, ChatResponse } from "../types";

const SERVE_POLL_SECONDS = 5;

export default function ChatPanel({
  jobId,
  onClose,
}: {
  jobId: Id<"forgeJobs">;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const job = useQuery(api.forge.getJob, { id: jobId });
  const messages = useQuery(api.forge.listMessages, { jobId });
  const appendMessage = useMutation(api.forge.appendMessage);
  const setServe = useMutation(api.forge.setServe);

  const runId = job?.runId;
  const isReady = job?.serveStatus === "ready";

  // Poll serve readiness until the vLLM server reports up; stop once ready.
  const serve = useTuring<ServeStatus>(runId ? `/forge/serve/${runId}` : "/forge/serve/_", {
    refreshInterval: runId && !isReady ? SERVE_POLL_SECONDS : undefined,
  });

  // Mirror serve readiness into Convex so the row + this panel agree.
  const lastServeStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!serve.data || !job) return;
    const s = serve.data.status;
    if (s === lastServeStatus.current) return;
    lastServeStatus.current = s;
    if (s !== job.serveStatus) {
      void setServe({
        id: jobId,
        session: job.serveSession,
        baseUrl: serve.data.base_url || job.serveBaseUrl,
        status: s,
      });
    }
  }, [serve.data, job, jobId, setServe]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll only the transcript list, only when messages grow (matches canvas chat).
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length, sending]);

  const ready = serve.data?.status === "ready" || isReady;
  const stopped = serve.data?.status === "stopped";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !runId || sending) return;
    if (!ready) {
      setChatError("The model server is not ready yet.");
      return;
    }
    setDraft("");
    setChatError(null);
    setSending(true);
    try {
      await appendMessage({ jobId, role: "user", content: text });
      const history = (messages ?? []).map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/turing/forge/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          run_id: runId,
          messages: [...history, { role: "user", content: text }],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setChatError(body.error || `Chat error (${res.status})`);
        return;
      }
      const payload = (await res.json()) as ChatResponse;
      const content = payload.message?.content ?? "";
      await appendMessage({ jobId, role: "assistant", content });
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Chat failed.");
    } finally {
      setSending(false);
    }
  };

  const statusLabel = useMemo(() => {
    if (stopped) return "server stopped";
    if (ready) return "ready";
    return "starting…";
  }, [ready, stopped]);

  return (
    <section aria-label="Chat with the model" className="border border-border rounded-lg bg-surface/40 flex flex-col">
      <div className="border-b border-border p-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Chat</h2>
          <p className="text-xs text-text-faint font-mono">
            {job?.name ?? "…"} · <span className={ready ? "text-accent" : "text-text-muted"}>{statusLabel}</span>
          </p>
        </div>
        <button type="button" onClick={onClose}
          className="text-xs px-3 py-1.5 rounded border border-border text-text-muted hover:text-text">
          Close
        </button>
      </div>

      <div ref={transcriptRef} className="overflow-y-auto p-3 space-y-2 font-mono text-xs max-h-[24rem]">
        {messages === undefined && <div className="text-text-faint">Loading messages…</div>}
        {messages && messages.length === 0 && (
          <div className="text-text-faint">
            {ready ? "Say something to the backdoored model." : "Waiting for the model server to come up…"}
          </div>
        )}
        {(messages ?? []).map((m) => (
          <MessageRow key={m._id} role={m.role} content={m.content} createdAt={m.createdAt} />
        ))}
        {sending && <div className="text-text-faint italic">model is responding…</div>}
        {chatError && (
          <div className="text-error border border-error/40 rounded px-2 py-1">{chatError}</div>
        )}
        {serve.error && !ready && (
          <div className="text-text-faint">serve status: {serve.error}</div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-border p-2 flex gap-2 items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSubmit(e as unknown as React.FormEvent);
            }
          }}
          placeholder={ready ? "message the model…" : "waiting for the server…"}
          rows={2}
          disabled={sending || !ready}
          className="flex-1 resize-none bg-bg border border-border rounded px-2 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        <button type="submit" disabled={sending || !ready || !draft.trim()}
          className="text-xs font-mono text-accent border border-accent/60 hover:bg-accent/10 rounded px-3 py-1.5 disabled:opacity-30">
          send
        </button>
      </form>
    </section>
  );
}

function MessageRow({ role, content, createdAt }: { role: string; content: string; createdAt: number }) {
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="bg-accent/15 text-text rounded px-2 py-1.5 max-w-[90%] whitespace-pre-wrap break-words">
          {content}
        </div>
        <span className="text-text-faint text-[10px] mt-0.5">{time}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <div className="bg-bg border border-border text-text rounded px-2 py-1.5 max-w-[95%] whitespace-pre-wrap break-words">
        {content}
      </div>
      <span className="text-text-faint text-[10px] mt-0.5">{time}</span>
    </div>
  );
}
