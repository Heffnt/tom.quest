"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ── geometry ─────────────────────────────────────────────────── */

const CANVAS_SIZE = 440;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2 - 26;
const CIRCLE_R = 132;
const BAR_OFFSET = 70;
const BAR_HW = Math.sqrt(CIRCLE_R * CIRCLE_R - BAR_OFFSET * BAR_OFFSET);

const ARROW_X = CX;
const ARROW_Y = CANVAS_SIZE - 52;
const AIMER_LEN = 46;

/* ── gameplay ─────────────────────────────────────────────────── */

const TARGETS = [-Math.PI / 4.5, 0, Math.PI / 4.5];
const ZONE_TOL = Math.PI / 14;
const NUM_SLOTS = TARGETS.length;

const SPIN_BASE = 1.25;
const SPIN_ACCEL = 0.22;       // per hit — sustainable endless progression
const SPIN_CAP = 6.0;
const TRAVEL_MS = 200;
const INTRO_MS = 650;
const PERFECT_THRESHOLD = 0.9;
const PERFECT_CUE = 0.035;

/* ── aesthetic ────────────────────────────────────────────────── */

const STROKE_W = 7;
const AMBER = "#e8a040";
const AMBER_DIM = "rgba(232,160,64,0.55)";
const AMBER_FAINT = "rgba(232,160,64,0.18)";
const AMBER_GHOST = "rgba(232,160,64,0.25)";
const ERROR_RED = "#ef4444";

/* ── types ────────────────────────────────────────────────────── */

type Phase = "rest" | "playing" | "firing" | "fail";

interface PlacedLine {
  angle: number;
  hit: boolean;
  target: number | null;
  accuracy: number;
  flash: number;
}

interface Projectile {
  startMs: number;
  alpha: number;
  target: number | null;
  accuracy: number;
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
}

interface SymbolGameProps {
  onWin?: (ms: number, avgAccuracy: number) => void;
  onReset?: () => void;
}

/* ── helpers ──────────────────────────────────────────────────── */

function norm(a: number): number {
  let n = a % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n < -Math.PI) n += Math.PI * 2;
  return n;
}

function lineLenForAngle(a: number): number {
  const b = BAR_OFFSET, r = CIRCLE_R, sa = Math.sin(a);
  return b * Math.cos(a) + Math.sqrt(Math.max(0, r * r - b * b * sa * sa));
}

function aimLocalAngle(rot: number): number {
  const gx = ARROW_X - CX, gy = ARROW_Y - CY;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = gx * c - gy * s, ly = gx * s + gy * c;
  return Math.atan2(lx, ly + BAR_OFFSET);
}

function barMidpoint(rot: number): [number, number] {
  return [CX + BAR_OFFSET * Math.sin(rot), CY - BAR_OFFSET * Math.cos(rot)];
}

