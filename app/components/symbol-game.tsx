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

const TARGETS = [-Math.PI / 4.5, 0, Math.PI / 4.5]; // ±40°, 0°
const ZONE_TOL = Math.PI / 14;                      // ~12.9° half-width
const NUM_LINES = TARGETS.length;

const SPIN_BASE = 1.25;     // rad/s — aim sweeps ~51°/s
const SPIN_ACCEL = 0.55;    // per placed hit
const TRAVEL_MS = 220;      // projectile flight
const INTRO_MS = 650;       // ease-in from rest
const PERFECT_CUE = 0.03;   // radians — aim-within for focal pulse

/* ── aesthetic ────────────────────────────────────────────────── */

const STROKE_W = 5;
const AMBER = "#e8a040";
const AMBER_DIM = "rgba(232,160,64,0.55)";
const AMBER_FAINT = "rgba(232,160,64,0.18)";
const AMBER_GHOST = "rgba(232,160,64,0.08)";
const ERROR_RED = "#ef4444";

/* ── types ────────────────────────────────────────────────────── */

type Phase = "rest" | "playing" | "firing" | "win" | "fail";

interface PlacedLine {
  angle: number;
  target: number | null;   // null on miss
  accuracy: number;        // 0..1 for hits, 0 for miss
  flash: number;
}

interface Projectile {
  startMs: number;
  alpha: number;
  target: number | null;
  accuracy: number;
}

