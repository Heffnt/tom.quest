"use client";

// The new-session form of the sessions page's left column
// (app/sessions/components/session-list.tsx), with its Info popover naming its
// Convex call. The list that stood here went with the /agents page.

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import Info from "@/app/jarvis/components/info";
import { useOpenSession } from "@/app/lib/use-open-todo-session";
import { NO_REPO, SESSION_REPO_NAMES } from "@/convex/ttsShared";
import type { SessionModel } from "../lib";
import ModelSelect from "./model-select";
import { DEFAULT_SESSION_MODEL } from "../lib";

// The kinds Tom opens by hand from this form. A therapy session opens on no
// repo (the server refuses one that names a repo), so choosing it clears the
// picker and locks it.
const FORM_KINDS = ["adhoc", "weekly", "therapy"] as const;
type FormKind = (typeof FORM_KINDS)[number];

export function NewSessionForm({
  onCreated,
}: {
  onCreated: (id: Id<"claudeSessions">) => void;
}) {
  // The one launch hook (VQC C1) — the same one the TTS buttons use. This is
  // the surface that genuinely knows its repos (Tom picked them), so it is the
  // one that passes them explicitly; everywhere else the server resolves them.
  const { open: openSession, busy: creating, error } = useOpenSession();
  const [title, setTitle] = useState("");
  const [repos, setRepos] = useState<string[]>(["tom.quest"]);
  const [kind, setKind] = useState<FormKind>("adhoc");
  const [model, setModel] = useState<SessionModel>(DEFAULT_SESSION_MODEL);
  const [prompt, setPrompt] = useState("");

  const create = async () => {
    if (prompt.trim() === "" || creating) return;
    const text = prompt;
    await openSession({
      title,
      kind,
      // "none" is Tom's way of asking for an empty scratch workspace, and the
      // server reads the empty list as exactly that.
      repos: repos.filter((r) => r !== NO_REPO),
      model,
      initialPrompt: text,
      // The form navigates in place (onCreated) rather than into a new tab, so
      // it hands the hook a no-op reservation instead of letting it open one.
      tab: { goto: (id) => onCreated(id as Id<"claudeSessions">), close: () => {} },
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <div className="border border-border rounded-lg bg-surface/40 p-3 space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="title"
          className="flex-1 min-w-0 bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
        />
        {/* A session may hold MORE THAN ONE repo (Tom, 2026-08-30), so the
            picker is a toggle set rather than a dropdown: selecting none is the
            empty-scratch workspace. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SESSION_REPO_NAMES.map((r) => {
            const on = repos.includes(r);
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                disabled={kind === "therapy"}
                onClick={() =>
                  setRepos((prev) =>
                    prev.includes(r)
                      ? prev.filter((x) => x !== r)
                      : [...prev, r],
                  )
                }
                className={`rounded border px-2.5 py-2 text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                  on
                    ? "border-accent bg-accent-dim text-accent hover:brightness-125"
                    : "border-border bg-surface-alt text-text-muted hover:text-text hover:border-accent/60"
                }`}
              >
                {r}
              </button>
            );
          })}
          <span className="text-xs text-text-faint">
            {repos.length === 0 ? NO_REPO : `${repos.length} checked out`}
          </span>
        </div>
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as FormKind;
            setKind(next);
            if (next === "therapy") setRepos([]);
          }}
          className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
        >
          {FORM_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <ModelSelect ariaLabel="session model" value={model} onChange={setModel} />
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="initial prompt"
        className="w-full resize-y bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
      />
      {error && <div className="text-xs text-error">{error}</div>}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating || prompt.trim() === ""}
          className="rounded px-4 py-2 text-sm border border-accent text-accent hover:bg-surface-alt disabled:opacity-50"
        >
          Create session
        </button>
        <Info call="claudeSessions.createSession({ title, kind, repos, model, initialPrompt })">
          Writes the session row and its opening prompt. Nothing starts here —
          the daemon on the Jarvis Box claims the row on its next poll and runs
          it on the model named above; the model&rsquo;s family decides the
          runner, Claude Code or the Codex CLI.
        </Info>
      </div>
    </div>
  );
}
