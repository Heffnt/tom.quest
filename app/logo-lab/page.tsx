"use client";

import { useState, useRef, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────
   Interactive tom-symbol designer.

   Fixed reference: a circle of radius R at (CX, CY) — this is
   the "Q" / the "o" of tom. Everything else is parameterised.

   Parameters you tune:
     tHeight     — vertical offset of the horizontal bar from
                   the circle's centre. Negative = above centre.
     mAngle      — acute angle of the M-diagonals from vertical (°).
     stroke      — uniform line / bar width.
     dotSize     — side length of the square dot.
     dotDistance — how far the dot sits past the circle along the
                   left diagonal's trajectory.
     dashExtend  — how far the right diagonal extends past the
                   circle along its own trajectory.

   Everything else is derived:
     barLeft/Right — chord of the circle at y = cy + tHeight
     leftEnd       — where the left diagonal meets the circle
     rightEnd      — leftEnd's mirror, plus dashExtend beyond
     dotCentre     — along the left-diagonal ray, tCircle+dotDistance
   ───────────────────────────────────────────────────────────── */

const CX = 320;
const CY = 270;
const R  = 170;
const VB_W = 640;
const VB_H = 540;

type Params = {
  tHeight: number;
  mAngle: number;
  stroke: number;
  dotSize: number;
  dotDistance: number;
  dashExtend: number;
};

const DEFAULTS: Params = {
  tHeight: -76,     // "seems about right" — ≈ -0.45·R
  mAngle: 22,       // less than the previous ~33°
  stroke: 14,
  dotSize: 28,
  dotDistance: 40,
  dashExtend: 58,
};

type Derived = {
  barY: number;
  barHalf: number;
  barLeftX: number;
  barRightX: number;
  tCircle: number;
  leftEnd: { x: number; y: number };
  rightEnd: { x: number; y: number };
  dotCentre: { x: number; y: number };
};

function derive(p: Params): Derived {
  const barY = CY + p.tHeight;
  const barHalf = Math.sqrt(Math.max(0, R * R - p.tHeight * p.tHeight));
  const aR = (p.mAngle * Math.PI) / 180;
  const sinA = Math.sin(aR);
  const cosA = Math.cos(aR);

  // Parametric distance from (CX, barY) along the diagonal ray where
  // the ray meets the Q circle. Solves s² + 2·tHeight·cos·s + (tHeight² - R²) = 0.
  const disc = Math.max(0, R * R - p.tHeight * p.tHeight * sinA * sinA);
  const tCircle = -p.tHeight * cosA + Math.sqrt(disc);

  const leftEnd = { x: CX - tCircle * sinA, y: barY + tCircle * cosA };
  const rightEnd = {
    x: CX + (tCircle + p.dashExtend) * sinA,
    y: barY + (tCircle + p.dashExtend) * cosA,
  };
  const dotCentre = {
    x: CX - (tCircle + p.dotDistance) * sinA,
    y: barY + (tCircle + p.dotDistance) * cosA,
  };

  return {
    barY,
    barHalf,
    barLeftX: CX - barHalf,
    barRightX: CX + barHalf,
    tCircle,
    leftEnd,
    rightEnd,
    dotCentre,
  };
}

/* ─────────────────────────────────────────────────────────────
   Symbol renderer (pure, given params).
   ───────────────────────────────────────────────────────────── */

function TomSymbol({
  p,
  showGuides = false,
}: {
  p: Params;
  showGuides?: boolean;
}) {
  const d = derive(p);
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

      {/* Horizontal bar — chord at y = barY */}
      <line
        x1={d.barLeftX}
        y1={d.barY}
        x2={d.barRightX}
        y2={d.barY}
        stroke="currentColor"
        strokeWidth={p.stroke}
        strokeLinecap="butt"
      />

      {/* Vertical (T-stem, M-middle) — from bar midpoint to circle bottom */}
      <line
        x1={CX}
        y1={d.barY}
        x2={CX}
        y2={CY + R}
        stroke="currentColor"
        strokeWidth={p.stroke}
        strokeLinecap="butt"
      />

      {/* Left M-diagonal — stops at circle edge */}
      <line
        x1={CX}
        y1={d.barY}
        x2={d.leftEnd.x}
        y2={d.leftEnd.y}
        stroke="currentColor"
        strokeWidth={p.stroke}
        strokeLinecap="butt"
      />

      {/* Right M-diagonal — extends past circle as Q tail */}
      <line
        x1={CX}
        y1={d.barY}
        x2={d.rightEnd.x}
        y2={d.rightEnd.y}
        stroke="currentColor"
        strokeWidth={p.stroke}
        strokeLinecap="butt"
      />

      {/* Dot terminus of left diagonal */}
      <rect
        x={d.dotCentre.x - p.dotSize / 2}
        y={d.dotCentre.y - p.dotSize / 2}
        width={p.dotSize}
        height={p.dotSize}
        fill="currentColor"
      />

      {showGuides && (
        <g opacity="0.35">
          {/* centre cross */}
          <line x1={CX - R - 20} y1={CY} x2={CX + R + 20} y2={CY} stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1={CX} y1={CY - R - 20} x2={CX} y2={CY + R + 20} stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="4 4" />
          {/* left-diagonal trajectory extended, to show the dot is on-axis */}
          <line
            x1={CX}
            y1={d.barY}
            x2={d.dotCentre.x - 30 * Math.sin((p.mAngle * Math.PI) / 180)}
            y2={d.dotCentre.y + 30 * Math.cos((p.mAngle * Math.PI) / 180)}
            stroke="var(--color-accent)"
            strokeWidth="1"
            strokeDasharray="2 4"
          />
        </g>
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────────────────
   Page
   ───────────────────────────────────────────────────────────── */

type DragMode = null | "t" | "m" | "dot";

export default function LogoLab() {
  const [p, setP] = useState<Params>(DEFAULTS);
  const [showGuides, setShowGuides] = useState(true);
  const [copied, setCopied] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<DragMode>(null);

  // Ref for params — avoids stale closure in global pointer listeners.
  const pRef = useRef(p);
  pRef.current = p;

  /* Convert a client-space pointer position into SVG user-space coords. */
  const toSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const s = pt.matrixTransform(ctm.inverse());
    return { x: s.x, y: s.y };
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      const s = toSvg(ev.clientX, ev.clientY);
      const cur = pRef.current;

      if (dragging === "t") {
        // tHeight is signed: negative above centre. Allow from just
        // above centre (-10) up to near the top of circle (-0.92·R).
        const next = Math.max(-R * 0.92, Math.min(-10, s.y - CY));
        setP((prev) => ({ ...prev, tHeight: Math.round(next) }));
        return;
      }

      if (dragging === "m") {
        const curBarY = CY + cur.tHeight;
        const dx = s.x - CX;
        const dy = s.y - curBarY;
        if (dy <= 0) return; // dragging above the bar: ignore (angle is from vertical downward)
        const dist = Math.sqrt(dx * dx + dy * dy);
        const rawDeg = Math.atan2(Math.abs(dx), dy) * (180 / Math.PI);
        const nextAngle = Math.max(3, Math.min(55, rawDeg));

        // Recompute tCircle for this new angle to keep dashExtend
        // expressed in "past-the-circle" units.
        const aR = (nextAngle * Math.PI) / 180;
        const sinA = Math.sin(aR);
        const disc = Math.max(0, R * R - cur.tHeight * cur.tHeight * sinA * sinA);
        const tC = -cur.tHeight * Math.cos(aR) + Math.sqrt(disc);
        const nextExtend = Math.max(0, Math.min(R * 1.1, dist - tC));

        setP((prev) => ({
          ...prev,
          mAngle: Math.round(nextAngle * 10) / 10,
          dashExtend: Math.round(nextExtend),
        }));
        return;
      }

      if (dragging === "dot") {
        // Project pointer onto the left-diagonal ray, measure distance
        // past the circle.
        const curBarY = CY + cur.tHeight;
        const aR = (cur.mAngle * Math.PI) / 180;
        const sinA = Math.sin(aR);
        const cosA = Math.cos(aR);
        // ray direction (left diagonal): (-sinA, cosA)
        const dx = s.x - CX;
        const dy = s.y - curBarY;
        const along = -dx * sinA + dy * cosA; // projection onto ray
        const disc = Math.max(0, R * R - cur.tHeight * cur.tHeight * sinA * sinA);
        const tC = -cur.tHeight * cosA + Math.sqrt(disc);
        const nextDotDist = Math.max(0, Math.min(R * 1.1, along - tC));
        setP((prev) => ({ ...prev, dotDistance: Math.round(nextDotDist) }));
        return;
      }
    };
    const onUp = () => setDragging(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, toSvg]);

  const d = derive(p);

  const valuesText =
    `tHeight:     ${p.tHeight}    // ${(p.tHeight / R).toFixed(3)} · R\n` +
    `mAngle:      ${p.mAngle}°\n` +
    `stroke:      ${p.stroke}\n` +
    `dotSize:     ${p.dotSize}\n` +
    `dotDistance: ${p.dotDistance}\n` +
    `dashExtend:  ${p.dashExtend}\n` +
    `// reference: R=${R}`;

  const copy = async () => {
    await navigator.clipboard.writeText(valuesText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const reset = () => setP(DEFAULTS);

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
          Drag the handles on the symbol, or use the sliders. Everything is
          derived from the Q circle — the bar is the circle&apos;s chord at the
          T-height, the left diagonal ends at the circle edge, the dot and the
          tail are measured <em>past</em> the circle along their ray.
        </p>
        <p className="mt-2 text-text-muted text-sm font-mono">
          amber handles: drag them.
        </p>
      </header>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* ── Canvas ─────────────────────────────────────── */}
        <div className="rounded-md border border-border bg-surface p-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full h-auto touch-none select-none"
            style={{ color: "var(--color-text)" }}
          >
            <TomSymbol p={p} showGuides={showGuides} />

            {/* ── Drag handles (rendered on top) ────────── */}
            {/* T-height handle: right end of the bar */}
            <g
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDragging("t");
              }}
              style={{ cursor: dragging === "t" ? "grabbing" : "grab" }}
            >
              <circle
                cx={d.barRightX}
                cy={d.barY}
                r={14}
                fill="var(--color-accent)"
                stroke="var(--color-bg)"
                strokeWidth="3"
              />
              <title>drag to change T-height</title>
            </g>

            {/* M-angle / tail handle: tip of the right diagonal */}
            <g
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDragging("m");
              }}
              style={{ cursor: dragging === "m" ? "grabbing" : "grab" }}
            >
              <circle
                cx={d.rightEnd.x}
                cy={d.rightEnd.y}
                r={14}
                fill="var(--color-accent)"
                stroke="var(--color-bg)"
                strokeWidth="3"
              />
              <title>drag to change M-angle and tail length</title>
            </g>

            {/* Dot-distance handle: on the dot itself */}
            <g
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDragging("dot");
              }}
              style={{ cursor: dragging === "dot" ? "grabbing" : "grab" }}
            >
              <circle
                cx={d.dotCentre.x}
                cy={d.dotCentre.y}
                r={14}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="3"
              />
              <title>drag along the left diagonal to move the dot</title>
            </g>
          </svg>
        </div>

        {/* ── Sidebar controls ─────────────────────────── */}
        <aside className="flex flex-col gap-5">
          {/* Values display */}
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

          {/* Sliders */}
          <div className="rounded-md border border-border bg-surface p-4 flex flex-col gap-4">
            <Slider
              label="T-height"
              hint="bar y-offset from circle centre (negative = above)"
              value={p.tHeight}
              min={-Math.round(R * 0.92)}
              max={-10}
              step={1}
              onChange={(v) => setP((prev) => ({ ...prev, tHeight: v }))}
            />
            <Slider
              label="M-angle"
              hint="diagonals' angle from vertical (°)"
              value={p.mAngle}
              min={3}
              max={55}
              step={0.5}
              onChange={(v) => setP((prev) => ({ ...prev, mAngle: v }))}
            />
            <Slider
              label="stroke"
              hint="uniform line width"
              value={p.stroke}
              min={4}
              max={28}
              step={1}
              onChange={(v) => setP((prev) => ({ ...prev, stroke: v }))}
            />
            <Slider
              label="dotSize"
              hint="square dot side length"
              value={p.dotSize}
              min={6}
              max={60}
              step={1}
              onChange={(v) => setP((prev) => ({ ...prev, dotSize: v }))}
            />
            <Slider
              label="dotDistance"
              hint="dot's distance past circle, along left diagonal"
              value={p.dotDistance}
              min={0}
              max={Math.round(R * 1.1)}
              step={1}
              onChange={(v) => setP((prev) => ({ ...prev, dotDistance: v }))}
            />
            <Slider
              label="dashExtend"
              hint="right diagonal's length past circle"
              value={p.dashExtend}
              min={0}
              max={Math.round(R * 1.1)}
              step={1}
              onChange={(v) => setP((prev) => ({ ...prev, dashExtend: v }))}
            />
          </div>

          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-xs font-mono text-text-muted">
              <input
                type="checkbox"
                checked={showGuides}
                onChange={(e) => setShowGuides(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              guides
            </label>
            <button
              type="button"
              onClick={reset}
              className="ml-auto text-xs font-mono text-text-muted hover:text-text transition-colors"
            >
              reset
            </button>
          </div>
        </aside>
      </div>

      {/* Preview at small scales — without handles */}
      <section className="mt-16">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted mb-4">
          preview at scale
        </div>
        <div className="flex items-center gap-10 p-6 rounded-md border border-border bg-surface flex-wrap">
          {[120, 72, 44, 28, 18].map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ height: size, width: "auto", color: "var(--color-text)" }}>
                <TomSymbol p={p} />
              </svg>
              <div className="text-[10px] font-mono text-text-muted">
                {size}px
              </div>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2 ml-6">
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ height: 72, width: "auto", color: "var(--color-accent)" }}>
              <TomSymbol p={p} />
            </svg>
            <div className="text-[10px] font-mono text-text-muted">accent</div>
          </div>
        </div>
      </section>

      <footer className="mt-16 pt-8 border-t border-border text-sm text-text-muted">
        When it looks right, hit <strong>copy</strong> and paste the values
        back to me. I&apos;ll then find a monospace font whose{" "}
        <code className="font-mono text-text">om</code> width matches{" "}
        <code className="font-mono text-text">ues</code> width (likely one with
        a wide <em>m</em>) and lock in the full logo.
      </footer>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Slider with numeric input, matching site's aesthetic.
   ───────────────────────────────────────────────────────────── */

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-mono text-text">{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
          className="w-20 text-right text-xs font-mono bg-transparent border border-border rounded px-1.5 py-0.5 text-text focus:outline-none focus:border-accent"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
      />
      <span className="text-[10px] font-mono text-text-faint">{hint}</span>
    </div>
  );
}
