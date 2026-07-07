"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { source, type StratumPath } from "../state";
import type { TensorInfo } from "../lib/model";
import { divergingRgb } from "../lib/color";
import { Band } from "./strata";

const HEIGHT = 240;
const VALUE_ZOOM = 34; // cell px at which raw numbers appear

type View = { row0: number; col0: number; cell: number };

// The bottom of the drill: the actual weight matrix. Starts fit-to-view,
// wheel-zooms (anchored at the cursor) all the way down to raw fp values,
// drag pans. Color is signed: blue negative, amber positive, scaled to ±3σ.
export default function WeightsStratum({
  path,
  tensor,
  crumbs,
}: {
  path: StratumPath;
  tensor: TensorInfo;
  crumbs: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const dragRef = useRef<{ x: number; y: number; row0: number; col0: number } | null>(null);
  const rafRef = useRef(0);
  const [cursor, setCursor] = useState<{ r: number; c: number; v: number } | null>(null);
  const [range, setRange] = useState("");

  const stats = source.weightStats(tensor.name);
  const scale = 3 * stats.std;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!canvas || !view) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0e17";
    ctx.fillRect(0, 0, w, h);
    const { row0, col0, cell } = view;

    if (cell < 4) {
      // sample one weight per 2px screen block
      const bs = 2;
      for (let sy = 0; sy < h; sy += bs) {
        const r = Math.floor(row0 + sy / cell);
        if (r < 0 || r >= tensor.rows) continue;
        for (let sx = 0; sx < w; sx += bs) {
          const c = Math.floor(col0 + sx / cell);
          if (c < 0 || c >= tensor.cols) continue;
          const [cr, cg, cb] = divergingRgb(source.weightAt(tensor.name, r, c) / scale);
          ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
          ctx.fillRect(sx, sy, bs, bs);
        }
      }
    } else {
      const rStart = Math.max(0, Math.floor(row0));
      const cStart = Math.max(0, Math.floor(col0));
      const rEnd = Math.min(tensor.rows, Math.ceil(row0 + h / cell));
      const cEnd = Math.min(tensor.cols, Math.ceil(col0 + w / cell));
      const showValues = cell >= VALUE_ZOOM;
      if (showValues) {
        ctx.font = "10px var(--font-ibm-plex-mono), monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
      }
      for (let r = rStart; r < rEnd; r++) {
        for (let c = cStart; c < cEnd; c++) {
          const v = source.weightAt(tensor.name, r, c);
          const t = v / scale;
          const [cr, cg, cb] = divergingRgb(t);
          const x = (c - col0) * cell;
          const y = (r - row0) * cell;
          ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
          ctx.fillRect(x, y, cell - (cell > 8 ? 1 : 0), cell - (cell > 8 ? 1 : 0));
          if (showValues) {
            ctx.fillStyle = Math.abs(t) > 0.55 ? "#0a0e17" : "#94a3b8";
            ctx.fillText(v.toFixed(3), x + cell / 2, y + cell / 2);
          }
        }
      }
    }
    setRange(
      `rows ${Math.max(0, Math.floor(row0))}–${Math.min(tensor.rows, Math.ceil(row0 + h / cell))} · cols ${Math.max(0, Math.floor(col0))}–${Math.min(tensor.cols, Math.ceil(col0 + w / cell))}`,
    );
  }, [tensor, scale]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // size the canvas to its container; (re)fit on first layout
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      canvas.width = w * dpr;
      canvas.height = HEIGHT * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${HEIGHT}px`;
      if (!viewRef.current) {
        // extreme-tall matrices (embed/unembed: vocab × d) fit-to-width from
        // row 0 instead of shrinking to a sliver; everything else fits whole,
        // centered in the canvas
        if (tensor.rows > 8 * tensor.cols) {
          viewRef.current = { row0: 0, col0: 0, cell: w / tensor.cols };
        } else {
          const fit = Math.min(w / tensor.cols, HEIGHT / tensor.rows);
          viewRef.current = {
            row0: (tensor.rows - HEIGHT / fit) / 2,
            col0: (tensor.cols - w / fit) / 2,
            cell: fit,
          };
        }
      }
      schedule();
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [tensor, schedule]);

  // wheel zoom needs a non-passive listener to preventDefault page scroll
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      if (!view) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const fit = Math.min(rect.width / tensor.cols, HEIGHT / tensor.rows);
      const factor = Math.exp(-e.deltaY * 0.0016);
      const next = Math.min(64, Math.max(fit, view.cell * factor));
      const wr = view.row0 + my / view.cell;
      const wc = view.col0 + mx / view.cell;
      view.cell = next;
      view.row0 = wr - my / next;
      view.col0 = wc - mx / next;
      schedule();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [tensor, schedule]);

  const locate = (e: React.PointerEvent): { r: number; c: number } | null => {
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!canvas || !view) return null;
    const rect = canvas.getBoundingClientRect();
    const r = Math.floor(view.row0 + (e.clientY - rect.top) / view.cell);
    const c = Math.floor(view.col0 + (e.clientX - rect.left) / view.cell);
    if (r < 0 || r >= tensor.rows || c < 0 || c >= tensor.cols) return null;
    return { r, c };
  };

  return (
    <Band
      path={path}
      crumbs={crumbs}
      meta={
        <>
          <span>
            {tensor.rows.toLocaleString()} × {tensor.cols.toLocaleString()} · σ {stats.std.toFixed(3)}
          </span>
          <span
            className="inline-block h-2 w-16 rounded"
            style={{ background: "linear-gradient(to right, rgb(59,130,246), rgb(14,19,31), rgb(232,160,64))" }}
            title={`color scale ±3σ = ±${scale.toFixed(3)}`}
          />
          <span>±3σ</span>
        </>
      }
    >
      <div ref={wrapRef} className="relative">
        <canvas
          ref={canvasRef}
          className="cursor-crosshair rounded"
          onPointerDown={(e) => {
            const view = viewRef.current;
            if (!view) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            dragRef.current = { x: e.clientX, y: e.clientY, row0: view.row0, col0: view.col0 };
          }}
          onPointerUp={() => (dragRef.current = null)}
          onPointerMove={(e) => {
            const view = viewRef.current;
            if (!view) return;
            if (dragRef.current) {
              view.row0 = dragRef.current.row0 - (e.clientY - dragRef.current.y) / view.cell;
              view.col0 = dragRef.current.col0 - (e.clientX - dragRef.current.x) / view.cell;
              schedule();
            }
            const loc = locate(e);
            setCursor(loc ? { ...loc, v: source.weightAt(tensor.name, loc.r, loc.c) } : null);
          }}
          onPointerLeave={() => setCursor(null)}
        />
        <div className="pointer-events-none absolute bottom-1 left-1.5 rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[9px] text-text-faint">
          {range} · wheel zoom · drag pan{viewRef.current && viewRef.current.cell >= VALUE_ZOOM ? "" : " · zoom in for values"}
        </div>
        {cursor && (
          <div className="pointer-events-none absolute right-1.5 top-1 rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
            [{cursor.r}, {cursor.c}] = {cursor.v.toFixed(4)}
          </div>
        )}
      </div>
    </Band>
  );
}
