"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ── constants ────────────────────────────────────────────────── */

const CANVAS_SIZE = 400;
const CIRCLE_R = 140;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2;

const PIVOT_OFFSET_Y = -CIRCLE_R * 0.35;
const PX = CX;
const PY = CY + PIVOT_OFFSET_Y;

const TARGETS = [
  -Math.PI / 4.5, // left diagonal (~-40°)
  0,               // center vertical
  Math.PI / 4.5,  // right diagonal (~+40°)
];

const ZONE_TOL = Math.PI / 14;
const LINE_LEN = CIRCLE_R - PIVOT_OFFSET_Y;
const BAR_HW = CIRCLE_R * 0.65;
const SPIN_BASE = 1.8;
const SPIN_ACCEL = 0.4;
const LAUNCH_MS = 160;

/* ── types ────────────────────────────────────────────────────── */

interface PlacedLine {
  localAngle: number;
  hit: boolean;
}

type Phase = "idle" | "playing" | "launching" | "win" | "fail";

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

/* ── draw ─────────────────────────────────────────────────────── */

function draw(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  rot: number,
  placed: PlacedLine[],
  launchProg: number | null,
  remaining: number,
) {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Circle
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
  ctx.stroke();

  // Rotating frame
  ctx.save();
  ctx.translate(PX, PY);
  ctx.rotate(rot);

  // Horizontal bar
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-BAR_HW, 0);
  ctx.lineTo(BAR_HW, 0);
  ctx.stroke();

  // Zone guides
  ctx.save();
  ctx.setLineDash([4, 8]);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (const a of TARGETS) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(a) * LINE_LEN, Math.cos(a) * LINE_LEN);
    ctx.stroke();
  }
  ctx.restore();

  // Placed lines
  for (const l of placed) {
    ctx.strokeStyle = l.hit ? "rgba(255,255,255,0.9)" : "rgba(255,80,80,0.9)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(l.localAngle) * LINE_LEN, Math.cos(l.localAngle) * LINE_LEN);
    ctx.stroke();
  }

  // Launching line
  if (launchProg !== null) {
    const ease = 1 - Math.pow(1 - launchProg, 3);
    const localA = norm(-rot);
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.6 * ease})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(localA) * LINE_LEN * ease, Math.cos(localA) * LINE_LEN * ease);
    ctx.stroke();
  }

  ctx.restore();

  // Waiting lines at bottom
  const sp = 20;
  const sx = CX - ((remaining - 1) * sp) / 2;
  for (let i = 0; i < remaining; i++) {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx + i * sp, CANVAS_SIZE - 35);
    ctx.lineTo(sx + i * sp, CANVAS_SIZE - 60);
    ctx.stroke();
  }

  // Up arrow
  if (remaining > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(CX, CANVAS_SIZE - 68);
    ctx.lineTo(CX - 6, CANVAS_SIZE - 58);
    ctx.lineTo(CX + 6, CANVAS_SIZE - 58);
    ctx.closePath();
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
  const [placed, setPlaced] = useState<PlacedLine[]>([]);
  const [endMs, setEndMs] = useState(0);
  const [spinDir, setSpinDir] = useState(1);

  const launchRef = useRef<{ start: number; rotAtLock: number } | null>(null);

  // Mutable refs for animation loop
  const s = useRef({
    phase: "idle" as Phase,
    rot: 0,
    placed: [] as PlacedLine[],
    spinDir: 1,
    startMs: 0,
  });

  /* ── animation loop ───────────────────────────────────────── */

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
      const dt = (now - prev) / 1000;
      prev = now;
      const st = s.current;

      if (st.phase === "playing" || st.phase === "launching") {
        const spd = SPIN_BASE + st.placed.length * SPIN_ACCEL;
        st.rot += spd * st.spinDir * dt;
      }

      let launchProg: number | null = null;
      if (st.phase === "launching" && launchRef.current) {
        const elapsed = now - launchRef.current.start;
        launchProg = Math.min(elapsed / LAUNCH_MS, 1);

        if (launchProg >= 1) {
          const localA = norm(-st.rot);

          let hit = false;
          for (let t = 0; t < TARGETS.length; t++) {
            if (Math.abs(norm(localA - TARGETS[t])) <= ZONE_TOL) {
              const alreadyTaken = st.placed.some(
                l => l.hit && Math.abs(norm(l.localAngle - TARGETS[t])) <= ZONE_TOL
              );
              if (!alreadyTaken) { hit = true; break; }
            }
          }

          const newLine: PlacedLine = { localAngle: localA, hit };
          const newPlaced = [...st.placed, newLine];
          st.placed = newPlaced;
          setPlaced(newPlaced);
          launchRef.current = null;
          launchProg = null;

          if (!hit) {
            st.phase = "fail";
            setPhase("fail");
          } else if (newPlaced.length === 3) {
            const elapsed = Math.round(now - st.startMs);
            st.phase = "win";
            setPhase("win");
            setEndMs(elapsed);
            setSpinDir(Math.random() > 0.5 ? 1 : -1);
            onWinRef.current?.(elapsed);
          } else {
            st.phase = "playing";
            setPhase("playing");
            if (Math.random() > 0.6) {
              st.spinDir *= -1;
              setSpinDir(st.spinDir);
            }
          }
        }
      }

      const remaining = 3 - st.placed.length - (launchProg !== null ? 1 : 0);
      draw(ctx, dpr, st.rot, st.placed, launchProg, remaining);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* ── tap ──────────────────────────────────────────────────── */

  const handleTap = useCallback(() => {
    const st = s.current;

    if (st.phase === "idle" || st.phase === "win" || st.phase === "fail") {
      st.placed = [];
      st.phase = "playing";
      st.startMs = performance.now();
      st.spinDir = spinDir;
      launchRef.current = null;
      setPlaced([]);
      setPhase("playing");
      setEndMs(0);
      return;
    }

    if (st.phase === "launching") return;

    if (st.phase === "playing") {
      launchRef.current = { start: performance.now(), rotAtLock: st.rot };
      st.phase = "launching";
      setPhase("launching");
    }
  }, [spinDir]);

  /* ── keyboard ─────────────────────────────────────────────── */

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") { e.preventDefault(); handleTap(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleTap]);

  /* ── render ───────────────────────────────────────────────── */

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Symbol game - tap or press space to play"
        className="cursor-pointer select-none"
        style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        onClick={handleTap}
        onTouchStart={(e) => { e.preventDefault(); handleTap(); }}
      />

      {phase === "idle" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-[--color-text]/70 text-lg font-medium">Tap to Start</p>
            <p className="text-[--color-text-faint] text-xs mt-1">or press Space</p>
          </div>
        </div>
      )}

      {phase === "win" && (
        <div className="absolute inset-0 flex items-center justify-center bg-[--color-bg]/40 backdrop-blur-[2px] rounded-lg pointer-events-none">
          <div className="text-center">
            <p className="text-[--color-success] text-2xl font-bold">{fmtTime(endMs)}</p>
            <p className="text-[--color-text-muted] text-sm mt-1">Symbol complete!</p>
            <p className="text-[--color-text-faint] text-xs mt-3">Tap to play again</p>
          </div>
        </div>
      )}

      {phase === "fail" && (
        <div className="absolute inset-0 flex items-center justify-center bg-[--color-bg]/40 backdrop-blur-[2px] rounded-lg pointer-events-none">
          <div className="text-center">
            <p className="text-[--color-error] text-xl font-bold">Missed!</p>
            <p className="text-[--color-text-faint] text-sm mt-1">Line landed outside a zone</p>
            <p className="text-[--color-text-faint] text-xs mt-3">Tap to try again</p>
          </div>
        </div>
      )}

      {(phase === "playing" || phase === "launching") && (
        <div className="mt-3 text-center">
          <span className="text-[--color-text-faint] text-sm font-mono tabular-nums">
            <LiveTimer start={s.current.startMs} />
          </span>
        </div>
      )}
    </div>
  );
}

/* ── live timer ───────────────────────────────────────────────── */

function LiveTimer({ start }: { start: number }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMs(Math.round(performance.now() - start)), 47);
    return () => clearInterval(id);
  }, [start]);
  return <span>{fmtTime(ms)}</span>;
}
