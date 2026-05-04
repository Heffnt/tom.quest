"use client";

import type { ColorMode, CloudKey, CloudMetaEntry } from "./lib/types";

type Props = {
  cloudVisibility: Record<CloudKey, boolean>;
  setCloudVisibility: (next: Record<CloudKey, boolean>) => void;
  cloudMeta: Record<string, CloudMetaEntry>;

  colorModes: ColorMode[];
  activeMode: string;
  setActiveMode: (id: string) => void;

  pointCount: number;
  setPointCount: (n: number) => void;
  pointCountMax: number;

  pointSize: number;
  setPointSize: (n: number) => void;

  moveSpeed: number;
  setMoveSpeed: (n: number) => void;

  lookSpeed: number;
  setLookSpeed: (n: number) => void;

  showSplitPlane: boolean;
  setShowSplitPlane: (b: boolean) => void;

  onResetCamera: () => void;
};

const SPLIT_GROUPS: { id: string; label: string; prefix: string }[] = [
  { id: "gt", label: "Ground truth", prefix: "gt_" },
  { id: "pred", label: "Predictions", prefix: "pred_" },
];

export function ControlPanel(props: Props) {
  const {
    cloudVisibility,
    setCloudVisibility,
    cloudMeta,
    colorModes,
    activeMode,
    setActiveMode,
    pointCount,
    setPointCount,
    pointCountMax,
    pointSize,
    setPointSize,
    moveSpeed,
    setMoveSpeed,
    lookSpeed,
    setLookSpeed,
    showSplitPlane,
    setShowSplitPlane,
    onResetCamera,
  } = props;

  const grouped = SPLIT_GROUPS.map((g) => ({
    ...g,
    modes: colorModes.filter((m) => m.id.startsWith(g.prefix)),
  }));

  return (
    <div className="absolute top-4 left-4 z-10 w-72 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-border bg-surface/85 backdrop-blur-md p-4 text-sm animate-settle">
      <div className="font-display text-base font-semibold mb-3">Clouds</div>

      <Section title="Show">
        {(["train", "test"] as const).map((key) => {
          const meta = cloudMeta[key];
          const labelText = meta
            ? `${capitalize(key)} (${formatCount(meta.n_full)} pts)`
            : capitalize(key);
          return (
            <CheckboxRow
              key={key}
              checked={cloudVisibility[key]}
              onChange={(v) => setCloudVisibility({ ...cloudVisibility, [key]: v })}
              label={labelText}
            />
          );
        })}
      </Section>

      <Section title="Color by">
        {grouped.map((group) => (
          <div key={group.id} className="mt-2">
            <div className="text-text-muted text-xs uppercase tracking-wide mb-1">
              {group.label}
            </div>
            {group.modes.map((m) => (
              <RadioRow
                key={m.id}
                checked={activeMode === m.id}
                onChange={() => setActiveMode(m.id)}
                label={m.label.replace(/^(Ground truth|Predictions?) — /, "")}
              />
            ))}
          </div>
        ))}
      </Section>

      <Section title={`Points per cloud (${formatCount(pointCount)})`}>
        <input
          type="range"
          min={1000}
          max={pointCountMax}
          step={1000}
          value={Math.min(pointCount, pointCountMax)}
          onChange={(e) => setPointCount(Number(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="text-text-faint text-xs mt-1">
          1k — {formatCount(pointCountMax)}
        </div>
      </Section>

      <Section title={`Point size (${pointSize.toFixed(2)})`}>
        <input
          type="range"
          min={0.01}
          max={0.3}
          step={0.005}
          value={pointSize}
          onChange={(e) => setPointSize(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </Section>

      <Section title={`Fly speed (${Math.round(moveSpeed)})`}>
        <input
          type="range"
          min={5}
          max={150}
          step={5}
          value={moveSpeed}
          onChange={(e) => setMoveSpeed(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </Section>

      <Section title={`Look speed (${(lookSpeed * 1000).toFixed(1)})`}>
        <input
          type="range"
          min={0.0005}
          max={0.008}
          step={0.0005}
          value={lookSpeed}
          onChange={(e) => setLookSpeed(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </Section>

      <Section title="Overlays">
        <CheckboxRow
          checked={showSplitPlane}
          onChange={setShowSplitPlane}
          label="Show train/test split plane"
        />
      </Section>

      <button
        onClick={onResetCamera}
        className="mt-2 w-full rounded-md border border-border bg-surface-alt px-3 py-1.5 text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
      >
        Reset camera
      </button>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-faint font-mono leading-relaxed">
        <div><span className="text-text-muted">drag</span> to look around</div>
        <div><span className="text-text-muted">WASD</span> move · <span className="text-text-muted">space/shift</span> up/down</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-border pt-3 first:border-t-0 first:pt-0 first:mt-0">
      <div className="text-text font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

function CheckboxRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function RadioRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
