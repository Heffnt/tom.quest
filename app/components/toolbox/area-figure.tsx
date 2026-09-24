"use client";

// AreaFigure — principle 1: the whole set as area sized by count. A squarified
// treemap in inline SVG whose viewBox is the measured width, so a label is
// 13 px at every width. With `group` on the cells it splits twice: the groups
// first, each with a header naming it, then the cells inside. A rectangle too
// small for its label shows only its count, and one too small for that shows
// nothing. Selecting a cell outlines it in accent and tints its group.

import type { KeyboardEvent } from "react";
import QueryCaption from "./query-caption";
import { squarify, type Box } from "./treemap";
import { textWidth, useWidth } from "./use-width";

type AreaCell = { key: string; label: string; count: number; group?: string };

/** Space inside a rectangle before its text, and between two groups. */
const PAD = 6;
const GAP = 3;
/** A 13 px line, and the header a group names itself in. */
const LINE = 18;
const HEADER = 22;

function heightFor(width: number): number {
  return Math.max(260, Math.min(440, Math.round(width * 0.55)));
}

/** What fits in a rectangle: the label and the count, the count, or nothing. */
function fit(label: string, count: string, w: number, h: number): "both" | "count" | "none" {
  const room = w - 2 * PAD;
  if (h >= 2 * LINE + PAD && room >= Math.max(textWidth(label), textWidth(count, true))) return "both";
  if (h >= LINE + PAD && room >= textWidth(count, true)) return "count";
  return "none";
}

type Placed = AreaCell & Box;

function layout(cells: readonly AreaCell[], width: number, height: number) {
  const box = { x: 0, y: 0, w: width, h: height };
  if (!cells.some((c) => c.group !== undefined)) {
    return { groups: [] as (Box & { name: string; count: number })[], placed: squarify(cells, box) };
  }
  const totals = new Map<string, number>();
  for (const c of cells) totals.set(c.group ?? "", (totals.get(c.group ?? "") ?? 0) + c.count);
  const groups = squarify(
    [...totals].map(([name, count]) => ({ name, count })),
    box,
  );
  const placed: Placed[] = [];
  for (const g of groups) {
    const header = g.h > 3 * HEADER && g.w > 60 ? HEADER : 0;
    const inner = { x: g.x + GAP, y: g.y + GAP + header, w: g.w - 2 * GAP, h: g.h - 2 * GAP - header };
    placed.push(...squarify(cells.filter((c) => (c.group ?? "") === g.name), inner));
  }
  return { groups, placed };
}

export default function AreaFigure({
  title,
  cells,
  selectedKey,
  onSelect,
  caption,
}: {
  title: string;
  cells: readonly AreaCell[];
  selectedKey?: string;
  onSelect?: (key: string) => void;
  caption: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = heightFor(width);
  const { groups, placed } = layout(cells, width, height);
  const selected = cells.find((c) => c.key === selectedKey);
  // The selected cell is drawn last so its accent outline is never under a
  // neighbour's border.
  const ordered = [...placed].sort((a, b) => Number(a.key === selectedKey) - Number(b.key === selectedKey));

  return (
    <section className="tb-block">
      <h2 className="tb-title">{title}</h2>
      <div ref={ref} className="tb-figure-box">
        <svg className="tb-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          {groups.map((g) => {
            const count = String(g.count);
            const room = g.w - 2 * PAD;
            const header = g.h > 3 * HEADER && g.w > 60;
            const both = header && textWidth(g.name) + 6 + textWidth(count, true) <= room;
            const countOnly = header && !both && textWidth(count, true) <= room;
            return (
              <g key={`group ${g.name}`} className="tb-group">
                <rect x={g.x} y={g.y} width={g.w} height={g.h} />
                {(both || countOnly) && (
                  <text x={g.x + PAD} y={g.y + 16}>
                    {both && <tspan className="tb-svg-group">{g.name}</tspan>}
                    <tspan className="tb-svg-num" dx={both ? 6 : 0}>{count}</tspan>
                  </text>
                )}
              </g>
            );
          })}
          {ordered.map((c) => {
            const count = String(c.count);
            const shown = fit(c.label, count, c.w, c.h);
            const cls = [
              "tb-cell",
              onSelect ? "is-clickable" : "",
              selected && c.group !== undefined && c.group === selected.group ? "is-group" : "",
              c.key === selectedKey ? "is-selected" : "",
            ].join(" ");
            const pick = onSelect ? () => onSelect(c.key) : undefined;
            return (
              <g
                key={c.key}
                className={cls}
                role={onSelect ? "button" : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-label={`${c.label} ${count}`}
                aria-pressed={onSelect ? c.key === selectedKey : undefined}
                onClick={pick}
                onKeyDown={
                  pick
                    ? (e: KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          pick();
                        }
                      }
                    : undefined
                }
              >
                <rect x={c.x} y={c.y} width={Math.max(0, c.w)} height={Math.max(0, c.h)} />
                {shown === "both" && (
                  <>
                    <text x={c.x + PAD} y={c.y + PAD + 13}>{c.label}</text>
                    <text className="tb-svg-num" x={c.x + PAD} y={c.y + PAD + 13 + LINE}>{count}</text>
                  </>
                )}
                {shown === "count" && (
                  <text className="tb-svg-num" x={c.x + PAD} y={c.y + PAD + 13}>{count}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <QueryCaption text={caption} />
    </section>
  );
}
