"use client";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────────
   Tom-symbol designer — parametric, no-handle edition.

   6 numeric params + 2 style options. Every slider has its own
   user-editable min/max so you can zoom into any range. None of
   the numeric inputs clamp — negative / out-of-range values are
   accepted and just render what they mean geometrically.
   ───────────────────────────────────────────────────────────── */

const CX   = 320;
const CY   = 270;
const R    = 170;
const VB_W = 640;
const VB_H = 540;

type Params = {
  tHeight: number;
  mAngle:  number;
  stroke:  number;
  dotSize: number;
};

type Options = {
  dotShape:     "square" | "circle";
  tailCut:      "perpendicular" | "horizontal";
  showBaseline: "on" | "off";
};

const DEFAULT_PARAMS: Params = {
  tHeight: -78,
  mAngle:  38,
  stroke:  35,
  dotSize: 60,
};

const DEFAULT_OPTIONS: Options = {
  dotShape:     "circle",
  tailCut:      "horizontal",
  showBaseline: "off",
};

type Range = { min: number; max: number; step: number };

const DEFAULT_RANGES: Record<keyof Params, Range> = {
  tHeight: { min: -200, max: 200, step: 1   },
  mAngle:  { min:  -90, max:  90, step: 0.5 },
  stroke:  { min:    0, max:  80, step: 1   },
  dotSize: { min:    0, max: 120, step: 1   },
};

const PARAM_HINTS: Record<keyof Params, string> = {
  tHeight: "bar y-offset from circle centre (negative = above)",
  mAngle:  "diagonals' angle from vertical (°)",
  stroke:  "uniform line width",
  dotSize: "dot side length (square) / diameter (circle)",
};

const PARAM_KEYS: (keyof Params)[] = ["tHeight", "mAngle", "stroke", "dotSize"];

/* ─────────────────────────────────────────────────────────────
   Geometry
   ───────────────────────────────────────────────────────────── */

type Derived = {
  barY: number;
  barLeftX: number;
  barRightX: number;
  baseY: number;
  tCircle: number;
  leftEnd:   { x: number; y: number };
  rightEnd:  { x: number; y: number };
  dotCentre: { x: number; y: number };
  /* Horizontal-cut polygon corners (right diagonal). Valid when cosθ > 0. */
  tailPoly: { x: number; y: number }[];
};

/* Baseline = outer bottom edge of the Q circle (includes stroke).
   All tail/dot bottoms must land on this line, so we solve
   ray distance t given the desired terminal y.               */
function derive(p: Params, opt: Options): Derived {
  const barY    = CY + p.tHeight;
  const chordSq = R * R - p.tHeight * p.tHeight;
  const barHalf = chordSq > 0 ? Math.sqrt(chordSq) : 0;

  const aR   = (p.mAngle * Math.PI) / 180;
  const sinA = Math.sin(aR);
  const cosA = Math.cos(aR);
  const w    = p.stroke;

  const baseY = CY + R + w / 2;

  // Where either diagonal ray meets the Q circle.
  const disc    = Math.max(0, R * R - p.tHeight * p.tHeight * sinA * sinA);
  const tCircle = -p.tHeight * cosA + Math.sqrt(disc);

  // Tail distance along right ray so its bottom lands on baseY.
  //   perpendicular cut: bottom corner = center + (−cosθ, +sinθ)·w/2
  //       → barY + t·cosθ + sinθ·w/2 = baseY
  //   horizontal  cut: lower tip at tipY = barY + L·cosθ = baseY
  const tTailPerp  = cosA !== 0 ? (baseY - barY - sinA * w / 2) / cosA : 0;
  const tTailHoriz = cosA !== 0 ? (baseY - barY)                  / cosA : 0;
  const L = opt.tailCut === "horizontal" ? tTailHoriz : tTailPerp;

  // Dot distance along left ray so its bottom lands on baseY.
  const tDot = cosA !== 0 ? (baseY - barY - p.dotSize / 2) / cosA : 0;

  const leftEnd  = { x: CX - tCircle * sinA, y: barY + tCircle * cosA };
  const rightEnd = { x: CX + L * sinA,       y: barY + L * cosA       };
  const dotCentre = {
    x: CX - tDot * sinA,
    y: barY + tDot * cosA,
  };

  /* Horizontal-cut tail polygon. tipY = baseY when tailCut === "horizontal".
     Upper edge reaches tipY at t_u = L + tanθ·w/2
     Lower edge reaches tipY at t_l = L − tanθ·w/2                   */
  const tanA = cosA !== 0 ? sinA / cosA : 0;
  const tU = L + tanA * w / 2;
  const tL = L - tanA * w / 2;
  const tipY = barY + L * cosA;
  const upperStart = { x: CX + cosA * w / 2, y: barY - sinA * w / 2 };
  const lowerStart = { x: CX - cosA * w / 2, y: barY + sinA * w / 2 };
  const upperTip   = { x: CX + tU * sinA + cosA * w / 2, y: tipY };
  const lowerTip   = { x: CX + tL * sinA - cosA * w / 2, y: tipY };

  return {
    barY,
    barLeftX:  CX - barHalf,
    barRightX: CX + barHalf,
    baseY,
    tCircle,
    leftEnd,
    rightEnd,
    dotCentre,
    tailPoly: [upperStart, upperTip, lowerTip, lowerStart],
  };
}

