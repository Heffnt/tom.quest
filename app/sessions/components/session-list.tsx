"use client";

// List view: every session (live first), plus the new-session form.
// Browser-created sessions are ad hoc by definition — gate / focus-item /
// weekly sessions are created by the system with a todoId attached.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Session } from "../lib";
import { REPO_OPTIONS, ageText, isLive, statusChipClass } from "../lib";

function NewSessionForm({
  onCreated,
}: {
  onCreated: (id: Id<"claudeSessions">) => void;
}) {
  const createSession = useMutation(api.claudeSessions.createSession);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState<string>("tom.quest");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (prompt.trim() === "" || creating) return;
    setCreating(true);
    setError(null);
    try {
      const id = await createSession({
        title,
        kind: "adhoc",
        repo,
        initialPrompt: prompt,
      });
      setTitle("");
      setPrompt("");
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border border-border rounded-lg bg-surface/40 p-3 space-y-2">
      <div className="text-sm text-text">New session</div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="title"
          className="flex-1 min-w-0 bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
        />
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
        >
          {REPO_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="initial prompt"
        className="w-full resize-y bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
      />
      {error && <div className="text-xs text-error">{error}</div>}
      <button
        type="button"
        onClick={() => void create()}
        disabled={creating || prompt.trim() === ""}
        className="rounded px-4 py-2 text-sm border border-accent text-accent hover:bg-surface-alt disabled:opacity-50"
      >
        Create session
      </button>
    </div>
  );
}

export default function SessionList({
  sessions,
  now,
  onOpen,
}: {
  sessions: Session[] | undefined;
  now: number;
  onOpen: (id: Id<"claudeSessions">) => void;
}) {
  if (sessions === undefined) {
    return <div className="text-sm text-text-faint">loading sessions…</div>;
  }

  // listSessions is newest-first; live sessions float above the rest,
  // relative order preserved.
  const ordered = [
    ...sessions.filter((s) => isLive(s.status)),
    ...sessions.filter((s) => !isLive(s.status)),
  ];

  return (
    <div className="space-y-4">
      <NewSessionForm onCreated={onOpen} />
      {ordered.length === 0 ? (
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          no sessions yet
        </div>
      ) : (
        <ul className="border border-border rounded-lg bg-surface/40 divide-y divide-border">
          {ordered.map((s) => (
            <li key={s._id}>
              <button
                type="button"
                onClick={() => onOpen(s._id)}
                className="w-full text-left px-3 sm:px-4 py-2.5 hover:bg-surface-alt space-y-1"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-text truncate min-w-0">
                    {s.title}
                  </span>
                  <span
                    className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${statusChipClass(s.status)}`}
                  >
                    {s.status}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-text-faint">
                  <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">
                    {s.kind}
                  </span>
                  <span>{s.repo}</span>
                  <span>{ageText(s.statusChangedAt, now)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