function currentSpeed(st: GameState, now: number): number {
  if (st.phase === "rest" || st.phase === "fail") return 0;
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
  color: string, width = STROKE_W,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function drawSymbolLines(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
) {
  for (const a of TARGETS) {
    const L = lineLenForAngle(a);
    strokeLine(ctx, 0, -BAR_OFFSET,
      Math.sin(a) * L, -BAR_OFFSET + Math.cos(a) * L,
      color, width);
  }
}

function drawZoneBounds(ctx: CanvasRenderingContext2D, takenTargets: Set<number>) {
  ctx.save();
  ctx.setLineDash([5, 9]);
  ctx.lineWidth = 2;
  ctx.lineCap = "butt";
  ctx.strokeStyle = AMBER_GHOST;
  for (const t of TARGETS) {
    if (takenTargets.has(t)) continue;
    for (const s of [-1, 1]) {
      const a = t + s * ZONE_TOL;
      const L = lineLenForAngle(a);
      ctx.beginPath();
      ctx.moveTo(0, -BAR_OFFSET);
      ctx.lineTo(Math.sin(a) * L, -BAR_OFFSET + Math.cos(a) * L);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function draw(
  ctx: CanvasRenderingContext2D,
  st: GameState,
  _now: number,
) {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Circle
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = STROKE_W;
  ctx.beginPath();
  ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
  ctx.stroke();

  // Rotating symbol
  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(st.rot);

  if (st.phase === "rest") {
    drawSymbolLines(ctx, AMBER, STROKE_W);
  }

  // Bar
  strokeLine(ctx, -BAR_HW, -BAR_OFFSET, BAR_HW, -BAR_OFFSET, AMBER, STROKE_W);

  // Zone boundary dashed lines (only in active play)
  if (st.phase === "playing" || st.phase === "firing") {
    const taken = new Set<number>();
    for (const l of st.placed) if (l.target !== null) taken.add(l.target);
    drawZoneBounds(ctx, taken);
  }

  // Placed lines
  for (const l of st.placed) {
    const L = lineLenForAngle(l.angle);
    const x1 = Math.sin(l.angle) * L;
    const y1 = -BAR_OFFSET + Math.cos(l.angle) * L;
    const color = l.hit ? AMBER : ERROR_RED;
    strokeLine(ctx, 0, -BAR_OFFSET, x1, y1, color, STROKE_W);
  }

  // Focal dot
  let dotR = 5;
  if (st.phase === "playing") {
    const alpha = aimLocalAngle(st.rot);
    let nearest = Infinity;
    for (const t of TARGETS) nearest = Math.min(nearest, Math.abs(norm(alpha - t)));
    if (nearest < PERFECT_CUE) {
      dotR = 5 + 3 * (1 - nearest / PERFECT_CUE);
    }
  }
  ctx.fillStyle = AMBER;
  ctx.beginPath();
  ctx.arc(0, -BAR_OFFSET, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Aimer / projectile
  const [bmx, bmy] = barMidpoint(st.rot);

  if (st.phase === "playing") {
    const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    strokeLine(ctx,
      ARROW_X - dx * AIMER_LEN * 0.55, ARROW_Y - dy * AIMER_LEN * 0.55,
      ARROW_X + dx * AIMER_LEN * 0.45, ARROW_Y + dy * AIMER_LEN * 0.45,
      AMBER, STROKE_W);
    const nx = -dy, ny = dx;
    const tailX = ARROW_X - dx * AIMER_LEN * 0.55;
    const tailY = ARROW_Y - dy * AIMER_LEN * 0.55;
    strokeLine(ctx,
      tailX + nx * 6, tailY + ny * 6,
      tailX - nx * 6, tailY - ny * 6,
      AMBER_DIM, STROKE_W - 2.5);
  }

  if (st.phase === "firing" && st.proj) {
    // Homing projectile: tip tracks current (moving) bar midpoint
    const ang = Math.atan2(bmy - st.proj.tipY, bmx - st.proj.tipX);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const trailL = AIMER_LEN + 20;
    const tailX = st.proj.tipX - dx * trailL;
    const tailY = st.proj.tipY - dy * trailL;
    const color = st.proj.target === null ? ERROR_RED : AMBER;
    strokeLine(ctx, tailX, tailY, st.proj.tipX, st.proj.tipY, color, STROKE_W);
  }
}

/* ── component ────────────────────────────────────────────────── */

export default function SymbolGame({ onReset }: SymbolGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  const [phase, setPhase] = useState<Phase>("rest");
  const [hits, setHits] = useState(0);
  const [perfects, setPerfects] = useState(0);

  const state = useRef<GameState>({
    phase: "rest",
    rot: 0,
    spinDir: Math.random() > 0.5 ? 1 : -1,
    placed: [],
    hits: 0,
    perfects: 0,
    startMs: 0,
    proj: null,
  });

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = CANVAS_SIZE * dpr;
    cvs.height = CANVAS_SIZE * dpr;
    cvs.style.width = `${CANVAS_SIZE}px`;
    cvs.style.height = `${CANVAS_SIZE}px`;
    ctx.scale(dpr, dpr);

    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const st = state.current;

      const speed = currentSpeed(st, now);
      if (speed > 0) st.rot = norm(st.rot + speed * st.spinDir * dt);

      for (const l of st.placed) if (l.flash > 0) l.flash = Math.max(0, l.flash - dt * 2.5);

      // Advance projectile tip toward current bar midpoint
      if (st.phase === "firing" && st.proj) {
        const [bmx, bmy] = barMidpoint(st.rot);
        const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
        const ease = 1 - Math.pow(1 - p, 2.2);
        // Lerp from launch origin (ARROW_X/Y) to current midpoint
        st.proj.tipX = ARROW_X + (bmx - ARROW_X) * ease;
        st.proj.tipY = ARROW_Y + (bmy - ARROW_Y) * ease;

        if (p >= 1) {
          const pr = st.proj;
          st.proj = null;
          if (pr.target === null) {
            st.placed.push({
              angle: pr.alpha,
              hit: false,
              target: null,
              accuracy: 0,
              flash: 1,
            });
            st.phase = "fail";
            setPhase("fail");
          } else {
            // Clear slate if we're about to fill the 3rd slot
            if (st.placed.length >= NUM_SLOTS) st.placed = [];
            st.placed.push({
              angle: pr.alpha,
              hit: true,
              target: pr.target,
              accuracy: pr.accuracy,
              flash: 1,
            });
            st.hits += 1;
            if (pr.accuracy >= PERFECT_THRESHOLD) st.perfects += 1;
            setHits(st.hits);
            setPerfects(st.perfects);
            st.spinDir *= -1;
            st.phase = "playing";
            setPhase("playing");
          }
        }
      }

      draw(ctx, st, now);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const handleFire = useCallback(() => {
    const st = state.current;

    if (st.phase === "rest" || st.phase === "fail") {
      const wasFinished = st.phase === "fail";
      st.placed = [];
      st.hits = 0;
      st.perfects = 0;
      st.phase = "playing";
      st.startMs = performance.now();
      st.rot = 0;
      st.spinDir = Math.random() > 0.5 ? 1 : -1;
      st.proj = null;
      setPhase("playing");
      setHits(0);
      setPerfects(0);
      if (wasFinished) onResetRef.current?.();
      return;
    }

    if (st.phase !== "playing") return;

    const alpha = aimLocalAngle(st.rot);
    const wrapping = st.placed.length >= NUM_SLOTS;
    let hitTarget: number | null = null;
    let bestAcc = 0;
    for (const t of TARGETS) {
      const d = Math.abs(norm(alpha - t));
      if (d <= ZONE_TOL) {
        if (!wrapping) {
          const taken = st.placed.some(l => l.target === t);
          if (taken) continue;
        }
        const acc = 1 - d / ZONE_TOL;
        if (acc > bestAcc) {
          bestAcc = acc;
          hitTarget = t;
        }
      }
    }

    st.proj = {
      startMs: performance.now(),
      alpha,
      target: hitTarget,
      accuracy: hitTarget === null ? 0 : bestAcc,
      tipX: ARROW_X,
      tipY: ARROW_Y,
    };
    st.phase = "firing";
    setPhase("firing");
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        handleFire();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleFire]);

  return (
    <div className="relative flex flex-col items-center">
      <div className="mb-3 h-16 flex flex-col items-center justify-end">
        {(phase === "playing" || phase === "firing" || phase === "fail") && (
          <>
            <span className="font-display text-5xl font-bold text-accent tabular-nums leading-none">
              {hits}
            </span>
            {perfects > 0 && (
              <span className="mt-1 font-mono text-[0.65rem] tracking-[0.3em] text-accent/60 uppercase tabular-nums">
                {perfects} perfect
              </span>
            )}
          </>
        )}
      </div>

      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Symbol game — press space to play"
        className="cursor-pointer select-none"
        style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        onClick={handleFire}
        onTouchStart={(e) => { e.preventDefault(); handleFire(); }}
      />

      <div className="pointer-events-none absolute left-0 right-0 flex justify-center"
           style={{ top: CY + CIRCLE_R + 46 + 76 }}>
        {phase === "rest" && (
          <p className="font-mono text-[0.7rem] tracking-[0.35em] text-accent/55 uppercase">
            press space
          </p>
        )}
        {phase === "fail" && (
          <p className="font-mono text-[0.6rem] tracking-[0.3em] text-text-faint uppercase">
            press space to retry
          </p>
        )}
      </div>
    </div>
  );
}
