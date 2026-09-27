"use client";

// The list: every session in triage order, or every root run in the record.
// The two words above the list are the whole label — `sessions` is the surface
// Tom talks to, `all roots` is everything else the record holds, and a row in
// either opens the same component.
//
// The new-session form is the list's action and carries its Info popover
// naming its Convex call.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import Info from "@/app/jarvis/components/info";
import { useOpenSession } from "@/app/lib/use-open-todo-session";
import { NO_REPO, SESSION_REPO_NAMES } from "@/convex/ttsShared";
import type { Session, SessionModel } from "../lib";
import ModelSelect from "./model-select";
import RecordStrip from "./record-strip";
import {
  DEFAULT_SESSION_MODEL,
  MODEL_CHIP_CLASS,
  ageText,
  costText,
  isLive,
  orderSessions,
  previewLine,
  runStatusChipClass,
  sessionModel,
  statusChipClass,
} from "../lib";

const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

// ── The box's load ─────────────────────────────────────────────────────────
// What the daemon's heartbeat says about the Jarvis Box. The switch that stood
// here, "start autonomous workers", went with the auto-session scheduler it
// turned on (2026-09-26): its idea, the box working Tom's todos on its own
// while it has room, is the box's work-queue job now.
function BoxLoadStrip() {
  const health = useQuery(api.claudeSessions.getDaemonHealth, {});
  const load = health?.load;
  if (!load) return null;
  return (
    <div className="border border-border rounded-lg bg-surface/40 px-3 py-2">
      <span className="font-mono text-[10px] text-text-faint">
        load {load.loadavg1.toFixed(2)}/{load.cpus} ·{" "}
        {(load.freeMemMb / 1024).toFixed(1)} GB free · {load.liveSessions}{" "}
        sessions
      </span>
    </div>
  );
}

// The kinds Tom opens by hand from this form. A therapy session opens on no
// repo (the server refuses one that names a repo), so choosing it clears the
// picker and locks it.
const FORM_KINDS = ["adhoc", "weekly", "therapy"] as const;
type FormKind = (typeof FORM_KINDS)[number];

function NewSessionForm({
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

const SOURCES = ["sessions", "all roots"] as const;
type Source = (typeof SOURCES)[number];

const FILTERS = ["all", "live", "autonomous", "ended"] as const;
type Filter = (typeof FILTERS)[number];

function matchesFilter(s: Session, filter: Filter): boolean {
  switch (filter) {
    case "live":
      return isLive(s.status);
    case "autonomous":
      return s.mode === "autonomous";
    case "ended":
      return !isLive(s.status);
    case "all":
      return true;
  }
}

/** Every root agent the record holds, newest first — agents.roots is capped. */
function RootRuns({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const roots = useQuery(api.agents.roots, {});
  if (roots === undefined) {
    return <div className="text-sm text-text-faint">loading agents…</div>;
  }
  if (roots.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
        no agents
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="border border-border rounded-lg bg-surface/40 divide-y divide-border">
        {roots.map((run) => (
          <li key={run.runId}>
            <button
              type="button"
              onClick={() => onOpenRun(run.runId)}
              className="w-full text-left px-3 sm:px-4 py-2.5 hover:bg-surface-alt space-y-1"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-text truncate min-w-0 break-all">
                  {run.runId}
                </span>
                <span
                  className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${runStatusChipClass(run.status)}`}
                >
                  {run.status}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-text-faint">
                <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">
                  {run.kind}
                </span>
                <span>{run.origin}</span>
                <span>{run.host}</span>
                {run.model !== undefined && (
                  <span className={MODEL_CHIP_CLASS}>{run.model}</span>
                )}
                <span className="font-mono">
                  {new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")}
                </span>
                {costText(run.outcome?.costUsd) !== "" && (
                  <span className="font-mono">{costText(run.outcome?.costUsd)}</span>
                )}
              </div>
              {run.outcome?.endedReason !== undefined && (
                <div className="text-xs text-text-muted">
                  {previewLine(run.outcome.endedReason.split("\n")[0], 90)}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
      {/* The same claim listSessions makes about its own hundred. */}
      <div className="text-xs text-text-faint">showing the latest 50 root agents</div>
    </div>
  );
}

export default function AgentList({
  sessions,
  now,
  onOpenSession,
  onOpenRun,
}: {
  sessions: Session[] | undefined;
  now: number;
  onOpenSession: (id: Id<"claudeSessions">) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [source, setSource] = useState<Source>("sessions");
  const [filter, setFilter] = useState<Filter>("all");
  const [formOpen, setFormOpen] = useState(false);

  const ordered =
    sessions === undefined
      ? undefined
      : orderSessions(sessions.filter((s) => matchesFilter(s, filter)));

  return (
    <div className="space-y-4">
      <BoxLoadStrip />
      {formOpen ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setFormOpen(false)}
            className={btnCls}
          >
            Close
          </button>
          <NewSessionForm onCreated={onOpenSession} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="rounded px-3 py-1.5 text-sm border border-accent text-accent hover:bg-surface-alt"
        >
          New session
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`rounded px-2 py-0.5 text-xs border ${
              source === s
                ? "border-accent text-accent"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {s}
          </button>
        ))}
        {source === "sessions" &&
          FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 text-xs border ${
                filter === f
                  ? "border-accent text-accent"
                  : "border-border text-text-muted hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
      </div>
      <RecordStrip />
      {source === "all roots" ? (
        <RootRuns onOpenRun={onOpenRun} />
      ) : ordered === undefined ? (
        <div className="text-sm text-text-faint">loading sessions…</div>
      ) : ordered.length === 0 ? (
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          no sessions
        </div>
      ) : (
        <>
          <ul className="border border-border rounded-lg bg-surface/40 divide-y divide-border">
            {ordered.map((s) => (
              <li key={s._id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(s._id)}
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
                    {s.mode === "autonomous" && (
                      <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">
                        autonomous
                      </span>
                    )}
                    {/* Always shown, including the "opus" a pre-model row ran
                        on: which model did this is a fact of every session, and
                        a chip that appears only sometimes reads as a flag. */}
                    <span className={MODEL_CHIP_CLASS}>{sessionModel(s)}</span>
                    <span>{s.repo}</span>
                    <span>{ageText(s.statusChangedAt, now)}</span>
                  </div>
                  {/* What an ended session came to, in the row itself. */}
                  {!isLive(s.status) && s.outcomeSummary !== undefined && (
                    <div className="text-xs text-text-muted">
                      {previewLine(s.outcomeSummary, 90)}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {sessions !== undefined && sessions.length === 100 && (
            <div className="text-xs text-text-faint">
              showing the latest 100 sessions
            </div>
          )}
        </>
      )}
    </div>
  );
}
