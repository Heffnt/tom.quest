"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useTuring } from "@/app/lib/hooks/use-turing";
import { GPUTypeInfo, gpuTypeLabel } from "../types";

// Mirrors the convex `gpuPool` table. Declared locally (rather than importing
// Doc<"gpuPool">) so the component typechecks before the schema is regenerated
// on deploy; useQuery returns `any` via the anyApi proxy until then.
type PoolConfig = {
  _id: string;
  gpuType: string;
  desiredCount: number;
  timeMins: number;
  memoryMb: number;
  commands: string[];
  projectDir: string;
  jobName: string;
  enabled: boolean;
};

type Draft = {
  gpuType: string;
  desiredCount: string;
  timeMins: string;
  memoryMb: string;
  projectDir: string;
  jobName: string;
  commands: string[];
  enabled: boolean;
};

const BLANK_DRAFT: Draft = {
  gpuType: "",
  desiredCount: "1",
  timeMins: "60",
  memoryMb: "64000",
  projectDir: "",
  jobName: "pool",
  commands: [""],
  enabled: true,
};

const inputClass =
  "w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none";

function draftFromConfig(config: PoolConfig): Draft {
  return {
    gpuType: config.gpuType,
    desiredCount: String(config.desiredCount),
    timeMins: String(config.timeMins),
    memoryMb: String(config.memoryMb),
    projectDir: config.projectDir,
    jobName: config.jobName,
    commands: config.commands.length ? [...config.commands] : [""],
    enabled: config.enabled,
  };
}

