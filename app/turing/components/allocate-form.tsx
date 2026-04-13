"use client";

import { useState } from "react";
import { useTuring, useTuringMutation } from "@/app/lib/hooks/use-turing";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { AllocateRequest, AllocateResponse, GPUTypeInfo, gpuTypeLabel } from "../types";

interface AllocateFormProps {
  isTom: boolean;
  onSuccess: () => void;
}

interface Preset {
  name: string;
  commands: string[];
}

interface AllocSettings extends Record<string, unknown> {
  recentDirs: string[];
  commandPresets: Record<string, Preset[]>;
  gpuType: string;
  timeMins: string;
  memoryMb: string;
}

const DEFAULTS: AllocSettings = {
  recentDirs: [],
  commandPresets: {},
  gpuType: "",
  timeMins: "60",
  memoryMb: "16000",
};

export default function AllocateForm({ isTom, onSuccess }: AllocateFormProps) {
  const [settings, update] = usePersistedSettings<AllocSettings>("turing_allocate", DEFAULTS);
  const gpuTypes = useTuring<{ types: GPUTypeInfo[] }>("/gpu-types");
  const allocate = useTuringMutation<AllocateRequest, AllocateResponse>("/allocate");

  const [count, setCount] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [commands, setCommands] = useState<string[]>([""]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");

  if (!isTom) {
    return (
      <section aria-label="Allocate" className="border border-border rounded-lg p-5 bg-surface/40">
        <h2 className="text-lg font-semibold mb-2">Allocate</h2>
        <p className="text-text-muted text-sm">Sign in as Tom to allocate GPUs.</p>
      </section>
    );
  }

  const dirPresets = settings.commandPresets[projectDir] || [];

  const validate = (): string | null => {
    if (!settings.gpuType) return "Select a GPU type.";
    const t = Number(settings.timeMins);
    if (!Number.isInteger(t) || t <= 0) return "Time must be a positive integer.";
    const m = Number(settings.memoryMb);
    if (!Number.isInteger(m) || m <= 0) return "Memory must be a positive integer.";
    if (count) {
      const c = Number(count);
      if (!Number.isInteger(c) || c < 1 || c > 12) return "Count must be between 1 and 12.";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSuccessMsg(null);
    const err = validate();
    if (err) { setValidationError(err); return; }
    const res = await allocate.trigger({
      gpu_type: settings.gpuType,
      time_mins: Number(settings.timeMins),
      memory_mb: Number(settings.memoryMb),
      count: count ? Number(count) : 0,
      commands: commands.filter(c => c.trim()),
      project_dir: projectDir,
    });
    if (res?.success) {
      setSuccessMsg(`Allocated job(s): ${res.job_ids.join(", ")}`);
      if (projectDir) {
        const next = [projectDir, ...settings.recentDirs.filter(d => d !== projectDir)].slice(0, 10);
        update({ recentDirs: next });
      }
      onSuccess();
    }
  };

  const savePreset = () => {
    if (!presetName.trim() || !projectDir) return;
    const existing = dirPresets.filter(p => p.name !== presetName.trim());
    const nextPresets = {
      ...settings.commandPresets,
      [projectDir]: [...existing, { name: presetName.trim(), commands: commands.filter(c => c.trim()) }],
    };
    update({ commandPresets: nextPresets });
    setPresetName("");
  };

  const loadPreset = () => {
    const p = dirPresets.find(p => p.name === selectedPreset);
    if (p) setCommands(p.commands.length ? p.commands : [""]);
  };

  const deletePreset = () => {
    if (!projectDir || !selectedPreset) return;
    const nextPresets = {
      ...settings.commandPresets,
      [projectDir]: dirPresets.filter(p => p.name !== selectedPreset),
    };
    update({ commandPresets: nextPresets });
    setSelectedPreset("");
  };

  return (
    <section aria-label="Allocate" className="border border-border rounded-lg p-5 bg-surface/40">
      <h2 className="text-lg font-semibold mb-4">Allocate</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted mb-1">GPU Type</span>
            <select
              value={settings.gpuType}
              onChange={e => update({ gpuType: e.target.value })}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none"
            >
              <option value="">—</option>
              {gpuTypes.data?.types.map(t => (
                <option key={t.type} value={t.type}>
                  {gpuTypeLabel(t.type)} ({t.count} free)
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Count</span>
            <input
              type="number" min={1} max={12}
              value={count}
              onChange={e => setCount(e.target.value)}
              placeholder="all"
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Time (mins)</span>
            <input
              type="number" min={1}
              value={settings.timeMins}
              onChange={e => update({ timeMins: e.target.value })}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Memory (MB)</span>
            <input
              type="number" min={1}
              value={settings.memoryMb}
              onChange={e => update({ memoryMb: e.target.value })}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <div>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Project Directory</span>
            <input
              type="text"
              value={projectDir}
              onChange={e => setProjectDir(e.target.value)}
              placeholder="/home/..."
              className="w-full bg-bg border border-border rounded px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
            />
          </label>
          {settings.recentDirs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {settings.recentDirs.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setProjectDir(d)}
                  className="text-xs px-2 py-0.5 rounded border border-border text-text-muted font-mono hover:text-text hover:border-text-muted transition-colors duration-150"
                >
                  {d}
                </button>
              ))}
            </div>
          )}
        </div>

        {projectDir && (
          <div className="border-l-2 border-border pl-3 space-y-2">
            <p className="text-xs text-text-faint uppercase tracking-wide">Command presets</p>
            {dirPresets.length > 0 && (
              <div className="flex gap-2 items-center">
                <select
                  value={selectedPreset}
                  onChange={e => setSelectedPreset(e.target.value)}
                  className="bg-bg border border-border rounded px-2 py-1 text-sm"
                >
                  <option value="">Select preset…</option>
                  {dirPresets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <button type="button" onClick={loadPreset} disabled={!selectedPreset}
                  className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text disabled:opacity-40">Load</button>
                <button type="button" onClick={deletePreset} disabled={!selectedPreset}
                  className="text-xs px-2 py-1 rounded border border-border text-error hover:bg-error/10 disabled:opacity-40">Delete</button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                placeholder="Save current as…"
                className="flex-1 bg-bg border border-border rounded px-2 py-1 text-sm"
              />
              <button type="button" onClick={savePreset} disabled={!presetName.trim()}
                className="text-xs px-3 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40">Save</button>
            </div>
          </div>
        )}

        <div>
          <p className="text-text-muted text-sm mb-1">Commands</p>
          <div className="space-y-1.5">
            {commands.map((cmd, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={cmd}
                  onChange={e => setCommands(commands.map((c, j) => j === i ? e.target.value : c))}
                  className="flex-1 bg-bg border border-border rounded px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
                  placeholder="echo hello"
                />
                {commands.length > 1 && (
                  <button type="button" onClick={() => setCommands(commands.filter((_, j) => j !== i))}
                    className="px-2 text-text-faint hover:text-error">×</button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setCommands([...commands, ""])}
            className="mt-1.5 text-xs text-text-muted hover:text-accent">+ Add command</button>
        </div>

        {validationError && <p className="text-error text-sm">{validationError}</p>}
        {allocate.error && <p className="text-error text-sm">{allocate.error}</p>}
        {successMsg && <p className="text-accent text-sm">{successMsg}</p>}

        <button
          type="submit"
          disabled={allocate.loading}
          className="bg-accent text-bg font-medium px-4 py-2 rounded hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
        >
          {allocate.loading ? "Allocating…" : "Allocate"}
        </button>
      </form>
    </section>
  );
}
