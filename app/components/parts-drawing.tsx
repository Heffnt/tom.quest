"use client";

// ONE DRAWING OF JARVIS'S PARTS, as SVG. The geometry is shared/parts-drawing.mjs
// layoutGraph's, the port of WikiTom explainers.md's drawGraph; this component
// maps each primitive to its element and adds nothing to it, so the page, the
// thread's return and the box's check draw the same thing.
//
// A node whose id is a part is a control: `onSelect(id)` on a click or Enter.
// A crossing (an arrow through a box it does not connect) is a console error,
// as on an explainer.

import { useEffect, useMemo } from "react";
import { layoutGraph } from "@/shared/parts-drawing.mjs";

type DrawingNode = {
  id: string;
  label: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  type: string;
  fate?: string;
  use?: string;
};
type DrawingEdge = { from: string; to: string; label: string; type: string };
export type Drawing = { id: string; title: string; caption: string; nodes: DrawingNode[]; edges: DrawingEdge[] };

type Primitive = { tag: string; attrs: Record<string, string | number>; style: Record<string, string> };
type Layout = {
  width: number;
  height: number;
  regions: { id: string; x: number; y: number; w: number; h: number; label: string }[];
  arrows: {
    from: string;
    to: string;
    line: { x1: number; y1: number; x2: number; y2: number };
    head: string;
    colour: string;
    width: string;
    dash: string;
    bar?: { x1: number; y1: number; x2: number; y2: number };
    label?: { x: number; y: number; text: string; anchor: "start" | "middle" | "end"; baseline: "auto" | "middle" };
  }[];
  shapes: { id: string; primitives: Primitive[]; labels: { x: number; y: number; text: string; size: number; weight: number }[] }[];
  crossings: string[];
};

// The dark palette of explainers.md, with the page's background, and the five
// use-state fills (the legend's last row).
const COLOURS = {
  "--page-bg": "var(--color-bg)",
  "--muted": "#a9a6a0",
  "--diagram-line": "#b9b6af",
  "--diagram-text": "#ecebe7",
  "--diagram-edge-text": "#cfccc5",
  "--deny": "#e07a66",
  "--replaced": "#d1a462",
  "--proposed": "#78a8f0",
  "--node-program-fill": "#1d2a3d",
  "--node-program-stroke": "#7fa3dc",
  "--node-agent-fill": "#1a2640",
  "--node-agent-stroke": "#9ab8e8",
  "--node-page-fill": "#2a2236",
  "--node-page-stroke": "#b89ad6",
  "--node-store-fill": "#1d3024",
  "--node-store-stroke": "#79b98a",
  "--node-external-fill": "#33291b",
  "--node-external-stroke": "#d1a462",
  "--node-wall-fill": "#3a2320",
  "--node-wall-stroke": "#e07a66",
  "--node-document-fill": "#2f2c20",
  "--node-document-stroke": "#c9b86a",
  "--node-state-fill": "#26272a",
  "--node-state-stroke": "#a9a6a0",
  "--node-person-fill": "#2e2233",
  "--node-person-stroke": "#bb8cc7",
  "--node-region-fill": "transparent",
  "--node-region-stroke": "#4a4b4f",
  "--use-unverified": "transparent",
  "--use-run": "rgb(100 116 139 / 0.25)",
  "--use-in-use": "rgb(232 160 64 / 0.25)",
  "--use-working": "rgb(34 197 94 / 0.25)",
  "--use-issue": "rgb(239 68 68 / 0.35)",
} as React.CSSProperties;

// Nodes that are not parts: the legend's, the frames and the route prefixes.
const isPart = (drawing: Drawing, id: string) => drawing.id !== "legend" && !id.startsWith("region-") && !id.startsWith("prefix-");

function Element({ primitive }: { primitive: Primitive }) {
  const Tag = primitive.tag as "rect";
  return <Tag {...(primitive.attrs as object)} style={primitive.style} />;
}

export default function PartsDrawing({ diagram, onSelect }: { diagram: Drawing; onSelect?: (id: string) => void }) {
  const layout = useMemo(() => layoutGraph(diagram.nodes, diagram.edges) as Layout, [diagram]);
  useEffect(() => {
    for (const crossing of layout.crossings) console.error(`arrow crossing: ${diagram.id}: ${crossing}`);
  }, [layout, diagram.id]);

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={diagram.title}
      className="block h-auto w-full"
      style={{ ...COLOURS, maxWidth: `${layout.width}px` }}
    >
      {layout.regions.map((r) => (
        <g key={r.id}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} ry={10} style={{ fill: "var(--node-region-fill)", stroke: "var(--node-region-stroke)", strokeWidth: "1.2", strokeDasharray: "6 4" }} />
          <text x={r.x + 12} y={r.y + 6} dominantBaseline="hanging" style={{ fill: "var(--muted)", fontSize: "13px", fontWeight: 600, letterSpacing: "0.04em" }}>
            {r.label}
          </text>
        </g>
      ))}
      {layout.arrows.map((a, i) => (
        <g key={`${a.from}-${a.to}-${i}`}>
          <line {...a.line} style={{ stroke: a.colour, strokeWidth: a.width, strokeDasharray: a.dash }} />
          <polygon points={a.head} style={{ fill: a.colour }} />
          {a.bar && <line {...a.bar} style={{ stroke: a.colour, strokeWidth: "2.5" }} />}
          {a.label && (
            <text
              x={a.label.x}
              y={a.label.y}
              textAnchor={a.label.anchor}
              dominantBaseline={a.label.baseline}
              style={{ fill: "var(--diagram-edge-text)", fontSize: "13px", paintOrder: "stroke", stroke: "var(--page-bg)", strokeWidth: "5px", strokeLinejoin: "round" }}
            >
              {a.label.text}
            </text>
          )}
        </g>
      ))}
      {layout.shapes.map((shape) => {
        const body = (
          <>
            {shape.primitives.map((p, i) => (
              <Element key={i} primitive={p} />
            ))}
            {shape.labels.map((l, i) => (
              <text key={`t${i}`} x={l.x} y={l.y} textAnchor="middle" dominantBaseline="middle" style={{ fill: "var(--diagram-text)", fontSize: `${l.size}px`, fontWeight: l.weight }}>
                {l.text}
              </text>
            ))}
          </>
        );
        if (!isPart(diagram, shape.id) || onSelect === undefined) return <g key={shape.id}>{body}</g>;
        return (
          <g
            key={shape.id}
            id={`part-${shape.id}`}
            role="button"
            tabIndex={0}
            aria-label={shape.labels[0]?.text ?? shape.id}
            className="cursor-pointer outline-none hover:brightness-150 focus-visible:brightness-150"
            onClick={() => onSelect?.(shape.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect?.(shape.id);
            }}
          >
            {body}
          </g>
        );
      })}
    </svg>
  );
}