export default function PoolPanel() {
  const pools = (useQuery(api.gpuPool.list) ?? []) as PoolConfig[];
  const setPool = useMutation(api.gpuPool.set);
  const removePool = useMutation(api.gpuPool.remove);
  const gpuTypes = useTuring<{ types: GPUTypeInfo[] }>("/gpu-types");

  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  // The gpuType being edited, or null when composing a new pool. gpuType is the
  // upsert key, so it is fixed while editing an existing row.
  const [editingType, setEditingType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // pools is a live reactive query while editingType is local. If the row being
  // edited is deleted elsewhere (another admin or tab), saving would silently
  // re-create it via set's upsert. Detect that and relabel the action honestly
  // rather than wiping the in-progress form (which would itself move the UI).
  const editingMissing =
    editingType !== null && !pools.some((p) => p.gpuType === editingType);

  const startNew = () => {
    setEditingType(null);
    setDraft(BLANK_DRAFT);
    setError(null);
  };

  const startEdit = (config: PoolConfig) => {
    setEditingType(config.gpuType);
    setDraft(draftFromConfig(config));
    setError(null);
  };

  const validate = (): string | null => {
    if (!draft.gpuType) return "Select a GPU type.";
    const desired = Number(draft.desiredCount);
    if (!Number.isInteger(desired) || desired < 0) return "Desired count must be 0 or more.";
    const mins = Number(draft.timeMins);
    if (!Number.isInteger(mins) || mins < 1) return "Walltime must be at least 1 minute.";
    const mem = Number(draft.memoryMb);
    if (!Number.isInteger(mem) || mem < 1) return "Memory must be a positive integer.";
    return null;
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setPool({
        gpuType: draft.gpuType,
        desiredCount: Number(draft.desiredCount),
        timeMins: Number(draft.timeMins),
        memoryMb: Number(draft.memoryMb),
        commands: draft.commands.filter((c) => c.trim()),
        projectDir: draft.projectDir,
        jobName: draft.jobName.trim() || "pool",
        enabled: draft.enabled,
      });
      startNew();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save pool");
    } finally {
      setSaving(false);
    }
  };

  // Toggling enabled is a one-field change, but `set` upserts the whole row, so
  // we resend the existing config with `enabled` flipped.
  const toggleEnabled = async (config: PoolConfig) => {
    setError(null);
    try {
      await setPool({
        gpuType: config.gpuType,
        desiredCount: config.desiredCount,
        timeMins: config.timeMins,
        memoryMb: config.memoryMb,
        commands: config.commands,
        projectDir: config.projectDir,
        jobName: config.jobName,
        enabled: !config.enabled,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update pool");
    }
  };

  const remove = async (gpuType: string) => {
    setError(null);
    try {
      await removePool({ gpuType });
      if (editingType === gpuType) startNew();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove pool");
    }
  };

  const updateCommand = (index: number, value: string) => {
    setDraft((d) => {
      const commands = [...d.commands];
      commands[index] = value;
      return { ...d, commands };
    });
  };

  return (
    <section aria-label="GPU Pool" className="border border-border rounded-lg p-5 bg-surface/40">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">GPU Pool</h2>
      </div>
      <p className="text-text-muted text-sm mb-4">
        Declarative desired state: a Convex cron keeps each enabled pool at its desired number of
        GPUs, re-allocating as jobs finish and cancelling the most idle when over.
      </p>

      {pools.length === 0 ? (
        <p className="text-text-faint text-sm mb-4">No pools configured.</p>
      ) : (
        <div className="space-y-2 mb-5">
          {pools.map((pool) => (
            <div
              key={pool._id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-border/60 rounded-md p-3 bg-bg/40"
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-medium">{gpuTypeLabel(pool.gpuType)}</span>
                <span className="text-text-faint text-xs font-mono">{pool.jobName}</span>
              </div>
              <span className="text-sm text-text-muted">
                desired <span className="text-text font-mono">{pool.desiredCount}</span>
              </span>
              {pool.commands.length > 0 && (
                <span className="text-xs text-text-faint font-mono truncate max-w-[16rem]" title={pool.commands.join(" ; ")}>
                  {pool.commands.join(" ; ")}
                </span>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => void toggleEnabled(pool)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-all duration-150 font-medium ${
                    pool.enabled
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-border text-text-muted hover:text-text hover:border-text-muted"
                  }`}
                >
                  {pool.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(pool)}
                  className="text-xs px-3 py-1.5 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors font-medium tracking-wide"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(pool.gpuType)}
                  className="text-xs px-3 py-1 rounded border border-error/40 text-error hover:bg-error/10 transition-colors duration-150"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3 border border-border/60 rounded-lg p-4 bg-bg/40">
        <span className="text-xs text-text-faint uppercase tracking-wide">
          {editingType ? `Edit pool — ${gpuTypeLabel(editingType)}` : "Add pool"}
        </span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted mb-1">GPU type</span>
            {editingType ? (
              <input type="text" value={gpuTypeLabel(editingType)} disabled className={`${inputClass} opacity-60`} />
            ) : (
              <select
                value={draft.gpuType}
                onChange={(e) => setDraft({ ...draft, gpuType: e.target.value })}
                className={inputClass}
              >
                <option value="">—</option>
                {gpuTypes.data?.types.map((t) => (
                  <option key={t.type} value={t.type}>
                    {gpuTypeLabel(t.type)} ({t.count} free)
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Desired count</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.desiredCount}
              onChange={(e) => setDraft({ ...draft, desiredCount: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Walltime (min)</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.timeMins}
              onChange={(e) => setDraft({ ...draft, timeMins: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Memory (MB)</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.memoryMb}
              onChange={(e) => setDraft({ ...draft, memoryMb: e.target.value })}
              className={inputClass}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Job name</span>
            <input
              type="text"
              value={draft.jobName}
              onChange={(e) => setDraft({ ...draft, jobName: e.target.value })}
              className={`${inputClass} font-mono text-sm`}
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Project directory</span>
            <input
              type="text"
              value={draft.projectDir}
              onChange={(e) => setDraft({ ...draft, projectDir: e.target.value })}
              placeholder="/home/..."
              className={`${inputClass} font-mono text-sm`}
            />
          </label>
        </div>
        <div className="space-y-1">
          <span className="block text-text-muted text-sm mb-1">Commands</span>
          {draft.commands.map((cmd, i) => (
            <div key={i} className="flex gap-1.5">
              <input
                type="text"
                value={cmd}
                onChange={(e) => updateCommand(i, e.target.value)}
                placeholder="command"
                className="flex-1 bg-bg border border-border rounded px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none"
              />
              {draft.commands.length > 1 && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, commands: draft.commands.filter((_, j) => j !== i) })}
                  className="text-text-faint hover:text-error text-xs px-1"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDraft({ ...draft, commands: [...draft.commands, ""] })}
            className="text-[10px] text-text-faint hover:text-accent"
          >
            + command
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="accent-accent"
          />
          Enabled (reconciler maintains this pool)
        </label>

        {editingMissing && (
          <p className="text-warning text-sm">
            This pool was removed elsewhere — saving will re-create it.
          </p>
        )}
        {error && <p className="text-error text-sm">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="bg-accent text-bg font-medium px-4 py-2 rounded hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
          >
            {saving ? "Saving…" : !editingType ? "Add pool" : editingMissing ? "Re-create pool" : "Update pool"}
          </button>
          {editingType && (
            <button
              type="button"
              onClick={startNew}
              className="text-sm px-3 py-1.5 rounded border border-border text-text-muted hover:text-text hover:border-text-muted"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
