"use client";

import { useCallback } from "react";
import {
  useSymbolGame, CANVAS_SIZE, CX, CY, CIRCLE_R, BAR_OFFSET, BAR_HW,
  ARROW_X, ARROW_Y, TARGETS, TRAVEL_MS, lineLenForAngle, barMidpoint, fmtTime,
  type GameState,
} from "../engine";

const INK = "rgba(190,225,245,0.95)";
const INK_DIM = "rgba(190,225,245,0.35)";
const INK_FAINT = "rgba(190,225,245,0.14)";
const MISS = "rgba(255,120,120,0.95)";
const STROKE_W = 1.75;

export default function BlueprintPage() {
  const draw = useCallback((ctx: CanvasRenderingContext2D, st: GameState, now: number) => {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Graph paper
    ctx.strokeStyle = "rgba(190,225,245,0.06)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_SIZE; x += 20) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_SIZE); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_SIZE; y += 20) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_SIZE, y); ctx.stroke();
    }
    // Major grid (every 100)
    ctx.strokeStyle = "rgba(190,225,245,0.11)";
    for (let x = 0; x <= CANVAS_SIZE; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_SIZE); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_SIZE; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_SIZE, y); ctx.stroke();
    }

    ctx.lineCap = "round";

    // Compass tick marks around circle
    ctx.strokeStyle = INK_DIM;
    ctx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const major = i % 6 === 0;
      const r0 = CIRCLE_R + 4;
      const r1 = CIRCLE_R + (major ? 10 : 6);
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0);
      ctx.lineTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
      ctx.stroke();
    }

    // Circle
    ctx.strokeStyle = INK;
    ctx.lineWidth = STROKE_W;
    ctx.beginPath();
    ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating symbol
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(st.rot);

    // Target guides (dotted)
    ctx.save();
    ctx.setLineDash([1, 5]);
    ctx.strokeStyle = INK_FAINT;
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
    ctx.strokeStyle = INK;
    ctx.lineWidth = STROKE_W;
    ctx.beginPath();
    ctx.moveTo(-BAR_HW, -BAR_OFFSET);
    ctx.lineTo(BAR_HW, -BAR_OFFSET);
    ctx.stroke();

    // Bar end caps (drafting serifs)
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * BAR_HW, -BAR_OFFSET - 4);
      ctx.lineTo(sx * BAR_HW, -BAR_OFFSET + 4);
      ctx.stroke();
    }

    // Placed lines
    for (const l of st.placed) {
      const L = lineLenForAngle(l.angle);
      const x1 = Math.sin(l.angle) * L;
      const y1 = -BAR_OFFSET + Math.cos(l.angle) * L;
      ctx.strokeStyle = l.miss ? MISS : INK;
      ctx.lineWidth = STROKE_W + l.flash * 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -BAR_OFFSET);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Focal point — crosshair
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);
    const s = 5 + pulse;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(-s, -BAR_OFFSET); ctx.lineTo(s, -BAR_OFFSET);
    ctx.moveTo(0, -BAR_OFFSET - s); ctx.lineTo(0, -BAR_OFFSET + s);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0, -BAR_OFFSET, 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Arrow
    const [bmx, bmy] = barMidpoint(st.rot);
    if (st.phase === "idle" || st.phase === "playing") {
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      ctx.strokeStyle = INK;
      ctx.lineWidth = STROKE_W;
      ctx.beginPath();
      ctx.moveTo(ARROW_X - dx * 12, ARROW_Y - dy * 12);
      ctx.lineTo(ARROW_X + dx * 9, ARROW_Y + dy * 9);
      ctx.stroke();
      // perpendicular tick (ruler)
      const nx = -dy, ny = dx;
      ctx.beginPath();
      ctx.moveTo(ARROW_X + nx * 4 - dx * 12, ARROW_Y + ny * 4 - dy * 12);
      ctx.lineTo(ARROW_X - nx * 4 - dx * 12, ARROW_Y - ny * 4 - dy * 12);
      ctx.stroke();

      // angle annotation
      ctx.fillStyle = INK_DIM;
      ctx.font = "10px var(--font-mono), monospace";
      ctx.textAlign = "center";
      const deg = ((ang * 180 / Math.PI + 90 + 360) % 360).toFixed(0);
      ctx.fillText(`θ ${deg}°`, ARROW_X, ARROW_Y + 22);
    }

    // Projectile (crisp, no glow)
    if (st.phase === "firing" && st.proj) {
      const p = Math.min(1, (now - st.proj.startMs) / TRAVEL_MS);
      const ease = 1 - Math.pow(1 - p, 2);
      const ang = Math.atan2(bmy - ARROW_Y, bmx - ARROW_X);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const L = Math.hypot(bmx - ARROW_X, bmy - ARROW_Y);
      const tipX = ARROW_X + dx * L * ease;
      const tipY = ARROW_Y + dy * L * ease;
      const tailX = ARROW_X + dx * L * Math.max(0, ease - 0.35);
      const tailY = ARROW_Y + dy * L * Math.max(0, ease - 0.35);
      ctx.strokeStyle = INK;
      ctx.lineWidth = STROKE_W;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const { canvasRef, phase, endMs, fire } = useSymbolGame({ draw });

  return (
    <div
      className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-12"
      style={{ background: "#0a1628" }}
    >
      <div className="mb-6 text-center">
        <p className="font-mono text-[0.6rem] tracking-[0.4em] uppercase"
           style={{ color: "rgba(190,225,245,0.4)" }}>
          DWG — SIGIL-01 · REV A
        </p>
        <p className="font-mono text-[0.6rem] tracking-[0.3em] uppercase mt-1"
           style={{ color: "rgba(190,225,245,0.25)" }}>
          SCALE 1:1 · UNITS PX
        </p>
      </div>

      <div className="relative p-4"
           style={{ border: "1px solid rgba(190,225,245,0.18)" }}>
        <canvas
          ref={canvasRef}
          onClick={fire}
          onTouchStart={(e) => { e.preventDefault(); fire(); }}
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          className="cursor-pointer select-none block"
        />

        {phase === "idle" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center"
                 style={{ background: "rgba(10,22,40,0.8)", border: "1px solid rgba(190,225,245,0.3)", padding: "14px 22px" }}>
              <p className="font-mono text-sm tracking-[0.25em] uppercase"
                 style={{ color: "rgba(190,225,245,0.9)" }}>
                [ SPACE ] TO PLOT
              </p>
            </div>
          </div>
        )}

        {phase === "win" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center"
                 style={{ background: "rgba(10,22,40,0.85)", border: "1px solid rgba(190,225,245,0.5)", padding: "16px 26px" }}>
              <p className="font-mono text-2xl tabular-nums font-bold"
                 style={{ color: "rgba(190,225,245,0.98)" }}>
                {fmtTime(endMs)}
              </p>
              <p className="font-mono text-[0.6rem] tracking-[0.3em] uppercase mt-2"
                 style={{ color: "rgba(190,225,245,0.55)" }}>
                ASSEMBLY COMPLETE
              </p>
            </div>
          </div>
        )}

        {phase === "fail" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center"
                 style={{ background: "rgba(10,22,40,0.85)", border: "1px solid rgba(255,120,120,0.5)", padding: "14px 22px" }}>
              <p className="font-mono text-base tracking-[0.2em] uppercase"
                 style={{ color: "rgba(255,120,120,0.95)" }}>
                TOLERANCE EXCEEDED
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 font-mono text-[0.6rem] tracking-[0.3em] uppercase"
           style={{ color: "rgba(190,225,245,0.25)" }}>
        R {CIRCLE_R} · B {BAR_OFFSET} · L VAR
      </div>
    </div>
  );
}
