"use client";

export type LinePoint = { x: string; y: number };

/** A compact, dependency-free SVG line chart for the day-log measures. */
export default function LineChart({ points, unit }: { points: LinePoint[]; unit: string }) {
  const width = 560;
  const height = 170;
  const pad = { left: 34, right: 12, top: 12, bottom: 28 };
  const values = points.map((point) => point.y);
  const low = values.length === 0 ? 0 : Math.min(...values);
  const high = values.length === 0 ? 1 : Math.max(...values);
  const span = high - low || 1;
  const x = (index: number) => points.length < 2
    ? (pad.left + width - pad.right) / 2
    : pad.left + (index / (points.length - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - low) / span) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)} ${y(point.y)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${unit} trend`} className="block h-auto w-full overflow-visible">
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <text x="4" y={pad.top + 8} className="fill-text-faint text-[11px]">{unit}</text>
      <text x={width - pad.right} y={height - 6} textAnchor="end" className="fill-text-faint text-[11px]">week</text>
      {path && <path d={path} fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {points.map((point, index) => <circle key={point.x} cx={x(index)} cy={y(point.y)} r="3" className="fill-accent" />)}
    </svg>
  );
}
