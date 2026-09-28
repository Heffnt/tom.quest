"use client";

export type LinePoint = { x: string; y: number; label?: string };

/** A compact, dependency-free SVG line chart for the day-log measures. */
export default function LineChart({
  points,
  unit,
  xLabel = "week",
  variant = "line",
  formatValue = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1),
}: {
  points: LinePoint[];
  unit: string;
  xLabel?: string;
  variant?: "line" | "bar";
  formatValue?: (value: number) => string;
}) {
  const width = 560;
  const height = 170;
  const pad = { left: 46, right: 12, top: 16, bottom: 28 };
  const values = points.map((point) => point.y);
  const low = variant === "bar" ? 0 : values.length === 0 ? 0 : Math.min(...values);
  const high = values.length === 0 ? 1 : Math.max(...values);
  const span = high - low || 1;
  const x = (index: number) => points.length < 2
    ? (pad.left + width - pad.right) / 2
    : pad.left + (index / (points.length - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - low) / span) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)} ${y(point.y)}`).join(" ");
  const barWidth = Math.max(4, Math.min(28, (width - pad.left - pad.right) / Math.max(points.length, 1) * 0.7));
  const baseline = height - pad.bottom;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${unit} trend`} className="block h-auto w-full overflow-visible">
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <text x={pad.left - 4} y={pad.top + 4} textAnchor="end" className="fill-text-faint text-[11px]">{formatValue(high)}</text>
      {high !== low && <text x={pad.left - 4} y={baseline} textAnchor="end" className="fill-text-faint text-[11px]">{formatValue(low)}</text>}
      <text x="4" y={pad.top - 4} className="fill-text-faint text-[11px]">{unit}</text>
      <text x={width - pad.right} y={height - 6} textAnchor="end" className="fill-text-faint text-[11px]">{xLabel}</text>
      {variant === "line" && path && <path d={path} fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {variant === "line" && points.map((point, index) => <circle key={point.x} cx={x(index)} cy={y(point.y)} r="3" className="fill-accent" />)}
      {variant === "bar" && points.map((point, index) => (
        <rect
          key={point.x}
          x={x(index) - barWidth / 2}
          y={y(point.y)}
          width={barWidth}
          height={baseline - y(point.y)}
          rx="2"
          className="fill-accent"
          aria-label={point.label}
        >
          {point.label && <title>{point.label}</title>}
        </rect>
      ))}
    </svg>
  );
}