/* ─────────────────────────────────────────────────────────────
   Symbol renderer
   ───────────────────────────────────────────────────────────── */

function TomSymbol({ p, opt }: { p: Params; opt: Options }) {
  const d = derive(p, opt);

  return (
    <>
      {/* Q circle */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke="currentColor"
        strokeWidth={p.stroke}
      />

      {/* Horizontal bar — chord at barY */}
      <line
        x1={d.barLeftX} y1={d.barY}
        x2={d.barRightX} y2={d.barY}
        stroke="currentColor"
        strokeWidth={p.stroke}
      />

      {/* Vertical stem of the T / middle of the M */}
      <line
        x1={CX} y1={d.barY}
        x2={CX} y2={CY + R}
        stroke="currentColor"
        strokeWidth={p.stroke}
      />

      {/* Left M-diagonal */}
      <line
        x1={CX} y1={d.barY}
        x2={d.leftEnd.x} y2={d.leftEnd.y}
        stroke="currentColor"
        strokeWidth={p.stroke}
      />

      {/* Right M-diagonal / Q tail */}
      {opt.tailCut === "horizontal" ? (
        <polygon
          points={d.tailPoly.map((pt) => `${pt.x},${pt.y}`).join(" ")}
          fill="currentColor"
        />
      ) : (
        <line
          x1={CX} y1={d.barY}
          x2={d.rightEnd.x} y2={d.rightEnd.y}
          stroke="currentColor"
          strokeWidth={p.stroke}
        />
      )}

      {/* Baseline guide (dashed) */}
      {opt.showBaseline === "on" && (
        <line
          x1={40} y1={d.baseY}
          x2={VB_W - 40} y2={d.baseY}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="6 6"
          opacity={0.4}
        />
      )}

      {/* Dot terminus */}
      {opt.dotShape === "circle" ? (
        <circle
          cx={d.dotCentre.x}
          cy={d.dotCentre.y}
          r={p.dotSize / 2}
          fill="currentColor"
        />
      ) : (
        <rect
          x={d.dotCentre.x - p.dotSize / 2}
          y={d.dotCentre.y - p.dotSize / 2}
          width={p.dotSize}
          height={p.dotSize}
          fill="currentColor"
        />
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────────────────
   Page
   ───────────────────────────────────────────────────────────── */

export default function LogoLab() {
  const [p, setP]       = useState<Params>(DEFAULT_PARAMS);
  const [opt, setOpt]   = useState<Options>(DEFAULT_OPTIONS);
  const [ranges, setRanges] = useState<Record<keyof Params, Range>>(DEFAULT_RANGES);
  const [copied, setCopied] = useState(false);

  const valuesText =
    `// tom-symbol params\n` +
    `tHeight:  ${p.tHeight}\n` +
    `mAngle:   ${p.mAngle}\n` +
    `stroke:   ${p.stroke}\n` +
    `dotSize:  ${p.dotSize}\n` +
    `dotShape: ${opt.dotShape}\n` +
    `tailCut:  ${opt.tailCut}\n` +
    `// reference: R=${R} (dot+tail auto-land on baseline)`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(valuesText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  const reset = () => {
    setP(DEFAULT_PARAMS);
    setOpt(DEFAULT_OPTIONS);
    setRanges(DEFAULT_RANGES);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <header className="animate-settle">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-accent">
          Logo Lab · tom-symbol designer
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">
          Dial in the geometry
        </h1>
        <p className="mt-4 text-text-muted max-w-3xl leading-relaxed">
          Every slider&apos;s min/max is editable. Nothing is clamped, so you
          can push values negative / past-the-edge and watch what happens.
        </p>
      </header>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        {/* Canvas */}
        <div className="rounded-md border border-border bg-surface p-4">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full h-auto"
            style={{ color: "var(--color-text)" }}
          >
            <TomSymbol p={p} opt={opt} />
          </svg>
        </div>

        {/* Sidebar */}
        <aside className="flex flex-col gap-5">
          {/* Values output */}
          <div className="rounded-md border border-border bg-surface">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <span className="text-xs font-mono uppercase tracking-wider text-text-muted">
                values
              </span>
              <button
                type="button"
                onClick={copy}
                className="text-xs font-mono text-accent hover:text-text transition-colors"
              >
                {copied ? "✓ copied" : "copy"}
              </button>
            </div>
            <pre className="px-4 py-3 text-xs font-mono text-text leading-relaxed whitespace-pre overflow-x-auto">
              {valuesText}
            </pre>
          </div>

          {/* Style options */}
          <div className="rounded-md border border-border bg-surface p-4 flex flex-col gap-3">
            <OptionRow
              label="dotShape"
              value={opt.dotShape}
              options={["square", "circle"]}
              onChange={(v) => setOpt((prev) => ({ ...prev, dotShape: v as Options["dotShape"] }))}
            />
            <OptionRow
              label="tailCut"
              value={opt.tailCut}
              options={["perpendicular", "horizontal"]}
              onChange={(v) => setOpt((prev) => ({ ...prev, tailCut: v as Options["tailCut"] }))}
            />
            <OptionRow
              label="baseline"
              value={opt.showBaseline}
              options={["off", "on"]}
              onChange={(v) => setOpt((prev) => ({ ...prev, showBaseline: v as Options["showBaseline"] }))}
            />
          </div>

          {/* Sliders */}
          <div className="rounded-md border border-border bg-surface p-4 flex flex-col gap-5">
            {PARAM_KEYS.map((key) => (
              <Slider
                key={key}
                label={key}
                hint={PARAM_HINTS[key]}
                value={p[key]}
                onValueChange={(v) => setP((prev) => ({ ...prev, [key]: v }))}
                range={ranges[key]}
                onRangeChange={(r) =>
                  setRanges((prev) => ({ ...prev, [key]: r }))
                }
              />
            ))}
          </div>

          <button
            type="button"
            onClick={reset}
            className="self-end text-xs font-mono text-text-muted hover:text-text transition-colors"
          >
            reset all
          </button>
        </aside>
      </div>

      {/* Preview at scales */}
      <section className="mt-16">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted mb-4">
          preview at scale
        </div>
        <div className="flex items-center gap-10 p-6 rounded-md border border-border bg-surface flex-wrap">
          {[120, 72, 44, 28, 18].map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <svg
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                style={{ height: size, width: "auto", color: "var(--color-text)" }}
              >
                <TomSymbol p={p} opt={opt} />
              </svg>
              <div className="text-[10px] font-mono text-text-muted">
                {size}px
              </div>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2 ml-6">
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              style={{ height: 72, width: "auto", color: "var(--color-accent)" }}
            >
              <TomSymbol p={p} opt={opt} />
            </svg>
            <div className="text-[10px] font-mono text-text-muted">accent</div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Slider with user-editable min/max, unbounded value input.
   ───────────────────────────────────────────────────────────── */

function Slider({
  label,
  hint,
  value,
  onValueChange,
  range,
  onRangeChange,
}: {
  label: string;
  hint: string;
  value: number;
  onValueChange: (v: number) => void;
  range: Range;
  onRangeChange: (r: Range) => void;
}) {
  // For the slider bar itself we need concrete min/max; parsed but
  // NOT clamped when the user types a value.
  const { min, max, step } = range;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-mono text-text">{label}</span>
        {/* Unbounded numeric input — no min/max clamping */}
        <input
          type="number"
          value={value}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onValueChange(v);
          }}
          className="w-24 text-right text-xs font-mono bg-transparent border border-border rounded px-1.5 py-0.5 text-text focus:outline-none focus:border-accent"
        />
      </div>

      {/* Slider row: [min][=====slider=====][max] */}
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={min}
          onChange={(e) => {
            const m = Number(e.target.value);
            if (!Number.isNaN(m)) onRangeChange({ ...range, min: m });
          }}
          aria-label={`${label} slider min`}
          className="w-16 text-[10px] font-mono bg-transparent border border-border rounded px-1.5 py-0.5 text-text-muted focus:outline-none focus:border-accent"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Math.max(min, Math.min(max, value))}
          onChange={(e) => onValueChange(Number(e.target.value))}
          className="flex-1 accent-[var(--color-accent)]"
        />
        <input
          type="number"
          value={max}
          onChange={(e) => {
            const m = Number(e.target.value);
            if (!Number.isNaN(m)) onRangeChange({ ...range, max: m });
          }}
          aria-label={`${label} slider max`}
          className="w-16 text-[10px] font-mono bg-transparent border border-border rounded px-1.5 py-0.5 text-text-muted focus:outline-none focus:border-accent"
        />
      </div>

      <span className="text-[10px] font-mono text-text-faint">{hint}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Segmented option row
   ───────────────────────────────────────────────────────────── */

function OptionRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-mono text-text">{label}</span>
      <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
        {options.map((o) => {
          const active = o === value;
          return (
            <button
              key={o}
              type="button"
              onClick={() => onChange(o)}
              className={`px-3 py-1 transition-colors ${
                active
                  ? "bg-accent text-bg"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}
