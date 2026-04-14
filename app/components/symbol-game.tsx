"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ── layout ───────────────────────────────────────────────────── */

const CANVAS_SIZE = 400;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2 - 25;
const CIRCLE_R = 115;

// Bar midpoint sits at (0, -BAR_OFFSET) in the symbol's local frame.
// When the symbol rotates, the bar midpoint orbits (CX, CY) at radius BAR_OFFSET.
const BAR_OFFSET = 62;
const BAR_HW = 78;
const LINE_LEN = 128;

const ARROW_X = CX;
const ARROW_Y = CANVAS_SIZE - 42;

/* ── gameplay ─────────────────────────────────────────────────── */

const TARGETS = [-Math.PI / 4.5, 0, Math.PI / 4.5]; // local line angles to hit
const ZONE_TOL = Math.PI / 14;
const NUM_LINES = TARGETS.length;

const SPIN_BASE = 1.5;
const SPIN_ACCEL = 0.4;

/* ── types ────────────────────────────────────────────────────── */

type Phase = "idle" | "playing" | "win" | "fail";

interface PlacedLine {
  angle: number; // local angle in the symbol's frame
  flash: number; // 0..1 decay for placement feedback
  miss?: boolean;
}

interface SymbolGameProps {
  onWin?: (timeMs: number) => void;
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

// Given current rotation θ, return the local angle (from local +y, the symbol's
// "down" axis) of the direction from the bar midpoint to the arrow position.
// Firing places a line at exactly this angle — so aim == placement.
function aimLocalAngle(rot: number): number {
  const gx = ARROW_X - CX;
  const gy = ARROW_Y - CY;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const lx = gx * c - gy * s;
  const ly = gx * s + gy * c;
  const dx = lx;
  const dy = ly + BAR_OFFSET;
  return Math.atan2(dx, dy);
}

/* ── draw ─────────────────────────────────────────────────────── */

function draw(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  rot: number,
  placed: PlacedLine[],
  phase: Phase,
) {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const grd = ctx.createRadialGradient(CX, CY, CIRCLE_R * 0.3, CX, CY, CIRCLE_R * 1.3);
  grd.addColorStop(0, "rgba(232,160,64,0.06)");
  grd.addColorStop(1, "rgba(232,160,64,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.strokeStyle = "rgba(232,160,64,0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
  ctx.stroke();

  // Rotating symbol
  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(rot);

  ctx.save();
  ctx.setLineDash([3, 7]);
  ctx.strokeStyle = "rgba(232,160,64,0.08)";
  ctx.lineWidth = 1;
  for (const a of TARGETS) {
    ctx.beginPath();
    ctx.moveTo(0, -BAR_OFFSET);
    ctx.lineTo(Math.sin(a) * LINE_LEN, -BAR_OFFSET + Math.cos(a) * LINE_LEN);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(232,160,64,0.85)";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-BAR_HW, -BAR_OFFSET);
  ctx.lineTo(BAR_HW, -BAR_OFFSET);
  ctx.stroke();

  ctx.fillStyle = "rgba(232,160,64,0.9)";
  ctx.beginPath();
  ctx.arc(0, -BAR_OFFSET, 3, 0, Math.PI * 2);
  ctx.fill();

  for (const l of placed) {
    const color = l.miss
      ? `rgba(239,68,68,0.9)`
      : `rgba(232,160,64,${0.9 + 0.1 * l.flash})`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 + 2 * l.flash;
    ctx.beginPath();
    ctx.moveTo(0, -BAR_OFFSET);
    ctx.lineTo(Math.sin(l.angle) * LINE_LEN, -BAR_OFFSET + Math.cos(l.angle) * LINE_LEN);
    ctx.stroke();
  }

  ctx.restore();

  // Arrow (tracks bar midpoint)
  const bmx = CX + BAR_OFFSET * Math.sin(rot);
  const bmy = CY - BAR_OFFSET * Math.cos(rot);
  if (phase !== "win") {
    const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
    ctx.save();
    ctx.translate(ARROW_X, ARROW_Y);
    ctx.rotate(ang);
    ctx.strokeStyle = "rgba(232,160,64,0.55)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();
    ctx.fillStyle = "rgba(232,160,64,0.85)";
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(6, -5);
    ctx.lineTo(6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Shot pips
  const used = placed.filter(p => !p.miss).length;
  const sp = 16;
  const sx = CX - ((NUM_LINES - 1) * sp) / 2;
  for (let i = 0; i < NUM_LINES; i++) {
    ctx.fillStyle = i < used ? "rgba(232,160,64,0.8)" : "rgba(232,160,64,0.25)";
    ctx.beginPath();
    ctx.arc(sx + i * sp, CANVAS_SIZE - 14, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/* ── component ────────────────────────────────────────────────── */

export default function SymbolGame({ onWin }: SymbolGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onWinRef = useRef(onWin);
  onWinRef.current = onWin;

  const [phase, setPhase] = useState<Phase>("idle");
  const [endMs, setEndMs] = useState(0);

  const state = useRef({
    phase: "idle" as Phase,
    rot: Math.random() * Math.PI * 2,
    spinDir: Math.random() > 0.5 ? 1 : -1,
    placed: [] as PlacedLine[],
    startMs: 0,
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

    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const st = state.current;

      if (st.phase === "idle" || st.phase === "playing") {
        const hits = st.placed.filter(l => !l.miss).length;
        const speed = SPIN_BASE + hits * SPIN_ACCEL;
        st.rot = norm(st.rot + speed * st.spinDir * dt);
      }
      for (const l of st.placed) {
        if (l.flash > 0) l.flash = Math.max(0, l.flash - dt * 3);
      }

      draw(ctx, dpr, st.rot, st.placed, st.phase);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const handleFire = useCallback(() => {
    const st = state.current;

    if (st.phase === "idle" || st.phase === "win" || st.phase === "fail") {
      st.placed = [];
      st.phase = "playing";
      st.startMs = performance.now();
      st.rot = Math.random() * Math.PI * 2;
      st.spinDir = Math.random() > 0.5 ? 1 : -1;
      setPhase("playing");
      setEndMs(0);
      return;
    }

    if (st.phase !== "playing") return;

    const alpha = aimLocalAngle(st.rot);

    let hitTarget: number | null = null;
    for (let i = 0; i < TARGETS.length; i++) {
      if (Math.abs(norm(alpha - TARGETS[i])) <= ZONE_TOL) {
        const taken = st.placed.some(l => !l.miss && l.angle === TARGETS[i]);
        if (!taken) {
          hitTarget = TARGETS[i];
          break;
        }
      }
    }

    if (hitTarget === null) {
      st.placed.push({ angle: alpha, flash: 0, miss: true });
      st.phase = "fail";
      setPhase("fail");
      return;
    }

    st.placed.push({ angle: hitTarget, flash: 1 });

    const hits = st.placed.filter(l => !l.miss).length;
    if (hits === NUM_LINES) {
      const ms = Math.round(performance.now() - st.startMs);
      st.phase = "win";
      setPhase("win");
      setEndMs(ms);
      onWinRef.current?.(ms);
    } else if (Math.random() > 0.55) {
      st.spinDir *= -1;
    }
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
    <div className="relative">
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Symbol game - tap or press space to fire"
        className="cursor-pointer select-none"
        style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        onClick={handleFire}
        onTouchStart={(e) => {
          e.preventDefault();
          handleFire();
        }}
      />

      {phase === "idle" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-accent text-lg font-medium">Tap to Start</p>
            <p className="text-text-faint text-xs mt-1">or press Space</p>
          </div>
        </div>
      )}

      {phase === "win" && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/40 backdrop-blur-[2px] rounded-lg pointer-events-none">
          <div className="text-center">
            <p className="text-accent text-2xl font-bold">{fmtTime(endMs)}</p>
            <p className="text-text-muted text-sm mt-1">Symbol complete!</p>
            <p className="text-text-faint text-xs mt-3">Tap to play again</p>
          </div>
        </div>
      )}

      {phase === "fail" && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/40 backdrop-blur-[2px] rounded-lg pointer-events-none">
          <div className="text-center">
            <p className="text-error text-xl font-bold">Missed!</p>
            <p className="text-text-faint text-sm mt-1">Line landed outside a zone</p>
            <p className="text-text-faint text-xs mt-3">Tap to try again</p>
          </div>
        </div>
      )}

      {phase === "playing" && (
        <div className="mt-3 text-center">
          <span className="text-accent/50 text-sm font-mono tabular-nums">
            <LiveTimer start={state.current.startMs} />
          </span>
        </div>
      )}
    </div>
  );
}

function LiveTimer({ start }: { start: number }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMs(Math.round(performance.now() - start)), 47);
    return () => clearInterval(id);
  }, [start]);
  return <span>{fmtTime(ms)}</span>;
}
