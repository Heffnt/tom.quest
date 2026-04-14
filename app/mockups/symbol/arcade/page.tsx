"use client";

import { useCallback } from "react";
import {
  useSymbolGame, CANVAS_SIZE, CX, CY, CIRCLE_R, BAR_OFFSET, BAR_HW,
  ARROW_X, ARROW_Y, TARGETS, TRAVEL_MS, lineLenForAngle, barMidpoint, fmtTime,
  type GameState,
} from "../engine";

const MAGENTA = "rgba(255,43,179,0.95)";
const MAGENTA_SOFT = "rgba(255,43,179,0.4)";
const CYAN = "rgba(80,230,255,0.95)";
const CYAN_SOFT = "rgba(80,230,255,0.45)";
const MISS = "rgba(255,230,80,0.95)";
const STROKE_W = 2.5;

function neonLine(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  outer: string, inner: string, width = STROKE_W, glow = 24,
) {
  ctx.lineCap = "round";
  // Outer glow stroke
  ctx.strokeStyle = outer;
  ctx.lineWidth = width + 3;
  ctx.shadowColor = outer;
  ctx.shadowBlur = glow;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.stroke();
  // Inner core
  ctx.strokeStyle = inner;
  ctx.lineWidth = width - 1;
  ctx.shadowColor = inner;
  ctx.shadowBlur = glow * 0.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

export default function ArcadePage() {
  const draw = useCallback((ctx: CanvasRenderingContext2D, st: GameState, now: number) => {
    // Background: black with subtle vignette
    ctx.fillStyle = "#050008";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const vig = ctx.createRadialGradient(CX, CY, CIRCLE_R * 0.2, CX, CY, CANVAS_SIZE * 0.75);
    vig.addColorStop(0, "rgba(120,20,80,0.15)");
    vig.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Scanlines
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    for (let y = 0; y < CANVAS_SIZE; y += 3) {
      ctx.fillRect(0, y, CANVAS_SIZE, 1);
    }

    // Circle — double-stroked neon
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = MAGENTA_SOFT;
    ctx.lineWidth = STROKE_W + 4;
    ctx.shadowColor = MAGENTA;
    ctx.shadowBlur = 28;
    ctx.beginPath(); ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = MAGENTA;
    ctx.lineWidth = STROKE_W;
    ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Rotating symbol
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(st.rot);

    // Target guides
    ctx.save();
    ctx.setLineDash([3, 8]);
    ctx.strokeStyle = "rgba(255,43,179,0.18)";
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
    neonLine(ctx, -BAR_HW, -BAR_OFFSET, BAR_HW, -BAR_OFFSET, MAGENTA_SOFT, MAGENTA, STROKE_W, 26);

    // Placed lines
    for (const l of st.placed) {
      const L = lineLenForAngle(l.angle);
      const x1 = Math.sin(l.angle) * L;
      const y1 = -BAR_OFFSET + Math.cos(l.angle) * L;
      if (l.miss) {
        neonLine(ctx, 0, -BAR_OFFSET, x1, y1, "rgba(255,230,80,0.4)", MISS, STROKE_W, 20);
      } else {
        const glow = 22 + 18 * l.flash;
        neonLine(ctx, 0, -BAR_OFFSET, x1, y1, CYAN_SOFT, CYAN, STROKE_W, glow);
      }
    }

    // Focal point — cyan pulse with magenta ring
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    ctx.save();
    // outer magenta ring
    ctx.strokeStyle = MAGENTA;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = MAGENTA;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, -BAR_OFFSET, 8 + pulse * 2, 0, Math.PI * 2);
    ctx.stroke();
    // inner cyan dot
    ctx.fillStyle = CYAN;
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.arc(0, -BAR_OFFSET, 3.5 + pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    ctx.restore();

    const [bmx, bmy] = barMidpoint(st.rot);

    // Arrow
    if (st.phase === "idle" || st.phase === "playing") {
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      neonLine(ctx,
        ARROW_X - dx * 14, ARROW_Y - dy * 14,
        ARROW_X + dx * 10, ARROW_Y + dy * 10,
        CYAN_SOFT, CYAN, STROKE_W, 20);
      const nx = -dy, ny = dx;
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(ARROW_X - dx * 14 + nx * 5, ARROW_Y - dy * 14 + ny * 5);
      ctx.lineTo(ARROW_X - dx * 14 - nx * 5, ARROW_Y - dy * 14 - ny * 5);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Projectile
    if (st.phase === "firing" && st.proj) {
      const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
      const ease = 1 - Math.pow(1 - p, 2.3);
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const L = Math.hypot(bmx - ARROW_X, bmy - ARROW_Y);
      const tipX = ARROW_X + dx * L * ease;
      const tipY = ARROW_Y + dy * L * ease;
      const trailL = Math.min(L * ease, 60 + L * 0.4);
      const tailX = tipX - dx * trailL;
      const tailY = tipY - dy * trailL;
      neonLine(ctx, tailX, tailY, tipX, tipY, CYAN_SOFT, CYAN, STROKE_W + 0.5, 32);
      ctx.fillStyle = "white";
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 26;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
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
          "radial-gradient(ellipse at 50% 50%, #1a0212 0%, #05000a 60%, #000000 100%)",
      }}
    >
      <p className="font-display text-xs tracking-[0.5em] uppercase mb-8"
         style={{ color: MAGENTA, textShadow: `0 0 10px ${MAGENTA}` }}>
        ◆ INSCRIBER ◆
      </p>

      <div className="relative">
        <canvas
          ref={canvasRef}
          onClick={fire}
          onTouchStart={(e) => { e.preventDefault(); fire(); }}
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          className="cursor-pointer select-none block"
        />

        {phase === "idle" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="font-display text-2xl font-bold tracking-[0.2em] uppercase"
                 style={{ color: CYAN, textShadow: `0 0 14px ${CYAN}` }}>
                Insert Coin
              </p>
              <p className="font-mono text-[0.65rem] tracking-[0.35em] uppercase mt-3"
                 style={{ color: MAGENTA, textShadow: `0 0 8px ${MAGENTA}` }}>
                ▸ press space
              </p>
            </div>
          </div>
        )}

        {phase === "win" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center px-8 py-4"
                 style={{
                   background: "rgba(0,0,0,0.55)",
                   boxShadow: `0 0 30px ${CYAN}, inset 0 0 20px rgba(80,230,255,0.1)`,
                   border: `1px solid ${CYAN}`,
                 }}>
              <p className="font-display text-3xl font-bold tabular-nums"
                 style={{ color: CYAN, textShadow: `0 0 16px ${CYAN}` }}>
                {fmtTime(endMs)}
              </p>
              <p className="font-mono text-[0.65rem] tracking-[0.35em] uppercase mt-2"
                 style={{ color: MAGENTA, textShadow: `0 0 10px ${MAGENTA}` }}>
                HIGH SCORE
              </p>
            </div>
          </div>
        )}

        {phase === "fail" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center px-8 py-4"
                 style={{
                   background: "rgba(0,0,0,0.55)",
                   border: `1px solid ${MISS}`,
                   boxShadow: `0 0 20px ${MISS}`,
                 }}>
              <p className="font-display text-2xl font-bold tracking-[0.2em] uppercase"
                 style={{ color: MISS, textShadow: `0 0 14px ${MISS}` }}>
                GAME OVER
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
