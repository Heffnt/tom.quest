"use client";

type LinePoint = { x: string; y: number; label?: string };

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (match === null) return value;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? "1")));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(at);
}

/** A compact, dependency-free SVG line chart for the day-log measures. */
export default function LineChart({
  points,
  unit,
  variant = "line",
  formatValue = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1),
}: {
  points: LinePoint[];
  unit: string;
  variant?: "line" | "bar";
  formatValue?: (value: number) => string;
}) {
  const width = 375;
  const height = 180;
  const pad = { left: 65, right: 64, top: 20, bottom: 32 };
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
  const tick = (value: number) => `${formatValue(value)} ${unit === "runs" && value === 1 ? "run" : unit}`;
  const latest = points.at(-1);
  const latestIndex = points.length - 1;
  const latestX = latest === undefined ? 0 : x(latestIndex);
  const latestY = latest === undefined ? 0 : y(latest.y);
  const latestAnchor = latestIndex === 0 ? "start" : "end";
  const latestLabelX = latestIndex === 0 ? latestX + 6 : latestX - 6;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${unit} trend`} className="block h-auto w-full overflow-visible">
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} className="stroke-border" strokeWidth="1" />
      <text x={pad.left - 6} y={pad.top + 5} textAnchor="end" className="fill-text-faint" fontSize="12">{tick(high)}</text>
      {high !== low && <text x={pad.left - 6} y={baseline} textAnchor="end" className="fill-text-faint" fontSize="12">{tick(low)}</text>}
      {points.length > 0 && <text x={pad.left} y={height - 9} textAnchor="start" className="fill-text-faint" fontSize="12">{dateLabel(points[0]!.x)}</text>}
      {points.length > 1 && <text x={width - pad.right} y={height - 9} textAnchor="end" className="fill-text-faint" fontSize="12">{dateLabel(points.at(-1)!.x)}</text>}
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
      {latest !== undefined && (
        <text
          x={latestLabelX}
          y={Math.max(pad.top + 12, latestY - 7)}
          textAnchor={latestAnchor}
          className="fill-text"
          fontSize="12"
          aria-label={`Latest value: ${tick(latest.y)}`}
        >
          {tick(latest.y)}
        </text>
      )}
    </svg>
  );
}
