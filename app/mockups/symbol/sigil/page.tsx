"use client";

import { useCallback } from "react";
import {
  useSymbolGame, CANVAS_SIZE, CX, CY, CIRCLE_R, BAR_OFFSET, BAR_HW,
  ARROW_X, ARROW_Y, TARGETS, TRAVEL_MS, lineLenForAngle, barMidpoint, fmtTime,
  type GameState,
} from "../engine";

const HUE = "232,160,64";
const COL = (a: number) => `rgba(${HUE},${a})`;
const STROKE_W = 3.5;

function strokeLine(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  color: string, width = STROKE_W, glow = 12,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

export default function SigilPage() {
  const draw = useCallback((ctx: CanvasRenderingContext2D, st: GameState, now: number) => {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Deep ambient pool
    const pool = ctx.createRadialGradient(CX, CY, CIRCLE_R * 0.1, CX, CY, CIRCLE_R * 1.6);
    pool.addColorStop(0, COL(0.12));
    pool.addColorStop(0.55, COL(0.04));
    pool.addColorStop(1, COL(0));
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const main = COL(0.95);

    // Circle
    ctx.strokeStyle = main;
    ctx.lineWidth = STROKE_W;
    ctx.lineCap = "round";
    ctx.shadowColor = main;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Rotating symbol
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(st.rot);

    // Faint guides
    ctx.save();
    ctx.setLineDash([2, 9]);
    ctx.strokeStyle = COL(0.12);
    ctx.lineWidth = 1;
    for (const a of TARGETS) {
      const L = lineLenForAngle(a);
      ctx.beginPath();
      ctx.moveTo(0, -BAR_OFFSET);
      ctx.lineTo(Math.sin(a) * L, -BAR_OFFSET + Math.cos(a) * L);
      ctx.stroke();
    }
    ctx.restore();

    // Bar
    strokeLine(ctx, -BAR_HW, -BAR_OFFSET, BAR_HW, -BAR_OFFSET, main, STROKE_W, 16);

    // Placed lines
    for (const l of st.placed) {
      const L = lineLenForAngle(l.angle);
      const x1 = Math.sin(l.angle) * L;
      const y1 = -BAR_OFFSET + Math.cos(l.angle) * L;
      const c = l.miss ? "rgba(239,68,68,0.95)" : COL(0.95);
      const glow = l.miss ? 14 : 14 + 22 * l.flash;
      strokeLine(ctx, 0, -BAR_OFFSET, x1, y1, c, STROKE_W, glow);
    }

    // Focal point — pulsing ember
    const pulse = 0.5 + 0.5 * Math.sin(now / 380);
    const focalR = 5 + pulse * 2.5;
    ctx.fillStyle = COL(0.98);
    ctx.shadowColor = main;
    ctx.shadowBlur = 18 + pulse * 14;
    ctx.beginPath();
    ctx.arc(0, -BAR_OFFSET, focalR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.restore();

    // Arrow (when playing/idle)
    const [bmx, bmy] = barMidpoint(st.rot);
    if (st.phase === "idle" || st.phase === "playing") {
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const tailX = ARROW_X - dx * 14;
      const tailY = ARROW_Y - dy * 14;
      const tipX = ARROW_X + dx * 9;
      const tipY = ARROW_Y + dy * 9;
      strokeLine(ctx, tailX, tailY, tipX, tipY, COL(0.85), STROKE_W, 10);
      // nock tick
      const nx = -dy, ny = dx;
      strokeLine(ctx, tailX + nx * 4, tailY + ny * 4, tailX - nx * 4, tailY - ny * 4, COL(0.6), 2, 4);
    }

    // Projectile
    if (st.phase === "firing" && st.proj) {
      const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
      const ease = 1 - Math.pow(1 - p, 2.2);
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const L = Math.hypot(bmx - ARROW_X, bmy - ARROW_Y);
      const tipX = ARROW_X + dx * L * ease;
      const tipY = ARROW_Y + dy * L * ease;
      const trailL = Math.min(L * ease, 46 + L * 0.35);
      const tailX = tipX - dx * trailL;
      const tailY = tipY - dy * trailL;
      strokeLine(ctx, tailX, tailY, tipX, tipY, COL(0.95), STROKE_W, 22);
      ctx.fillStyle = "rgba(255,230,180,1)";
      ctx.shadowColor = main;
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }, []);

  const { canvasRef, phase, endMs, fire } = useSymbolGame({ draw });

  return (
    <div
      className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-12"
      style={{
        background:
          "radial-gradient(ellipse at 50% 40%, #2a1a0a 0%, #0f0a05 55%, #050302 100%)",
      }}
    >
      <p className="font-mono text-[0.65rem] tracking-[0.3em] text-accent/50 uppercase mb-8">
        Mockup ⋅ Sigil
      </p>

      <div className="relative">
        <canvas
          ref={canvasRef}
          onClick={fire}
          onTouchStart={(e) => { e.preventDefault(); fire(); }}
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          className="cursor-pointer select-none"
        />

        {phase === "idle" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="font-display text-xl text-accent tracking-wide">Inscribe</p>
              <p className="font-mono text-[0.65rem] text-accent/40 mt-2 tracking-[0.25em] uppercase">
                space · tap
              </p>
            </div>
          </div>
        )}

        {phase === "win" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center backdrop-blur-[3px] bg-black/30 px-8 py-5 rounded">
              <p className="font-display text-3xl text-accent font-bold tracking-wider tabular-nums">
                {fmtTime(endMs)}
              </p>
              <p className="font-mono text-[0.65rem] text-accent/60 mt-2 tracking-[0.3em] uppercase">
                Sigil bound
              </p>
            </div>
          </div>
        )}

        {phase === "fail" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center backdrop-blur-[3px] bg-black/30 px-8 py-5 rounded">
              <p className="font-display text-2xl text-error font-bold tracking-wider">Severed</p>
              <p className="font-mono text-[0.65rem] text-accent/50 mt-2 tracking-[0.3em] uppercase">
                again
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
