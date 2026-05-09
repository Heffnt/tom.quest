"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { debug } from "@/app/lib/debug";
import { resolveLlm, type Provider } from "../lib/models";

const log = debug.scoped("canvas.chat");

type LlmSetting = { provider: Provider; model: string };

function dateLabel(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  if (now - ts < 86_400_000) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString();
}

export default function ChatSidebar({
  canvasId,
  canvas,
}: {
  canvasId: Id<"canvases">;
  canvas: Doc<"canvases">;
}) {
  const { token, isTom } = useAuth();
  const [llmSetting] = usePersistedSettings<LlmSetting>("canvas:llm", {
    provider: "openai-oauth",
    model: "gpt-5.5",
  });
  const llm = resolveLlm(llmSetting, isTom);

  const chats = useQuery(api.canvas.listChats, { canvasId });
  const createChat = useMutation(api.canvas.createChat);
  const removeChat = useMutation(api.canvas.removeChat);
  const setActiveChat = useMutation(api.canvas.setActiveChat);
  const appendMessage = useMutation(api.canvas.appendMessage);

  const activeChatId = useMemo<Id<"canvasChats"> | null>(() => {
    if (canvas.activeChatId) return canvas.activeChatId as Id<"canvasChats">;
    if (chats && chats.length > 0) return chats[0]._id;
    return null;
  }, [canvas.activeChatId, chats]);

  const messages = useQuery(
    api.canvas.getMessages,
    activeChatId ? { chatId: activeChatId } : "skip",
  );

  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages grow.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length, running]);

  const onNewChat = async () => {
    const id = await createChat({ canvasId });
    setRunError(null);
    log.log("new chat", { id });
  };

  const onPickChat = async (id: Id<"canvasChats">) => {
    if (id === activeChatId) return;
    await setActiveChat({ canvasId, chatId: id });
    setRunError(null);
  };

  const onDeleteChat = async (id: Id<"canvasChats">) => {
    if (!confirm("Delete this chat?")) return;
    await removeChat({ chatId: id });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !activeChatId || running) return;
    setDraft("");
    setRunError(null);
    setRunning(true);
    const done = log.req("POST /api/canvas/agent", { chatId: activeChatId });
    try {
      await appendMessage({ chatId: activeChatId, kind: "user", content: text });
      const res = await fetch("/api/canvas/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          chatId: activeChatId,
          provider: llm.provider,
          model: llm.model,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          (body && typeof body.error === "string" && body.error) ||
          `Agent error (${res.status})`;
        setRunError(message);
        done.error(message, { status: res.status });
        return;
      }
      done({ status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent failed";
      setRunError(message);
      done.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <aside className="w-[28rem] max-w-[40vw] border-l border-border bg-bg flex flex-col min-h-0">
      <div className="border-b border-border p-2 flex items-center gap-2 overflow-x-auto">
        <button
          type="button"
          onClick={onNewChat}
          className="shrink-0 text-xs font-mono text-accent border border-accent/60 hover:bg-accent/10 rounded px-2 py-1"
        >
          + new chat
        </button>
        <ul className="flex gap-1 min-w-0">
          {(chats ?? []).map((c) => {
            const active = c._id === activeChatId;
            return (
              <li key={c._id} className="shrink-0">
                <div
                  className={`flex items-center text-xs font-mono rounded border transition-colors ${
                    active
                      ? "border-accent text-accent bg-accent/10"
                      : "border-border text-text-faint hover:text-text"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void onPickChat(c._id)}
                    className="px-2 py-1"
                  >
                    {dateLabel(c.createdAt)}
                  </button>
                  {active && (chats?.length ?? 0) > 1 && (
                    <button
                      type="button"
                      title="Delete chat"
                      onClick={() => void onDeleteChat(c._id)}
                      className="px-1.5 py-1 border-l border-border/40 hover:text-red-400"
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div ref={transcriptRef} className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-xs">
        {messages === undefined && (
          <div className="text-text-faint">Loading messages…</div>
        )}
        {messages && messages.length === 0 && !running && (
          <div className="text-text-faint">
            Tell the agent what this canvas should be.
          </div>
        )}
        {(messages ?? []).map((m) => (
          <MessageRow key={m._id} message={m} />
        ))}
        {running && (
          <div className="text-text-faint italic">agent is working…</div>
        )}
        {runError && (
          <div className="text-red-400 border border-red-400/40 rounded px-2 py-1">
            {runError}
          </div>
        )}
      </div>
      <form
        onSubmit={onSubmit}
        className="border-t border-border p-2 flex gap-2 items-end"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSubmit(e as unknown as React.FormEvent);
            }
          }}
          placeholder="say something to the agent…"
          rows={2}
          disabled={running}
          className="flex-1 resize-none bg-surface border border-border rounded px-2 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={running || !draft.trim()}
          className="text-xs font-mono text-accent border border-accent/60 hover:bg-accent/10 rounded px-3 py-1.5 disabled:opacity-30"
        >
          send
        </button>
      </form>
    </aside>
  );
}

function MessageRow({ message }: { message: Doc<"canvasMessages"> }) {
  const { kind, content, createdAt } = message;
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (kind === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="bg-accent/15 text-text rounded px-2 py-1.5 max-w-[90%] whitespace-pre-wrap break-words">
          {String(content)}
        </div>
        <span className="text-text-faint text-[10px] mt-0.5">{time}</span>
      </div>
    );
  }

  if (kind === "assistant_text") {
    return (
      <div className="flex flex-col items-start">
        <div className="bg-surface border border-border text-text rounded px-2 py-1.5 max-w-[95%] whitespace-pre-wrap break-words">
          {String(content)}
        </div>
        <span className="text-text-faint text-[10px] mt-0.5">{time}</span>
      </div>
    );
  }

  if (kind === "system_prompt") {
    return (
      <details className="text-text-faint border-l-2 border-border pl-2">
        <summary className="cursor-pointer">system prompt</summary>
        <pre className="whitespace-pre-wrap break-words mt-1 text-[11px]">
          {String(content)}
        </pre>
      </details>
    );
  }

  if (kind === "tool_call") {
    const c = content as { tool?: string; args?: unknown };
    return (
      <details className="text-text-faint border-l-2 border-accent/40 pl-2">
        <summary className="cursor-pointer">
          → <span className="text-accent">{c.tool ?? "tool"}</span>
        </summary>
        <pre className="whitespace-pre-wrap break-words mt-1 text-[11px]">
          {JSON.stringify(c.args ?? {}, null, 2)}
        </pre>
      </details>
    );
  }

  if (kind === "tool_result") {
    const c = content as { ok?: boolean; output?: unknown };
    const ok = c.ok !== false;
    return (
      <details className={`pl-2 border-l-2 ${ok ? "border-green-500/40 text-text-faint" : "border-red-500/40 text-red-400"}`}>
        <summary className="cursor-pointer">{ok ? "← ok" : "← error"}</summary>
        <pre className="whitespace-pre-wrap break-words mt-1 text-[11px]">
          {typeof c.output === "string"
            ? c.output
            : JSON.stringify(c.output ?? {}, null, 2)}
        </pre>
      </details>
    );
  }

  if (kind === "error") {
    return (
      <div className="text-red-400 border border-red-400/40 rounded px-2 py-1">
        {String(content)}
      </div>
    );
  }

  return null;
}
