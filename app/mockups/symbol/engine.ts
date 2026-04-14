"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const CANVAS_SIZE = 400;
export const CX = CANVAS_SIZE / 2;
export const CY = CANVAS_SIZE / 2 - 20;
export const CIRCLE_R = 115;
export const BAR_OFFSET = 62;
export const BAR_HW = Math.sqrt(CIRCLE_R * CIRCLE_R - BAR_OFFSET * BAR_OFFSET);
export const ARROW_X = CX;
export const ARROW_Y = CANVAS_SIZE - 38;
export const TARGETS = [-Math.PI / 4.5, 0, Math.PI / 4.5];
export const ZONE_TOL = Math.PI / 14;
export const NUM_LINES = TARGETS.length;
export const SPIN_BASE = 1.5;
export const SPIN_ACCEL = 0.4;
export const TRAVEL_MS = 240;

export type Phase = "idle" | "playing" | "firing" | "win" | "fail";
export interface PlacedLine { angle: number; flash: number; miss?: boolean; }
export interface Projectile { startMs: number; localAngle: number; hitTarget: number | null; }
export interface GameState {
  phase: Phase;
  rot: number;
  spinDir: number;
  placed: PlacedLine[];
  startMs: number;
  proj: Projectile | null;
}

export function norm(a: number): number {
  let n = a % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n < -Math.PI) n += Math.PI * 2;
  return n;
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${s}.${String(ms % 1000).padStart(3, "0")}s`;
}

// Length such that the line tip from bar midpoint lands on the circle.
export function lineLenForAngle(a: number): number {
  const b = BAR_OFFSET, r = CIRCLE_R, sa = Math.sin(a);
  return b * Math.cos(a) + Math.sqrt(Math.max(0, r * r - b * b * sa * sa));
}

export function aimLocalAngle(rot: number): number {
  const gx = ARROW_X - CX, gy = ARROW_Y - CY;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = gx * c - gy * s, ly = gx * s + gy * c;
  return Math.atan2(lx, ly + BAR_OFFSET);
}

export function barMidpoint(rot: number): [number, number] {
  return [CX + BAR_OFFSET * Math.sin(rot), CY - BAR_OFFSET * Math.cos(rot)];
}

export function useSymbolGame(opts: {
  draw: (ctx: CanvasRenderingContext2D, state: GameState, now: number) => void;
  onWin?: (ms: number) => void;
  onReset?: () => void;
}) {
  const { draw, onWin, onReset } = opts;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onWinRef = useRef(onWin); onWinRef.current = onWin;
  const onResetRef = useRef(onReset); onResetRef.current = onReset;
  const drawRef = useRef(draw); drawRef.current = draw;

  const [phase, setPhase] = useState<Phase>("idle");
  const [endMs, setEndMs] = useState(0);

  const state = useRef<GameState>({
    phase: "idle",
    rot: Math.random() * Math.PI * 2,
    spinDir: Math.random() > 0.5 ? 1 : -1,
    placed: [],
    startMs: 0,
    proj: null,
  });

  useEffect(() => {
    const cvs = canvasRef.current; if (!cvs) return;
    const ctx = cvs.getContext("2d"); if (!ctx) return;
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

      if (st.phase === "idle" || st.phase === "playing") {
        const hits = st.placed.filter(l => !l.miss).length;
        const speed = SPIN_BASE + hits * SPIN_ACCEL;
        st.rot = norm(st.rot + speed * st.spinDir * dt);
      }
      for (const l of st.placed) if (l.flash > 0) l.flash = Math.max(0, l.flash - dt * 2.5);

      if (st.phase === "firing" && st.proj && (now - st.proj.startMs) / TRAVEL_MS >= 1) {
        const p = st.proj;
        st.proj = null;
        if (p.hitTarget === null) {
          st.placed.push({ angle: p.localAngle, flash: 0, miss: true });
          st.phase = "fail"; setPhase("fail");
        } else {
          st.placed.push({ angle: p.hitTarget, flash: 1 });
          const hits = st.placed.filter(l => !l.miss).length;
          if (hits === NUM_LINES) {
            const ms = Math.round(now - st.startMs);
            st.phase = "win"; setPhase("win"); setEndMs(ms);
            onWinRef.current?.(ms);
          } else {
            if (Math.random() > 0.55) st.spinDir *= -1;
            st.phase = "playing"; setPhase("playing");
          }
        }
      }

      drawRef.current(ctx, st, now);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const fire = useCallback(() => {
    const st = state.current;
    if (st.phase === "idle" || st.phase === "win" || st.phase === "fail") {
      const wasFinished = st.phase === "win" || st.phase === "fail";
      st.placed = [];
      st.phase = "playing";
      st.startMs = performance.now();
      st.rot = Math.random() * Math.PI * 2;
      st.spinDir = Math.random() > 0.5 ? 1 : -1;
      st.proj = null;
      setPhase("playing");
      setEndMs(0);
      if (wasFinished) onResetRef.current?.();
      return;
    }
    if (st.phase !== "playing") return;
    const alpha = aimLocalAngle(st.rot);
    let hitTarget: number | null = null;
    for (let i = 0; i < TARGETS.length; i++) {
      if (Math.abs(norm(alpha - TARGETS[i])) <= ZONE_TOL) {
        const taken = st.placed.some(l => !l.miss && l.angle === TARGETS[i]);
        if (!taken) { hitTarget = TARGETS[i]; break; }
      }
    }
    st.proj = { startMs: performance.now(), localAngle: alpha, hitTarget };
    st.phase = "firing";
    setPhase("firing");
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") { e.preventDefault(); fire(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [fire]);

  return { canvasRef, phase, endMs, fire };
}
