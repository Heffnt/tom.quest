"use client";

// The drawn graph: every task (and every goal wired into the dependency
// structure) as a node, every `needs` edge as a line, laid out left→right by
// dependency depth — work flows toward the right. Fill encodes state (green
// done, amber-ringed ready, dim blocked); an amber dot marks Tom's tasks.
// Click a node for its detail. Scrolls sideways inside its own container.
import type { GraphGoal, GraphTask } from "./batch-card";

const COL_W = 148;
const ROW_H = 30;
const NODE_W = 132;
const NODE_H = 22;

type Node = {
  id: string;
  label: string;
  state: "done" | "ready" | "blocked";
  tom: boolean;
  goal: boolean;
  needs: string[];
};

function buildNodes(tasks: GraphTask[], goals: GraphGoal[]): Node[] {
  const doneIds = new Set(
    tasks.filter((t) => t.status === "done").map((t) => t.id),
  );
  const nodes: Node[] = tasks.map((t) => ({
    id: t.id,
    label: t.statement,
    state:
      t.status === "done"
        ? "done"
        : t.needs.every((n) => doneIds.has(n))
          ? "ready"
          : "blocked",
    tom: t.actor === "tom",
    goal: false,
    needs: t.needs,
  }));
  // Goals join the drawing only when they are wired into the structure —
  // unwired goals live in the goals list below the graph.
  const taskIds = new Set(tasks.map((t) => t.id));
  const needed = new Set(tasks.flatMap((t) => t.needs));
  for (const g of goals) {
    if (needed.has(g.id)) {
      nodes.push({
        id: g.id,
        label: g.statement,
        state: g.met ? "done" : "blocked",
        tom: false,
        goal: true,
        needs: [],
      });
    }
  }
  return nodes.filter((n) => taskIds.has(n.id) || needed.has(n.id));
}

function depths(nodes: Node[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return 0; // defensive: a cycle flattens, never hangs
    visiting.add(id);
    const n = byId.get(id);
    const inGraph = (n?.needs ?? []).filter((x) => byId.has(x));
    const d =
      inGraph.length === 0 ? 0 : 1 + Math.max(...inGraph.map((x) => depth(x)));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);
  return memo;
}

export default function GraphView({
  tasks,
  goals,
  onPick,
}: {
  tasks: GraphTask[];
  goals: GraphGoal[];
  onPick: (id: string) => void;
}) {
  const nodes = buildNodes(tasks, goals);
  if (nodes.length < 2) return null;
  const d = depths(nodes);
  const cols = new Map<number, Node[]>();
  for (const n of nodes) {
    const c = d.get(n.id) ?? 0;
    cols.set(c, [...(cols.get(c) ?? []), n]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [c, list] of cols) {
    maxRows = Math.max(maxRows, list.length);
    list.forEach((n, i) => pos.set(n.id, { x: 10 + c * COL_W, y: 8 + i * ROW_H }));
  }
  const width = 20 + cols.size * COL_W;
  const height = 16 + maxRows * ROW_H;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const fill = (n: Node) =>
    n.state === "done"
      ? "rgba(34,197,94,0.14)"
      : n.state === "ready"
        ? "rgba(232,160,64,0.14)"
        : "rgba(26,35,50,0.9)";
  const stroke = (n: Node) =>
    n.state === "done" ? "#22c55e" : n.state === "ready" ? "#e8a040" : "#2c3a52";

  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-border/60 bg-bg/40">
      <svg width={width} height={height} className="block">
        {nodes.flatMap((n) =>
          n.needs
            .filter((x) => byId.has(x))
            .map((x) => {
              const a = pos.get(x)!;
              const b = pos.get(n.id)!;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={`${x}-${n.id}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#3b4a66"
                  strokeWidth="1.2"
                />
              );
            }),
        )}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g
              key={n.id}
              onClick={() => onPick(n.id)}
              className="cursor-pointer opacity-90 hover:opacity-100"
            >
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={n.goal ? 11 : 5}
                fill={fill(n)}
                stroke={stroke(n)}
                strokeWidth="1"
              />
              {n.tom && (
                <circle cx={p.x + 9} cy={p.y + NODE_H / 2} r="3" fill="#e8a040" />
              )}
              <text
                x={p.x + (n.tom ? 17 : 8)}
                y={p.y + NODE_H / 2 + 3.5}
                fontSize="10"
                fill={n.state === "blocked" ? "#64748b" : "#e2e8f0"}
              >
                {n.label.length > (n.tom ? 19 : 21)
                  ? n.label.slice(0, n.tom ? 18 : 20) + "…"
                  : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
