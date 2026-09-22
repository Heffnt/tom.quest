"use client";

// THE MAP, LIVE. Every component of Jarvis, drawn from app/observe/map-data.ts,
// each carrying the count the record holds for it in the selected window, the
// word for what that count counts, and how long ago it last did anything.
//
// SHAPE CARRIES KIND. Tom is a pill, a surface he touches is rounded, a store
// has hard corners, a machine is chamfered, a run is dashed because it is
// transient, and something outside his system is dotted and faint. That is the
// difference between a map and a grid of identical boxes, and every colour in
// it is a theme token.
//
// EVERY BOX SAYS WHAT PRESSING IT DOES, in the hover title and to a screen
// reader, and does that one thing: it holds the timeline to a lane, or it opens
// a page of this site. Nothing here leaves tom.quest.
//
// The arrows are lines between shape borders with an arrowhead POLYGON at each
// arrow end, computed from the line's own angle (app/observe/lib.ts arrowHead).
// No SVG marker element: a marker's orientation and colour are the renderer's
// business, and the head has to be the colour of the line it ends.

import Link from "next/link";
import {
  EDGES,
  MAP_HEIGHT,
  MAP_WIDTH,
  NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeAction,
  type Lane,
  type MapNode,
  type NodeId,
  type Shape,
} from "../map-data";
import { ago, arrowHead, borderPoint, shortened, tallyFor, type WindowData } from "../lib";

const HALF_W = NODE_WIDTH / 2;
const HALF_H = NODE_HEIGHT / 2;
const HEAD = 9;
/** How far the chamfer cuts into a machine's left and right edges. */
const CHAMFER = 12;

const BY_ID = new Map(NODES.map((node) => [node.id, node]));

/** A node by name. Every caller names one of the map's own node ids, which the
 *  NodeId type makes the compiler check, so there is no missing-node case to
 *  answer for here. */
function at(id: NodeId): MapNode {
  return BY_ID.get(id) as MapNode;
}

/** The stroke, the fill and the dashes each kind of thing is drawn with. */
function skin(shape: Shape, selected: boolean): { className: string; dash?: string } {
  if (selected) return { className: "fill-accent-dim stroke-accent" };
  switch (shape) {
    case "person":
      return { className: "fill-accent-dim stroke-accent" };
    case "surface":
      return { className: "fill-surface stroke-text-muted group-hover:fill-surface-alt" };
    case "store":
      return { className: "fill-surface-alt stroke-accent group-hover:fill-surface" };
    case "machine":
      return { className: "fill-surface stroke-text group-hover:fill-surface-alt" };
    case "work":
      return { className: "fill-surface stroke-text-muted group-hover:fill-surface-alt", dash: "5 3" };
    case "outside":
      return { className: "fill-bg stroke-text-faint group-hover:fill-surface", dash: "1 3" };
  }
}

export default function SystemMap({
  data,
  now,
  focus,
  onFocus,
  waiting,
}: {
  data: WindowData;
  now: number;
  /** The lane the timeline is held to, or null. */
  focus: Lane | null;
  onFocus: (next: Lane | null) => void;
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
        const from = at(edge.from);
        const to = at(edge.to);
        const start = borderPoint(from, HALF_W, HALF_H, to);
        const end = borderPoint(to, HALF_W, HALF_H, from);
        const lineEnd = shortened(start, end, HEAD);
        const lineStart = edge.both === true ? shortened(end, start, HEAD) : start;
        return (
          <g key={`${edge.from}-${edge.to}`} className="stroke-border fill-border">
            <line x1={lineStart.x} y1={lineStart.y} x2={lineEnd.x} y2={lineEnd.y} strokeWidth={1.5} />
            <polygon points={arrowHead(start, end, HEAD)} strokeWidth={0} />
            {edge.both === true && <polygon points={arrowHead(end, start, HEAD)} strokeWidth={0} />}
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

function Outline({ node, selected }: { node: MapNode; selected: boolean }) {
  const x = node.x - HALF_W;
  const y = node.y - HALF_H;
  const { className, dash } = skin(node.shape, selected);
  const common = {
    className,
    strokeWidth: 1.5,
    ...(dash === undefined ? {} : { strokeDasharray: dash }),
  };
  if (node.shape === "machine" || node.shape === "store") {
    // A machine's left and right edges are cut; a store's corners are square.
    const points =
      node.shape === "machine"
        ? [
            [x + CHAMFER, y],
            [x + NODE_WIDTH - CHAMFER, y],
            [x + NODE_WIDTH, y + HALF_H],
            [x + NODE_WIDTH - CHAMFER, y + NODE_HEIGHT],
            [x + CHAMFER, y + NODE_HEIGHT],
            [x, y + HALF_H],
          ]
        : [
            [x, y],
            [x + NODE_WIDTH, y],
            [x + NODE_WIDTH, y + NODE_HEIGHT],
            [x, y + NODE_HEIGHT],
          ];
    return <polygon points={points.map(([px, py]) => `${px},${py}`).join(" ")} {...common} />;
  }
  return (
    <rect
      x={x}
      y={y}
      width={NODE_WIDTH}
      height={NODE_HEIGHT}
      rx={node.shape === "person" ? HALF_H : 12}
      {...common}
    />
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
  focus: Lane | null;
  onFocus: (next: Lane | null) => void;
  waiting: { waiting: number; oldestAt: number | null } | null;
}) {
  const { count, lastAt } = tallyFor(node.tally, data, now);
  const selected = node.filters !== undefined && focus === node.filters;
  const y = node.y - HALF_H;
  const action = nodeAction(node);

  const body = (
    <>
      <title>{`${node.label} — ${action}`}</title>
      <Outline node={node} selected={selected} />
      <text
        x={node.x}
        y={y + 20}
        textAnchor="middle"
        className={selected ? "fill-accent text-[13px]" : "fill-text text-[13px]"}
      >
        {node.label}
      </text>
      <text x={node.x} y={y + 40} textAnchor="middle" className="fill-text-muted text-[13px] font-mono">
        {`${count} ${node.unit}`}
      </text>
      <text x={node.x} y={y + 55} textAnchor="middle" className="fill-text-faint text-[10px] font-mono">
        {lastAt === null ? "—" : `${ago(lastAt, now)} ago`}
      </text>
      {waiting !== null && waiting.waiting > 0 && (
        <>
          <rect
            x={node.x + HALF_W - 80}
            y={y - 18}
            width={80}
            height={17}
            rx={5}
            className="fill-accent-dim stroke-accent"
            strokeWidth={1}
          />
          <text
            x={node.x + HALF_W - 40}
            y={y - 5.5}
            textAnchor="middle"
            className="fill-accent text-[10px] font-mono"
          >
            {`#tts-needs-you ${waiting.waiting}`}
          </text>
        </>
      )}
    </>
  );

  if (node.opens !== undefined) {
    return (
      <Link href={node.opens} className="group cursor-pointer" aria-label={`${node.label}: ${action}`}>
        {body}
      </Link>
    );
  }

  const press = () => {
    if (node.filters !== undefined) onFocus(selected ? null : node.filters);
    else onFocus(null);
  };

  return (
    <g
      className="group cursor-pointer"
      onClick={press}
      role="button"
      aria-label={`${node.label}: ${action}`}
      aria-pressed={node.filters === undefined ? undefined : selected}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") press();
      }}
    >
      {body}
    </g>
  );
}