interface GameState {
  phase: Phase;
  rot: number;
  spinDir: number;
  placed: PlacedLine[];
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

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${s}.${String(ms % 1000).padStart(3, "0")}s`;
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
  if (st.phase === "rest" || st.phase === "firing") return 0;
  if (st.phase === "win" || st.phase === "fail") return 0;
  const hits = st.placed.filter(l => l.target !== null).length;
  const target = SPIN_BASE + hits * SPIN_ACCEL;
  // Ease-in only applies before first shot
  if (hits === 0) {
    const t = Math.min(1, (now - st.startMs) / INTRO_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    return target * eased;
  }
  return target;
}

function gradeOf(accs: number[]): string {
  if (accs.length === 0) return "";
  const min = Math.min(...accs);
  if (min >= 0.92) return "S";
  if (min >= 0.75) return "A";
  if (min >= 0.55) return "B";
  return "C";
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

function draw(
  ctx: CanvasRenderingContext2D,
  st: GameState,
  now: number,
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

  // Rest: the canonical solid Tom symbol.
  // Playing/win/fail: faint guides so placed-line offset is readable.
  if (st.phase === "rest") {
    drawSymbolLines(ctx, AMBER, STROKE_W);
  } else {
    drawSymbolLines(ctx, AMBER_FAINT, STROKE_W);
  }

  // Bar
  strokeLine(ctx, -BAR_HW, -BAR_OFFSET, BAR_HW, -BAR_OFFSET, AMBER, STROKE_W);

  // Placed lines (full solid, layered over the guides)
  for (const l of st.placed) {
    const L = lineLenForAngle(l.angle);
    const x1 = Math.sin(l.angle) * L;
    const y1 = -BAR_OFFSET + Math.cos(l.angle) * L;
    const color = l.target === null ? ERROR_RED : AMBER;
    strokeLine(ctx, 0, -BAR_OFFSET, x1, y1, color, STROKE_W);
  }

  // Focal dot at bar midpoint
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

  // Below-circle aimer + projectile
  const [bmx, bmy] = barMidpoint(st.rot);

  if (st.phase === "playing") {
    const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    // Main aimer line (full weight, pointed at bar midpoint)
    strokeLine(ctx,
      ARROW_X - dx * AIMER_LEN * 0.55, ARROW_Y - dy * AIMER_LEN * 0.55,
      ARROW_X + dx * AIMER_LEN * 0.45, ARROW_Y + dy * AIMER_LEN * 0.45,
      AMBER, STROKE_W);
    // nock tick (bowstring)
    const nx = -dy, ny = dx;
    const tailX = ARROW_X - dx * AIMER_LEN * 0.55;
    const tailY = ARROW_Y - dy * AIMER_LEN * 0.55;
    strokeLine(ctx,
      tailX + nx * 6, tailY + ny * 6,
      tailX - nx * 6, tailY - ny * 6,
      AMBER_DIM, STROKE_W - 1.5);
  }

  if (st.phase === "firing" && st.proj) {
    const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
    const ease = 1 - Math.pow(1 - p, 2.2);
    const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const L = Math.hypot(bmx - ARROW_X, bmy - ARROW_Y);
    const tipX = ARROW_X + dx * L * ease;
    const tipY = ARROW_Y + dy * L * ease;
    const trailL = Math.min(L * ease, AIMER_LEN + L * 0.35);
    const tailX = tipX - dx * trailL;
    const tailY = tipY - dy * trailL;
    const color = st.proj.target === null ? ERROR_RED : AMBER;
    strokeLine(ctx, tailX, tailY, tipX, tipY, color, STROKE_W);
  }

  // Shot pips — colored by accuracy
  const sp = 20;
  const sx = CX - ((NUM_LINES - 1) * sp) / 2;
  for (let i = 0; i < NUM_LINES; i++) {
    const placed = st.placed[i];
    ctx.lineWidth = 2;
    if (!placed) {
      ctx.strokeStyle = AMBER_FAINT;
      ctx.beginPath();
      ctx.arc(sx + i * sp, CANVAS_SIZE - 22, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (placed.target === null) {
      ctx.strokeStyle = ERROR_RED;
      ctx.beginPath();
      ctx.arc(sx + i * sp, CANVAS_SIZE - 22, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Fill proportional to accuracy
      const a = placed.accuracy;
      ctx.fillStyle = AMBER;
      ctx.beginPath();
      ctx.arc(sx + i * sp, CANVAS_SIZE - 22, 3 + a * 2, 0, Math.PI * 2);
      ctx.fill();
      if (a >= 0.92) {
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx + i * sp, CANVAS_SIZE - 22, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

/* ── component ────────────────────────────────────────────────── */

export default function SymbolGame({ onWin, onReset }: SymbolGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onWinRef = useRef(onWin);
  const onResetRef = useRef(onReset);
  onWinRef.current = onWin;
  onResetRef.current = onReset;

  const [phase, setPhase] = useState<Phase>("rest");
  const [endMs, setEndMs] = useState(0);
  const [accuracies, setAccuracies] = useState<number[]>([]);

  const state = useRef<GameState>({
    phase: "rest",
    rot: 0,
    spinDir: Math.random() > 0.5 ? 1 : -1,
    placed: [],
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

      if (st.phase === "firing" && st.proj && (now - st.proj.startMs) / TRAVEL_MS >= 1) {
        const p = st.proj;
        st.proj = null;
        st.placed.push({
          angle: p.alpha,
          target: p.target,
          accuracy: p.accuracy,
          flash: 1,
        });
        if (p.target === null) {
          st.phase = "fail";
          setPhase("fail");
          setAccuracies(st.placed.map(l => l.accuracy));
        } else {
          const hits = st.placed.filter(l => l.target !== null).length;
          if (hits === NUM_LINES) {
            const ms = Math.round(now - st.startMs - INTRO_MS * 0.5);
            const accs = st.placed.map(l => l.accuracy);
            const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
            st.phase = "win";
            setPhase("win");
            setEndMs(ms);
            setAccuracies(accs);
            onWinRef.current?.(ms, avg);
          } else {
            if (Math.random() > 0.55) st.spinDir *= -1;
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

    // Start a new run (from rest, win, or fail)
    if (st.phase === "rest" || st.phase === "win" || st.phase === "fail") {
      const wasFinished = st.phase === "win" || st.phase === "fail";
      st.placed = [];
      st.phase = "playing";
      st.startMs = performance.now();
      st.rot = 0; // begin from the canonical upright position
      st.spinDir = Math.random() > 0.5 ? 1 : -1;
      st.proj = null;
      setPhase("playing");
      setEndMs(0);
      setAccuracies([]);
      if (wasFinished) onResetRef.current?.();
      return;
    }

    if (st.phase !== "playing") return;

    const alpha = aimLocalAngle(st.rot);
    let hitTarget: number | null = null;
    let bestAcc = 0;
    for (const t of TARGETS) {
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

    st.proj = {
      startMs: performance.now(),
      alpha,
      target: hitTarget,
      accuracy: hitTarget === null ? 0 : bestAcc,
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

  const grade = gradeOf(accuracies.filter((_, i) => i < NUM_LINES && accuracies[i] > 0));
  const allHits = accuracies.length === NUM_LINES && accuracies.every(a => a > 0);

  return (
    <div className="relative flex flex-col items-center">
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Symbol game — press space to play"
        className="cursor-pointer select-none"
        style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        onClick={handleFire}
        onTouchStart={(e) => { e.preventDefault(); handleFire(); }}
      />

      {/* Overlays positioned inside the canvas area */}
      <div className="pointer-events-none absolute left-0 right-0 flex justify-center"
           style={{ top: CY + CIRCLE_R + 46 }}>
        {phase === "rest" && (
          <p className="font-mono text-[0.7rem] tracking-[0.35em] text-accent/55 uppercase">
            press space
          </p>
        )}
        {phase === "playing" && (
          <p className="font-mono text-[0.7rem] tracking-[0.3em] text-accent/40 uppercase tabular-nums">
            <LiveTimer start={state.current.startMs} /> · {state.current.placed.filter(l => l.target !== null).length}/{NUM_LINES}
          </p>
        )}
        {phase === "firing" && (
          <p className="font-mono text-[0.7rem] tracking-[0.3em] text-accent/40 uppercase tabular-nums">
            <LiveTimer start={state.current.startMs} />
          </p>
        )}
        {phase === "win" && allHits && (
          <div className="text-center">
            <div className="flex items-baseline gap-4 justify-center">
              <span className="font-display text-3xl font-bold text-accent tabular-nums">
                {fmtTime(endMs)}
              </span>
              <span className="font-display text-2xl font-bold text-accent/80">
                {grade}
              </span>
            </div>
            <p className="mt-2 font-mono text-[0.65rem] tracking-[0.3em] text-accent/50 uppercase">
              {accuracies.map(a => Math.round(a * 100)).join(" · ")}
            </p>
            <p className="mt-1 font-mono text-[0.6rem] tracking-[0.3em] text-text-faint uppercase">
              press space to play again
            </p>
          </div>
        )}
        {phase === "fail" && (
          <div className="text-center">
            <p className="font-display text-lg font-bold text-error tracking-wide">Miss</p>
            <p className="mt-1 font-mono text-[0.6rem] tracking-[0.3em] text-text-faint uppercase">
              press space to retry
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveTimer({ start }: { start: number }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMs(Math.max(0, Math.round(performance.now() - start - INTRO_MS * 0.5))), 47);
    return () => clearInterval(id);
  }, [start]);
  return <span>{fmtTime(ms)}</span>;
}
