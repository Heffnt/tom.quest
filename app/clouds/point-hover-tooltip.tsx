"use client";

import type { PointHover } from "./cloud-viewer";
import type { ColorMode, Manifest, PaletteEntry, ParsedCloud } from "./lib/types";

type Props = {
  point: PointHover;
  cloud: ParsedCloud;
  manifest: Manifest;
  activeMode: ColorMode;
};

type ClassLookup = {
  entry: PaletteEntry;
  color: string;
};

type NumericChannel = ArrayBufferView & {
  readonly length: number;
  readonly [index: number]: number;
};

const GT_ROWS = [
  { label: "Top", modeId: "gt_top" },
  { label: "Mid", modeId: "gt_mid" },
  { label: "Leaf", modeId: "gt_leaf" },
] as const;

export function PointHoverTooltip({ point, cloud, manifest, activeMode }: Props) {
  const left = clampToViewport(point.clientX + 14, 12, 340, "width");
  const top = clampToViewport(point.clientY + 14, 12, 440, "height");
  const sourceCoordinates: [number, number, number] = [
    point.xyz[0] + manifest.centroid[0],
    point.xyz[1] + manifest.centroid[1],
    point.xyz[2] + manifest.centroid[2],
  ];
  const predictions = manifest.color_modes
    .filter((mode) => mode.id.startsWith("pred_") && mode.channel in cloud.channels)
    .map((mode) => ({
      mode,
      value: lookupClass(cloud, mode, point.index),
    }));

  return (
    <div
      className="pointer-events-none fixed z-50 max-h-[calc(100vh-1.5rem)] w-80 overflow-y-auto rounded-lg border border-border bg-surface/90 p-3 text-xs text-white shadow-xl shadow-black/25 backdrop-blur-md animate-settle"
      style={{ left, top }}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-sm font-semibold">Point sample</div>
          <div className="font-mono text-[11px] text-white">
            {capitalize(point.cloudKey)} #{point.index.toLocaleString()}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-surface-alt px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white">
          hover
        </div>
      </div>

      <div className="mb-3 rounded-md border border-border/70 bg-bg/35 px-2 py-1.5 font-mono text-[11px] text-white">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-white">Coordinates</div>
        <div className="grid grid-cols-3 gap-2 tabular-nums">
          <Coord label="x" value={sourceCoordinates[0]} />
          <Coord label="y" value={sourceCoordinates[1]} />
          <Coord label="z" value={sourceCoordinates[2]} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-white">Ground truth</div>
        {GT_ROWS.map((row) => (
          <ClassRow
            key={row.modeId}
            label={row.label}
            value={lookupClass(cloud, findMode(manifest, row.modeId), point.index)}
          />
        ))}
      </div>

      {predictions.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-white">
            Predictions
          </div>
          <div className="space-y-1">
            {predictions.map(({ mode, value }) => (
              <ClassRow
                key={mode.id}
                label={stripPredictionLabel(mode.label)}
                value={value}
                selected={mode.id === activeMode.id}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClassRow({
  label,
  value,
  selected = false,
}: {
  label: string;
  value: ClassLookup | null;
  selected?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 rounded-md px-1 py-0.5",
        selected ? "border border-accent/30 bg-accent/10" : "",
      ].join(" ")}
    >
      <span className="min-w-14 truncate text-white">{label}</span>
      {value ? (
        <span className="flex min-w-0 shrink-0 items-center gap-2 text-white">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-sm border border-black/30"
            style={{ backgroundColor: value.color }}
          />
          <span className="max-w-24 truncate">{value.entry.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-white">
            {value.entry.id}
          </span>
        </span>
      ) : (
        <span className="text-white">n/a</span>
      )}
    </div>
  );
}

function Coord({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="text-white">{label}</span>{" "}
      <span className="text-white">{formatCoordinate(value)}</span>
    </div>
  );
}

function lookupClass(
  cloud: ParsedCloud,
  mode: ColorMode | null,
  index: number,
): ClassLookup | null {
  if (!mode) return null;
  const paletteIndex = readChannelValue(cloud.channels[mode.channel], index);
  if (paletteIndex === null) return null;
  const entry = mode.palette[paletteIndex];
  if (!entry) return null;
  return {
    entry,
    color: `rgb(${entry.color[0]}, ${entry.color[1]}, ${entry.color[2]})`,
  };
}

function readChannelValue(channel: ArrayBufferView | undefined, index: number): number | null {
  if (!isNumericChannel(channel) || index < 0 || index >= channel.length) return null;
  return channel[index];
}

function findMode(manifest: Manifest, modeId: string): ColorMode | null {
  return manifest.color_modes.find((mode) => mode.id === modeId) ?? null;
}

function isNumericChannel(channel: ArrayBufferView | undefined): channel is NumericChannel {
  return Boolean(channel && !(channel instanceof DataView) && "length" in channel);
}

function clampToViewport(
  value: number,
  padding: number,
  estimatedSize: number,
  axis: "width" | "height",
): number {
  if (typeof window === "undefined") return value;
  const viewportSize = axis === "width" ? window.innerWidth : window.innerHeight;
  return Math.max(padding, Math.min(value, viewportSize - estimatedSize - padding));
}

function stripPredictionLabel(label: string): string {
  return label.replace(/^Predictions?\s+—\s+/, "");
}

function formatCoordinate(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
