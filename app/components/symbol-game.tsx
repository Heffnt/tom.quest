"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_TOM_PARAMS } from "./tom-symbol";

/* ── gameplay constants ──────────────────────────────────────── */

const ZONE_TOL = Math.PI / 22;
const SPIN_BASE = 1.25;
const SPIN_ACCEL = 0.22;
const SPIN_CAP = 6.0;
const TRAVEL_MS = 200;
const INTRO_MS = 650;
const CLEAR_DELAY_MS = 500;
const PERFECT_THRESHOLD = 0.9;

/* ── aesthetic ────────────────────────────────────────────────── */

const AMBER = "#e8a040";
const AMBER_DIM = "rgba(232,160,64,0.55)";
const AMBER_GHOST = "rgba(232,160,64,0.25)";
const ERROR_RED = "#ef4444";

/* ── types ────────────────────────────────────────────────────── */

type Phase = "playing" | "firing" | "fail";

interface PlacedLine {
  angle: number;
  hit: boolean;
  target: number | null;
}

interface Projectile {
  startMs: number;
  alpha: number;
  target: number | null;
  tipX: number;
  tipY: number;
}

interface GameState {
  phase: Phase;
  rot: number;
  spinDir: number;
  placed: PlacedLine[];
  hits: number;
  perfects: number;
  startMs: number;
  proj: Projectile | null;
  clearAt: number | null;
}

interface Geom {
  size: number;
  cx: number;
  cy: number;
  circleR: number;
  barOffset: number;
  barHw: number;
  strokeW: number;
  arrowX: number;
  arrowY: number;
  aimerLen: number;
  targets: number[];
  numSlots: number;
}

interface SymbolGameProps {
  size?: number;
  onResult?: (result: { hits: number; perfects: number }) => void;
  onReset?: () => void;
}

/* ── geometry derivation ─────────────────────────────────────── */

// The game's geometry is derived from DEFAULT_TOM_PARAMS so that the rotating
// symbol visually matches the tom-symbol in the logo (thick strokes, same
// T-height proportion, same M-angle). The canvas is laid out vertically as:
// (top) ↓ symbol ↓ gap ↓ arrow/aimer ↓ (bottom).
function buildGeom(size: number): Geom {
  const p = DEFAULT_TOM_PARAMS;
  const R_VB = 170;
  const strokeFrac = p.stroke / (2 * R_VB);

  const circleR = size * 0.30;
  const strokeW = 2 * circleR * strokeFrac;
  const barOffset = circleR * (-p.tHeight / R_VB);
  const barHw = Math.sqrt(Math.max(0, circleR * circleR - barOffset * barOffset));

  const cx = size / 2;
  const cy = size * 0.441;

  const arrowX = cx;
  const arrowY = size * (388 / 440);
  const aimerLen = size * (46 / 440);

  const mA = (p.mAngle * Math.PI) / 180;
  const targets = [-mA, 0, mA];

  return {
    size, cx, cy, circleR, barOffset, barHw, strokeW,
    arrowX, arrowY, aimerLen,
    targets, numSlots: targets.length,
  };
}

/* ── helpers ──────────────────────────────────────────────────── */

function norm(a: number): number {
  let n = a % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n < -Math.PI) n += Math.PI * 2;
  return n;
}

function lineLenForAngle(a: number, g: Geom): number {
  const b = g.barOffset, r = g.circleR, sa = Math.sin(a);
  return b * Math.cos(a) + Math.sqrt(Math.max(0, r * r - b * b * sa * sa));
}

function aimLocalAngle(rot: number, g: Geom): number {
  const gx = g.arrowX - g.cx, gy = g.arrowY - g.cy;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = gx * c - gy * s, ly = gx * s + gy * c;
  return Math.atan2(lx, ly + g.barOffset);
}

function barMidpoint(rot: number, g: Geom): [number, number] {
  return [g.cx + g.barOffset * Math.sin(rot), g.cy - g.barOffset * Math.cos(rot)];
}

