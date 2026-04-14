"use client";

import { useEffect, useRef, useState } from "react";
import { useTuring, useTuringMutation } from "@/app/lib/hooks/use-turing";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { AllocateRequest, AllocateResponse, GPUTypeInfo, gpuTypeLabel } from "../types";

interface AllocateFormProps {
  isTom: boolean;
  onSuccess: () => void;
}

interface ProjectProfile {
  dir: string;
  label: string;
  configs: { name: string; commands: string[] }[];
}

interface AllocSettings extends Record<string, unknown> {
  profiles: ProjectProfile[];
  activeProfileIndex: number;
  activeConfigIndex: number;
  gpuType: string;
  timeMins: string;
  memoryMb: string;
  jobName: string;
  recentDirs: string[];
  commandPresets: Record<string, { name: string; commands: string[] }[]>;
}

const DEFAULT_TIME_MINS = "1440";
const DEFAULT_MEMORY_MB = "64000";
const DEFAULT_COUNT = "1";
const LEGACY_TIME_MINS = "60";
const LEGACY_MEMORY_MB = "16000";

const SEED_PROFILES: ProjectProfile[] = [
  {
    dir: "/home/ntheffernan/booleanbackdoors/ComplexMultiTrigger",
    label: "BoolBack",
    configs: [
      { name: "batch", commands: ["source activate.sh", "python batch.py"] },
      { name: "debug", commands: ["source activate.sh"] },
    ],
  },
  {
    dir: "/home/ntheffernan/tom.quest/tom-quest-api",
    label: "tom.Quest API",
    configs: [
      { name: "api", commands: ["python main.py"] },
    ],
  },
];

const DEFAULTS: AllocSettings = {
  profiles: SEED_PROFILES,
  activeProfileIndex: 0,
  activeConfigIndex: 0,
  gpuType: "",
  timeMins: DEFAULT_TIME_MINS,
  memoryMb: DEFAULT_MEMORY_MB,
  jobName: "allocation",
  recentDirs: [],
  commandPresets: {},
};

