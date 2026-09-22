"use client";

// THE MAP, LIVE. Every component of Jarvis, drawn from app/observe/map-data.ts,
// each carrying the count the record holds for it in the selected window and
// how long ago it last did anything.
//
// The arrows are lines between box borders with an arrowhead POLYGON at each
// arrow end, computed from the line's own angle (app/observe/lib.ts arrowHead).
// No SVG marker element: a marker's orientation and colour are the renderer's
// business, and the head has to be the same colour as the line it ends whether
// the page is drawn light or dark.
//
// Colour comes from the theme tokens through Tailwind's fill- and stroke-
// utilities, so the diagram is the same object as the rest of the page.

import Link from "next/link";
import {
  EDGES,
  MAP_HEIGHT,
  MAP_WIDTH,
  NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeById,
  type Lane,
  type MapNode,
} from "../map-data";
import { ago, arrowHead, borderPoint, shortened, tallyFor, type WindowData } from "../lib";

const HALF_W = NODE_WIDTH / 2;
const HALF_H = NODE_HEIGHT / 2;
const HEAD = 9;

export default function Map({
  data,
  now,
  focus,
  onFocus,
  waiting,
}: {
  data: WindowData;
  now: number;
  /** The lane the timeline is filtered to, or "box", or null. */
  focus: Lane | "box" | null;
  onFocus: (next: Lane | "box" | null) => void;
  waiting: { waiting: number; oldestAt: number | null } | null;
}) {
  return (
    <svg
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      className="w-full"
      role="img"
      aria-label="Jarvis"
    >
      {EDGES.map((edge) => {
        const from = nodeById(edge.from);
        const to = nodeById(edge.to);
        const start = borderPoint(from, HALF_W, HALF_H, to);
        const end = borderPoint(to, HALF_W, HALF_H, from);
        const lineEnd = shortened(start, end, HEAD);
        const lineStart = edge.both ? shortened(end, start, HEAD) : start;
        return (
          <g key={`${edge.from}-${edge.to}`} className="stroke-border fill-border">
            <line
              x1={lineStart.x}
              y1={lineStart.y}
              x2={lineEnd.x}
              y2={lineEnd.y}
              strokeWidth={1.5}
            />
            <polygon points={arrowHead(start, end, HEAD)} strokeWidth={0} />
            {edge.both === true && (
              <polygon points={arrowHead(end, start, HEAD)} strokeWidth={0} />
            )}
          </g>
        );
      })}
      {NODES.map((node) => (
        <Box
          key={node.id}
          node={node}
          data={data}
          now={now}
          focus={focus}
          onFocus={onFocus}
          waiting={node.id === "slack" ? waiting : null}
        />
      ))}
    </svg>
  );
}

function Box({
  node,
  data,
  now,
  focus,
  onFocus,
  waiting,
}: {
  node: MapNode;
  data: WindowData;
  now: number;
  focus: Lane | "box" | null;
  onFocus: (next: Lane | "box" | null) => void;
  waiting: { waiting: number; oldestAt: number | null } | null;
}) {
  const { count, lastAt } = tallyFor(node.tally, data, now);
  const target: Lane | "box" | null =
    node.tally.of === "lane" ? node.tally.lane : node.tally.of === "host" ? "box" : null;
  const selected = target !== null && focus === target;
  const x = node.x - NODE_WIDTH / 2;
  const y = node.y - NODE_HEIGHT / 2;

  const body = (
    <>
      <rect
        x={x}
        y={y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={10}
        className={
          selected
            ? "fill-accent-dim stroke-accent"
            : "fill-surface stroke-border group-hover:fill-surface-alt group-hover:stroke-text-faint"
        }
        strokeWidth={1.5}
      />
      <text
        x={node.x}
        y={y + 22}
        textAnchor="middle"
        className={selected ? "fill-accent text-[13px]" : "fill-text text-[13px]"}
      >
        {node.label}
      </text>
      <text x={node.x} y={y + 43} textAnchor="middle" className="fill-text-muted text-[15px] font-mono">
        {count}
      </text>
      <text x={node.x} y={y + 56} textAnchor="middle" className="fill-text-faint text-[10px] font-mono">
        {ago(lastAt, now)}
      </text>
      {waiting !== null && waiting.waiting > 0 && (
        <>
          <rect
            x={node.x + NODE_WIDTH / 2 - 76}
            y={y - 17}
            width={76}
            height={17}
            rx={5}
            className="fill-accent-dim stroke-accent"
            strokeWidth={1}
          />
          <text
            x={node.x + NODE_WIDTH / 2 - 38}
            y={y - 4.5}
            textAnchor="middle"
            className="fill-accent text-[10px] font-mono"
          >
            {`#tts-needs-you ${waiting.waiting}`}
          </text>
        </>
      )}
    </>
  );

  if (node.href !== undefined) {
    return node.external === true ? (
      <a
        href={node.href}
        target="_blank"
        rel="noreferrer"
        className="group cursor-pointer"
      >
        {body}
      </a>
    ) : (
      <Link href={node.href} className="group cursor-pointer">
        {body}
      </Link>
    );
  }

  if (target === null) {
    // The record stands for the whole window, so pressing it is how the
    // timeline goes back to holding everything.
    return (
      <g
        className="group cursor-pointer"
        onClick={() => onFocus(null)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onFocus(null);
        }}
      >
        {body}
      </g>
    );
  }

  return (
    <g
      className="group cursor-pointer"
      onClick={() => onFocus(selected ? null : target)}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onFocus(selected ? null : target);
      }}
    >
      {body}
    </g>
  );
}
