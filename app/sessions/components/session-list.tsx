"use client";

// List view: every session in triage order, a filter row, and the
// new-session form behind a button. Browser-created sessions are ad hoc or
// weekly — gate / focus-item / block sessions are created by the system.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import Info from "@/app/tts/components/info";
import { useOpenSession } from "@/app/lib/use-open-todo-session";
import { NO_REPO, SESSION_REPO_NAMES } from "@/convex/ttsShared";
import type { Session, SessionModel, SessionStatus } from "../lib";
import ModelSelect from "./model-select";
import {
  DEFAULT_SESSION_MODEL,
  MODEL_CHIP_CLASS,
  ageText,
  isLive,
  previewLine,
  sessionModel,
  statusChipClass,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-xs text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

// ── Autonomous fleet: the scheduler's admission settings + the Jarvis Box load
// they are compared against. Load-based admission is the primary throttle;
// maxLiveAutonomous is a runaway failsafe and maxNewPerTick a clone-burst
// bound, which is why the load line sits next to the switch ────────────────
type Draft = {
  enabled: boolean;
  defaultModel: SessionModel;
  maxLoadPerCpu: string;
  minFreeMemMb: string;
  maxLiveAutonomous: string;
  maxNewPerTick: string;
};

// The label IS the schema field name — the caption behind ⓘ names the call
// (UI = code), so the fields need no prose of their own.
function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-baseline gap-1.5">
      <span className="text-[10px] font-mono text-text-faint w-32 shrink-0">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} w-24`}
      />
    </label>
  );
}

function AutoFleetStrip() {
  const config = useQuery(api.claudeSessions.getAutoConfig, {});
  const health = useQuery(api.claudeSessions.getDaemonHealth, {});
  const setAutoConfig = useMutation(api.claudeSessions.setAutoConfig);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // getAutoConfig answers with the defaults when no row has been written, so
  // a falsy value here means the query has not landed yet.
  if (!config) return null;

  // Opening seeds the editor from the stored config; a live update while a
  // field is being typed must not clobber the draft.
  const openEditor = () => {
    setError(null);
    setDraft({
      enabled: config.enabled,
      defaultModel: config.defaultModel,
      maxLoadPerCpu: String(config.maxLoadPerCpu),
      minFreeMemMb: String(config.minFreeMemMb),
      maxLiveAutonomous: String(config.maxLiveAutonomous),
      maxNewPerTick: String(config.maxNewPerTick),
    });
  };

  const save = async () => {
    if (draft === null || busy) return;
    const numbers = {
      maxLoadPerCpu: Number(draft.maxLoadPerCpu),
      minFreeMemMb: Number(draft.minFreeMemMb),
      maxLiveAutonomous: Number(draft.maxLiveAutonomous),
      maxNewPerTick: Number(draft.maxNewPerTick),
    };
    if (Object.values(numbers).some((n) => !Number.isFinite(n))) {
      setError("numbers only");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setAutoConfig({
        enabled: draft.enabled,
        defaultModel: draft.defaultModel,
        ...numbers,
      });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const load = health?.load;

  return (
    <div className="border border-border rounded-lg bg-surface/40 px-3 py-2 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`text-xs ${config.enabled ? "text-accent" : "text-text-muted"}`}
        >
          auto {config.enabled ? "on" : "off"}
        </span>
        {/* The model an autonomous session runs on when the todo it claimed
            named none of its own — a fact of the fleet, so it reads in the
            strip beside the switch, not only inside the editor. */}
        <span className={MODEL_CHIP_CLASS}>{config.defaultModel}</span>
        {load && (
          <span className="font-mono text-[10px] text-text-faint">
            load {load.loadavg1.toFixed(2)}/{load.cpus} ·{" "}
            {(load.freeMemMb / 1024).toFixed(1)} GB free · {load.liveSessions}{" "}
            sessions
          </span>
        )}
        <button
          type="button"
          onClick={draft === null ? openEditor : () => setDraft(null)}
          className="ml-auto text-[10px] text-text-faint hover:text-text-muted"
        >
          {draft === null ? "edit" : "close"}
        </button>
      </div>
      {draft !== null && (
        <div className="space-y-1.5 border-t border-border pt-1.5">
          <label className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-mono text-text-faint w-32 shrink-0">
              enabled
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
              className="accent-accent"
            />
          </label>
          {/* Same label-is-the-field-name shape as the numbers: the schema
              field is `defaultModel`, and the ⓘ below names the call. */}
          <label className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-mono text-text-faint w-32 shrink-0">
              defaultModel
            </span>
            <ModelSelect
              ariaLabel="fleet default model"
              compact
              value={draft.defaultModel}
              onChange={(m) => setDraft({ ...draft, defaultModel: m })}
            />
          </label>
          <NumField
            label="maxLoadPerCpu"
            value={draft.maxLoadPerCpu}
            onChange={(v) => setDraft({ ...draft, maxLoadPerCpu: v })}
          />
          <NumField
            label="minFreeMemMb"
            value={draft.minFreeMemMb}
            onChange={(v) => setDraft({ ...draft, minFreeMemMb: v })}
          />
          <NumField
            label="maxLiveAutonomous"
            value={draft.maxLiveAutonomous}
            onChange={(v) => setDraft({ ...draft, maxLiveAutonomous: v })}
          />
          <NumField
            label="maxNewPerTick"
            value={draft.maxNewPerTick}
            onChange={(v) => setDraft({ ...draft, maxNewPerTick: v })}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className={btnCls}
            >
              Save
            </button>
            <Info call="claudeSessions.setAutoConfig({ enabled, defaultModel, maxLoadPerCpu, minFreeMemMb, maxLiveAutonomous, maxNewPerTick })">
              How hard the fleet is allowed to work, and which model it works
              on. Every five minutes the scheduler walks your open work and
              opens sessions for it, but only while the Jarvis Box is under
              these load and memory numbers — load is the real throttle, the
              two counts are runaway failsafes. defaultModel is what a session
              runs on when the item it claimed named no model of its own.
            </Info>
          </div>
          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

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
  const [kind, setKind] = useState<"adhoc" | "weekly">("adhoc");
  // Tom picks the model for his own sessions (ratified 2026-09-04). Same
  // reasoning as repos: this is the surface that genuinely knows, so it names
  // the model rather than letting the server default stand.
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
            picker is a toggle set rather than a dropdown: selecting none is
            the empty-scratch workspace. Each chip changes on hover and states
            its selected state with the accent fill, per the ratified UI
            rules. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SESSION_REPO_NAMES.map((r) => {
            const on = repos.includes(r);
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setRepos((prev) =>
                    prev.includes(r)
                      ? prev.filter((x) => x !== r)
                      : [...prev, r],
                  )
                }
                className={`rounded border px-2.5 py-2 text-sm transition-colors ${
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
          onChange={(e) => setKind(e.target.value as "adhoc" | "weekly")}
          className="bg-surface-alt border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
        >
          <option value="adhoc">adhoc</option>
          <option value="weekly">weekly</option>
        </select>
        <ModelSelect
          ariaLabel="session model"
          value={model}
          onChange={setModel}
        />
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

// The list is a triage surface — needs-you outranks recency. Bands, top to
// bottom: waiting on Tom, running, spinning up, idle, over.
const TRIAGE_BAND: Record<SessionStatus, number> = {
  "awaiting-permission": 0,
  running: 1,
  starting: 2,
  requested: 2,
  idle: 3,
  ended: 4,
  failed: 4,
};

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

export default function SessionList({
  sessions,
  now,
  onOpen,
}: {
  sessions: Session[] | undefined;
  now: number;
  onOpen: (id: Id<"claudeSessions">) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [formOpen, setFormOpen] = useState(false);

  if (sessions === undefined) {
    return <div className="text-sm text-text-faint">loading sessions…</div>;
  }

  // Within a band: the longest-waiting permission sits at the very top, the
  // terminal band reads newest-first, and everything else keeps listSessions'
  // own newest-first order (Array.prototype.sort is stable).
  const ordered = sessions
    .filter((s) => matchesFilter(s, filter))
    .sort((a, b) => {
      const band = TRIAGE_BAND[a.status] - TRIAGE_BAND[b.status];
      if (band !== 0) return band;
      if (TRIAGE_BAND[a.status] === 0)
        return a.statusChangedAt - b.statusChangedAt;
      if (TRIAGE_BAND[a.status] === 4) return b.createdAt - a.createdAt;
      return 0;
    });

  return (
    <div className="space-y-4">
      <AutoFleetStrip />
      {formOpen ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setFormOpen(false)}
            className={btnCls}
          >
            Close
          </button>
          <NewSessionForm onCreated={onOpen} />
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
        {FILTERS.map((f) => (
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
      {ordered.length === 0 ? (
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          no sessions
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
                  {s.mode === "autonomous" && (
                    <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">
                      autonomous
                    </span>
                  )}
                  {/* Always shown, including the "opus" a pre-model row ran
                      on: which model did this — is a fact of every session,
                      and a chip that appears only sometimes reads as a flag. */}
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
      )}
      {sessions.length === 100 && (
        <div className="text-xs text-text-faint">
          showing the latest 100 sessions
        </div>
      )}
    </div>
  );
}