function currentSpeed(st: GameState, now: number): number {
  if (st.phase === "fail") return 0;
  const target = Math.min(SPIN_CAP, SPIN_BASE + st.hits * SPIN_ACCEL);
  if (st.hits === 0) {
    const t = Math.min(1, (now - st.startMs) / INTRO_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    return target * eased;
  }
  return target;
}

/* ── draw ─────────────────────────────────────────────────────── */

function strokeLine(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  color: string, width: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function drawZoneGuides(ctx: CanvasRenderingContext2D, g: Geom, takenTargets: Set<number>) {
  ctx.save();
  ctx.lineCap = "butt";
  for (const t of g.targets) {
    if (takenTargets.has(t)) continue;
    ctx.setLineDash([5, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = AMBER_GHOST;
    for (const s of [-1, 1]) {
      const a = t + s * ZONE_TOL;
      const L = lineLenForAngle(a, g);
      ctx.beginPath();
      ctx.moveTo(0, -g.barOffset);
      ctx.lineTo(Math.sin(a) * L, -g.barOffset + Math.cos(a) * L);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(180,180,180,0.35)";
    const L = lineLenForAngle(t, g);
    ctx.beginPath();
    ctx.moveTo(0, -g.barOffset);
    ctx.lineTo(Math.sin(t) * L, -g.barOffset + Math.cos(t) * L);
    ctx.stroke();
  }
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, st: GameState, g: Geom) {
  ctx.clearRect(0, 0, g.size, g.size);
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  // Q circle
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = g.strokeW;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.circleR, 0, Math.PI * 2);
  ctx.stroke();

  // Rotating symbol
  ctx.save();
  ctx.translate(g.cx, g.cy);
  ctx.rotate(st.rot);

  // Horizontal bar (the T crossbar / chord at barOffset above center)
  strokeLine(ctx, -g.barHw, -g.barOffset, g.barHw, -g.barOffset, AMBER, g.strokeW);

  // Zone guides (dashed lines show where you can shoot)
  if (st.phase === "playing" || st.phase === "firing") {
    const taken = new Set<number>();
    for (const l of st.placed) if (l.target !== null) taken.add(l.target);
    drawZoneGuides(ctx, g, taken);
  }

  // Placed lines (your shots, amber = hit, red = miss)
  for (const l of st.placed) {
    const L = lineLenForAngle(l.angle, g);
    const x1 = Math.sin(l.angle) * L;
    const y1 = -g.barOffset + Math.cos(l.angle) * L;
    const color = l.hit ? AMBER : ERROR_RED;
    strokeLine(ctx, 0, -g.barOffset, x1, y1, color, g.strokeW);
  }

  ctx.restore();

  // Aimer / projectile
  const [bmx, bmy] = barMidpoint(st.rot, g);

  if (st.phase === "playing") {
    const ang = Math.atan2(bmy - g.arrowY, bmx - g.arrowX);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    strokeLine(ctx,
      g.arrowX - dx * g.aimerLen * 0.55, g.arrowY - dy * g.aimerLen * 0.55,
      g.arrowX + dx * g.aimerLen * 0.45, g.arrowY + dy * g.aimerLen * 0.45,
      AMBER, g.strokeW * 0.5);
    const nx = -dy, ny = dx;
    const tailX = g.arrowX - dx * g.aimerLen * 0.55;
    const tailY = g.arrowY - dy * g.aimerLen * 0.55;
    strokeLine(ctx,
      tailX + nx * g.aimerLen * 0.13, tailY + ny * g.aimerLen * 0.13,
      tailX - nx * g.aimerLen * 0.13, tailY - ny * g.aimerLen * 0.13,
      AMBER_DIM, g.strokeW * 0.32);
  }

  if (st.phase === "firing" && st.proj) {
    const ang = Math.atan2(bmy - st.proj.tipY, bmx - st.proj.tipX);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const trailL = g.aimerLen + g.size * (20 / 440);
    const tailX = st.proj.tipX - dx * trailL;
    const tailY = st.proj.tipY - dy * trailL;
    const color = st.proj.target === null ? ERROR_RED : AMBER;
    strokeLine(ctx, tailX, tailY, st.proj.tipX, st.proj.tipY, color, g.strokeW * 0.5);
  }
}

/* ── component ────────────────────────────────────────────────── */

export default function SymbolGame({
  size = 440,
  onResult,
  onReset,
}: SymbolGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onResetRef = useRef(onReset);
  const onResultRef = useRef(onResult);
  onResetRef.current = onReset;
  onResultRef.current = onResult;

  const geom = useMemo(() => buildGeom(size), [size]);

  const [phase, setPhase] = useState<Phase>("playing");
  const [hits, setHits] = useState(0);
  const [perfects, setPerfects] = useState(0);

  const state = useRef<GameState>({
    phase: "playing",
    rot: 0,
    spinDir: Math.random() > 0.5 ? 1 : -1,
    placed: [],
    hits: 0,
    perfects: 0,
    startMs: 0,
    proj: null,
    clearAt: null,
  });

  // Initialize startMs on first mount
  useEffect(() => {
    state.current.startMs = performance.now();
  }, []);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = geom.size * dpr;
    cvs.height = geom.size * dpr;
    cvs.style.width = `${geom.size}px`;
    cvs.style.height = `${geom.size}px`;
    ctx.scale(dpr, dpr);

    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const st = state.current;

      const speed = currentSpeed(st, now);
      if (speed > 0) st.rot = norm(st.rot + speed * st.spinDir * dt);

      if (st.clearAt !== null && now >= st.clearAt) {
        st.placed = [];
        st.clearAt = null;
      }

      if (st.phase === "firing" && st.proj) {
        const [bmx, bmy] = barMidpoint(st.rot, geom);
        const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
        const ease = 1 - Math.pow(1 - p, 2.2);
        st.proj.tipX = geom.arrowX + (bmx - geom.arrowX) * ease;
        st.proj.tipY = geom.arrowY + (bmy - geom.arrowY) * ease;

        if (p >= 1) {
          const pr = st.proj;
          st.proj = null;
          if (pr.target === null) {
            st.placed.push({ angle: pr.alpha, hit: false, target: null });
            st.phase = "fail";
            setPhase("fail");
            onResultRef.current?.({ hits: st.hits, perfects: st.perfects });
          } else {
            st.placed.push({ angle: pr.alpha, hit: true, target: pr.target });
            st.hits += 1;
            setHits(st.hits);
            setPerfects(st.perfects);
            st.spinDir *= -1;
            if (st.placed.length >= geom.numSlots) st.clearAt = now + CLEAR_DELAY_MS;
            st.phase = "playing";
            setPhase("playing");
          }
        }
      }

      draw(ctx, st, geom);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [geom]);

  const handleFire = useCallback(() => {
    const st = state.current;

    if (st.phase === "fail") {
      st.placed = [];
      st.hits = 0;
      st.perfects = 0;
      st.phase = "playing";
      st.startMs = performance.now();
      st.rot = 0;
      st.spinDir = Math.random() > 0.5 ? 1 : -1;
      st.proj = null;
      st.clearAt = null;
      setPhase("playing");
      setHits(0);
      setPerfects(0);
      onResetRef.current?.();
      return;
    }

    if (st.phase !== "playing") return;
    if (st.clearAt !== null) return;

    const alpha = aimLocalAngle(st.rot, geom);
    let hitTarget: number | null = null;
    let bestAcc = 0;
    for (const t of geom.targets) {
      const d = Math.abs(norm(alpha - t));
      if (d <= ZONE_TOL) {
        const taken = st.placed.some(l => l.target === t);
        if (taken) continue;
        const acc = 1 - d / ZONE_TOL;
        if (acc > bestAcc) {
          bestAcc = acc;
          hitTarget = t;
        }
      }
    }

    if (hitTarget !== null && bestAcc >= PERFECT_THRESHOLD) {
      st.perfects += 1;
    }

    st.proj = {
      startMs: performance.now(),
      alpha,
      target: hitTarget,
      tipX: geom.arrowX,
      tipY: geom.arrowY,
    };
    st.phase = "firing";
    setPhase("firing");
  }, [geom]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        handleFire();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleFire]);

  return (
    <div className="relative flex flex-col items-center">
      <div className="mb-3 h-14 flex flex-col items-center justify-end">
        <span className="font-display text-5xl font-bold text-accent tabular-nums leading-none">
          {hits}
        </span>
        {perfects > 0 && (
          <span className="mt-1 font-mono text-[0.65rem] tracking-[0.3em] text-accent/60 uppercase tabular-nums">
            {perfects} perfect
          </span>
        )}
      </div>

      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Symbol game — press space or tap to fire"
        className="cursor-pointer select-none touch-none"
        style={{ width: geom.size, height: geom.size }}
        onClick={handleFire}
        onTouchStart={(e) => { e.preventDefault(); handleFire(); }}
      />

      <div className="pointer-events-none absolute left-0 right-0 flex justify-center"
           style={{ top: geom.cy + geom.circleR + geom.size * 0.26 }}>
        {phase === "fail" && (
          <p className="font-mono text-[0.65rem] tracking-[0.3em] text-text-faint uppercase">
            press space or tap to retry
          </p>
        )}
      </div>
    </div>
  );
}