export default function AllocateForm({ isTom, onSuccess }: AllocateFormProps) {
  const [settings, update, settingsHydrated] = usePersistedSettings<AllocSettings>("turing_allocate", DEFAULTS);
  const gpuTypes = useTuring<{ types: GPUTypeInfo[] }>("/gpu-types");
  const allocate = useTuringMutation<AllocateRequest, AllocateResponse>("/allocate");
  const migratedRef = useRef(false);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editDir, setEditDir] = useState("");
  const [editConfigs, setEditConfigs] = useState<{ name: string; commands: string[] }[]>([]);
  const [editingProfileIndex, setEditingProfileIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!settingsHydrated || migratedRef.current) return;
    migratedRef.current = true;
    const patch: Partial<AllocSettings> = {};
    if (settings.timeMins === LEGACY_TIME_MINS) patch.timeMins = DEFAULT_TIME_MINS;
    if (settings.memoryMb === LEGACY_MEMORY_MB) patch.memoryMb = DEFAULT_MEMORY_MB;
    if (!settings.profiles || settings.profiles.length === 0) {
      const migrated: ProjectProfile[] = [];
      const oldPresets = settings.commandPresets ?? {};
      const oldRecent = settings.recentDirs ?? [];
      const seenDirs = new Set<string>();
      for (const profile of SEED_PROFILES) {
        const configs = oldPresets[profile.dir] ?? profile.configs;
        migrated.push({ ...profile, configs: configs.length > 0 ? configs : profile.configs });
        seenDirs.add(profile.dir);
      }
      for (const dir of oldRecent) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const configs = oldPresets[dir] ?? [];
        const label = dir.split("/").filter(Boolean).pop() ?? dir;
        migrated.push({ dir, label, configs: configs.length > 0 ? configs : [{ name: "default", commands: [] }] });
      }
      patch.profiles = migrated;
      patch.activeProfileIndex = 0;
      patch.activeConfigIndex = 0;
    }
    if (Object.keys(patch).length > 0) update(patch);
  }, [settings.memoryMb, settings.timeMins, settings.profiles, settings.commandPresets, settings.recentDirs, settingsHydrated, update]);

  if (!isTom) {
    return (
      <section aria-label="Allocate" className="border border-border rounded-lg p-5 bg-surface/40">
        <h2 className="text-lg font-semibold mb-2">Allocate</h2>
        <p className="text-text-muted text-sm">Sign in as Tom to allocate GPUs.</p>
      </section>
    );
  }

  const profiles = settings.profiles ?? SEED_PROFILES;
  const profileIdx = Math.min(settings.activeProfileIndex ?? 0, profiles.length - 1);
  const profile = profiles[profileIdx];
  const configIdx = Math.min(settings.activeConfigIndex ?? 0, (profile?.configs.length ?? 1) - 1);
  const config = profile?.configs[configIdx];

  const validate = (): string | null => {
    if (!settings.gpuType) return "Select a GPU type.";
    const t = Number(settings.timeMins);
    if (!Number.isInteger(t) || t <= 0) return "Time must be a positive integer.";
    const m = Number(settings.memoryMb);
    if (!Number.isInteger(m) || m <= 0) return "Memory must be a positive integer.";
    if (count) {
      const c = Number(count);
      if (!Number.isInteger(c) || c < 1) return "Count must be a positive integer.";
    }
    if (!profile) return "Select a project.";
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
      commands: config?.commands.filter(c => c.trim()) ?? [],
      project_dir: profile?.dir ?? "",
      job_name: settings.jobName,
    });
    if (res?.success) {
      const partialFailure = res.errors.length > 0;
      setSuccessMsg(`Allocated job(s): ${res.job_ids.join(", ")}`);
      setValidationError(partialFailure ? `Some allocations failed: ${res.errors.join(" | ")}` : null);
      onSuccess();
      return;
    }
    if (res?.errors.length) setValidationError(res.errors.join(" | "));
  };

  const openEditor = (idx: number | null) => {
    if (idx !== null && profiles[idx]) {
      const p = profiles[idx];
      setEditLabel(p.label);
      setEditDir(p.dir);
      setEditConfigs(p.configs.map(c => ({ ...c, commands: [...c.commands] })));
    } else {
      setEditLabel("");
      setEditDir("");
      setEditConfigs([{ name: "default", commands: [""] }]);
    }
    setEditingProfileIndex(idx);
    setEditing(true);
  };

  const saveEditor = () => {
    if (!editLabel.trim() || !editDir.trim()) return;
    const cleaned: ProjectProfile = {
      label: editLabel.trim(),
      dir: editDir.trim(),
      configs: editConfigs.filter(c => c.name.trim()).map(c => ({
        name: c.name.trim(),
        commands: c.commands.filter(cmd => cmd.trim()),
      })),
    };
    if (cleaned.configs.length === 0) cleaned.configs = [{ name: "default", commands: [] }];
    const next = [...profiles];
    if (editingProfileIndex !== null) {
      next[editingProfileIndex] = cleaned;
    } else {
      next.push(cleaned);
    }
    update({ profiles: next, activeProfileIndex: editingProfileIndex ?? next.length - 1, activeConfigIndex: 0 });
    setEditing(false);
  };

  const deleteProfile = (idx: number) => {
    const next = profiles.filter((_, i) => i !== idx);
    const newActive = Math.min(profileIdx, Math.max(next.length - 1, 0));
    update({ profiles: next, activeProfileIndex: newActive, activeConfigIndex: 0 });
    setEditing(false);
  };

  return (
    <section aria-label="Allocate" className="border border-border rounded-lg p-5 bg-surface/40">
      <h2 className="text-lg font-semibold mb-4">Allocate</h2>

      {editing ? (
        <div className="space-y-3 border border-border/60 rounded-lg p-4 bg-bg/40">
          <div className="flex gap-3">
            <label className="text-sm flex-1">
              <span className="block text-text-muted mb-1">Label</span>
              <input type="text" value={editLabel} onChange={e => setEditLabel(e.target.value)}
                placeholder="My Project" className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
            </label>
            <label className="text-sm flex-[2]">
              <span className="block text-text-muted mb-1">Directory</span>
              <input type="text" value={editDir} onChange={e => setEditDir(e.target.value)}
                placeholder="/home/..." className="w-full bg-bg border border-border rounded px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none" />
            </label>
          </div>
          <div className="space-y-3">
            <span className="text-xs text-text-faint uppercase tracking-wide">Configs</span>
            {editConfigs.map((cfg, ci) => (
              <div key={ci} className="border border-border/40 rounded p-3 space-y-2 bg-surface/30">
                <div className="flex items-center gap-2">
                  <input type="text" value={cfg.name} onChange={e => {
                    const next = [...editConfigs];
                    next[ci] = { ...cfg, name: e.target.value };
                    setEditConfigs(next);
                  }} placeholder="config name" className="bg-bg border border-border rounded px-2 py-1 text-sm flex-1 focus:border-accent focus:outline-none" />
                  {editConfigs.length > 1 && (
                    <button type="button" onClick={() => setEditConfigs(editConfigs.filter((_, i) => i !== ci))}
                      className="text-text-faint hover:text-error text-xs px-1">✕</button>
                  )}
                </div>
                <div className="space-y-1">
                  {cfg.commands.map((cmd, cmdI) => (
                    <div key={cmdI} className="flex gap-1.5">
                      <input type="text" value={cmd} onChange={e => {
                        const nextCfg = [...editConfigs];
                        const cmds = [...cfg.commands];
                        cmds[cmdI] = e.target.value;
                        nextCfg[ci] = { ...cfg, commands: cmds };
                        setEditConfigs(nextCfg);
                      }} className="flex-1 bg-bg border border-border rounded px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none" placeholder="command" />
                      {cfg.commands.length > 1 && (
                        <button type="button" onClick={() => {
                          const nextCfg = [...editConfigs];
                          nextCfg[ci] = { ...cfg, commands: cfg.commands.filter((_, j) => j !== cmdI) };
                          setEditConfigs(nextCfg);
                        }} className="text-text-faint hover:text-error text-xs px-1">✕</button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => {
                    const nextCfg = [...editConfigs];
                    nextCfg[ci] = { ...cfg, commands: [...cfg.commands, ""] };
                    setEditConfigs(nextCfg);
                  }} className="text-[10px] text-text-faint hover:text-accent">+ command</button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setEditConfigs([...editConfigs, { name: "", commands: [""] }])}
              className="text-xs text-text-muted hover:text-accent">+ Add config</button>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={saveEditor} disabled={!editLabel.trim() || !editDir.trim()}
              className="text-xs px-3 py-1.5 rounded bg-accent text-bg font-medium hover:opacity-90 disabled:opacity-40">Save</button>
            <button type="button" onClick={() => setEditing(false)}
              className="text-xs px-3 py-1.5 rounded border border-border text-text-muted hover:text-text">Cancel</button>
            {editingProfileIndex !== null && (
              <button type="button" onClick={() => deleteProfile(editingProfileIndex)}
                className="text-xs px-3 py-1.5 rounded border border-error/40 text-error hover:bg-error/10 ml-auto">Delete</button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            {profiles.map((p, i) => (
              <button key={i} type="button"
                onClick={() => update({ activeProfileIndex: i, activeConfigIndex: 0 })}
                onDoubleClick={() => openEditor(i)}
                className={`text-sm px-3 py-1.5 rounded-md border transition-all duration-150 font-medium ${
                  i === profileIdx
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border text-text-muted hover:text-text hover:border-text-muted"
                }`}
                title={p.dir}
              >
                {p.label}
              </button>
            ))}
            <button type="button" onClick={() => openEditor(null)}
              className="text-sm px-2.5 py-1.5 rounded-md border border-dashed border-border text-text-faint hover:text-text-muted hover:border-text-muted transition-colors">
              +
            </button>
            {profile && (
              <button type="button" onClick={() => openEditor(profileIdx)}
                className="text-[10px] px-2 py-1 text-text-faint hover:text-text-muted ml-auto" title="Edit project">
                edit
              </button>
            )}
          </div>

          {profile && profile.configs.length > 1 && (
            <div className="flex gap-1.5">
              {profile.configs.map((c, i) => (
                <button key={i} type="button"
                  onClick={() => update({ activeConfigIndex: i })}
                  className={`text-xs px-2.5 py-1 rounded border font-mono transition-all duration-150 ${
                    i === configIdx
                      ? "border-accent/40 text-accent bg-accent/5"
                      : "border-border/40 text-text-faint hover:text-text-muted"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {profile && config && config.commands.length > 0 && (
            <div className="text-xs font-mono text-text-faint bg-black/30 rounded px-3 py-2 space-y-0.5">
              <span className="text-text-muted text-[10px] uppercase tracking-wide block mb-1">
                {profile.dir}
              </span>
              {config.commands.map((cmd, i) => (
                <div key={i} className="text-text-muted">
                  <span className="text-text-faint select-none mr-1.5">$</span>{cmd}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <label className="text-sm">
              <span className="block text-text-muted mb-1">GPU</span>
              <select value={settings.gpuType} onChange={e => update({ gpuType: e.target.value })}
                className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none">
                <option value="">—</option>
                {gpuTypes.data?.types.map(t => (
                  <option key={t.type} value={t.type}>{gpuTypeLabel(t.type)} ({t.count} free)</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-text-muted mb-1">Count</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*" value={count}
                onChange={e => setCount(e.target.value)} placeholder="all"
                className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
            </label>
            <label className="text-sm">
              <span className="block text-text-muted mb-1">Time</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*" value={settings.timeMins}
                onChange={e => update({ timeMins: e.target.value })}
                className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
            </label>
            <label className="text-sm">
              <span className="block text-text-muted mb-1">Memory</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*" value={settings.memoryMb}
                onChange={e => update({ memoryMb: e.target.value })}
                className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
            </label>
            <label className="text-sm">
              <span className="block text-text-muted mb-1">Job Name</span>
              <input type="text" value={settings.jobName} onChange={e => update({ jobName: e.target.value })}
                className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
            </label>
          </div>

          {validationError && <p className="text-error text-sm">{validationError}</p>}
          {allocate.error && <p className="text-error text-sm">{allocate.error}</p>}
          {successMsg && <p className="text-accent text-sm">{successMsg}</p>}

          <button type="submit" disabled={allocate.loading}
            className="bg-accent text-bg font-medium px-4 py-2 rounded hover:opacity-90 transition-opacity duration-150 disabled:opacity-50">
            {allocate.loading ? "Allocating…" : "Allocate"}
          </button>
        </form>
      )}
    </section>
  );
}
