"use client";

// app/boolback/components/dag-pane.tsx
//
// Hand-rolled layered SVG DAG scoped to selectedDir's subtree. No d3/dagre/
// react-flow — every coordinate is computed by the pure `layoutDag` below.
//
// Layout model:
//   * Columns = level depth from the scope root (function..scoring), one x per
//     depth. The epoch group becomes a SINGLE synthetic cell rendering an inline
//     plantedness/ASR polyline across epochs 0..3 (graft D2).
//   * y = child-centering: a node sits at the midpoint of its children's span;
//     leaves stack on a running cursor per column.
//   * Chain edges = orthogonal elbow <path M..H..V..H>.
//   * Cross-edges = dashed colored quadratic Béziers per CrossEdgeKind, with a
//     legend in the floating control panel.
//
// Pan/zoom mutate the store ONLY (dagPan/dagZoom) and are applied via a single
// <g transform>; layout never recomputes on transform, so dragging is cheap.

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  TreeNode, CrossEdgeKind, NodeKind,
} from "../lib/types";
import type { FixtureBundle } from "../data/fixture";
import { useBoolbackStore } from "../state/store";

interface DagPaneProps {
  fixture: FixtureBundle;
}

// ---------------------------------------------------------------------------
// Layout geometry (pure; all integers for crisp strokes)
// ---------------------------------------------------------------------------

const COL_W = 168;        // horizontal stride between columns
const NODE_W = 132;       // node box width
const NODE_H = 34;        // node box height
const ROW_GAP = 14;       // vertical gap between sibling boxes
const PAD = 32;           // outer padding of the layout
const EPOCH_W = 150;      // wider cell for the epoch polyline
const EPOCH_H = 56;
const MAX_DAG_NODES = 200;

// One laid-out node (a TreeNode positioned, plus the synthetic epoch cell).
// `path` is the globally-unique identity (selection / byDir / edges key off it);
// display still derives from the underlying node's dirName/slug.
interface LaidNode {
  path: string;
  label: string;          // short slug shown in the box
  level: NodeKind | "group" | "epoch";
  x: number;              // top-left
  y: number;
  w: number;
  h: number;
  cx: number;             // center
  cy: number;
  done: boolean;
  claimed: boolean;
  isEpoch: boolean;       // synthetic epoch cell
  inChain: boolean;
}

interface ChainEdge {
  fromDir: string;
  toDir: string;
}

interface LaidCrossEdge {
  kind: CrossEdgeKind;
  fromDir: string;
  toDir: string;
  label?: string;
}

interface DagLayout {
  nodes: LaidNode[];
  byDir: Map<string, LaidNode>;
  chainEdges: ChainEdge[];
  crossEdges: LaidCrossEdge[];
  width: number;
  height: number;
  truncated: number;      // nodes dropped by the cap
}

const CROSS_KINDS: Array<{ kind: CrossEdgeKind; label: string; cls: string; stroke: string }> = [
  { kind: "function_false_twin", label: "twin", cls: "text-accent", stroke: "var(--color-accent)" },
  { kind: "trigger_naive_twin", label: "trigger-naive", cls: "text-accent", stroke: "var(--color-accent)" },
  { kind: "defended_pair", label: "defended", cls: "text-warning", stroke: "var(--color-warning)" },
  { kind: "sanitize_pair", label: "sanitize", cls: "text-warning", stroke: "var(--color-warning)" },
  { kind: "epoch0_trajectory", label: "epoch-0", cls: "text-success", stroke: "var(--color-success)" },
];

const CROSS_STROKE: Record<CrossEdgeKind, string> = {
  function_false_twin: "var(--color-accent)",
  trigger_naive_twin: "var(--color-accent)",
  defended_pair: "var(--color-warning)",
  // warning-dim: reuse warning at reduced opacity via stroke-opacity on the path
  sanitize_pair: "var(--color-warning)",
  epoch0_trajectory: "var(--color-success)",
};

// Which kinds are dimmed (sanitize = warning-dim per spec).
const CROSS_DIM: Partial<Record<CrossEdgeKind, boolean>> = { sanitize_pair: true };

// ---------------------------------------------------------------------------
// Scope selection: the subtree rooted at the selected node (or its function).
// ---------------------------------------------------------------------------

/** Walk up from `path` to the nearest "showable" scope root (function level). */
function scopeRootFor(
  dir: string | null, nodeIndex: Map<string, TreeNode>,
  parentOf: (d: string) => string | null,
): TreeNode | null {
  if (!dir) {
    // default: first function node under root
    return firstFunction(nodeIndex);
  }
  let cur: string | null = dir;
  let node = nodeIndex.get(dir) ?? null;
  // climb to the enclosing function node so the chain + its fans are visible
  while (cur) {
    const n = nodeIndex.get(cur);
    if (n && n.level === "function") return n;
    cur = parentOf(cur);
    if (cur) node = nodeIndex.get(cur) ?? node;
  }
  return node ?? firstFunction(nodeIndex);
}

function firstFunction(nodeIndex: Map<string, TreeNode>): TreeNode | null {
  for (const n of nodeIndex.values()) {
    if (n.level === "function") return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pure layout. Memoized in the component off [scopeId, lanesKey].
// ---------------------------------------------------------------------------

interface Lanes {
  showPpl: boolean;
  showDefenses: boolean;
  showInterp: boolean;
  showScans: boolean;
  collapseCensus: boolean;
}

function layoutDag(scope: TreeNode, lanes: Lanes): DagLayout {
  const nodes: LaidNode[] = [];
  const chainEdges: ChainEdge[] = [];
  const colCursorY = new Map<number, number>();
  let truncated = 0;
  let budget = MAX_DAG_NODES;

  // Decide whether a node should be shown given the lane toggles.
  const laneVisible = (n: TreeNode): boolean => {
    const lvl = n.level;
    if (lvl === "ppl" && !lanes.showPpl) return false;
    if (lvl && lvl.startsWith("defense_") && !lanes.showDefenses) return false;
    if (lvl === "interp" && !lanes.showInterp) return false;
    if (lvl && lvl.startsWith("scan_") && !lanes.showScans) return false;
    return true;
  };

  // A group dir we never render as its own box (its semantic content is its
  // children). We still recurse through it. The epoch-N group is special: it
  // collapses into a single synthetic epoch cell rendered with the polyline.
  const isPlainGroup = (n: TreeNode): boolean =>
    n.kind === "group" && n.groupKind !== "epoch";

  // The function node's per-trajectory epoch cell key (one per training node).
  const epochCellByTraining = new Map<string, LaidNode>();

  // Recursive placement. Returns the vertical center of the placed node (or the
  // mean center of placed descendants for transparent group dirs), or null when
  // nothing was placed in this subtree.
  function place(node: TreeNode, depth: number): number | null {
    if (budget <= 0) { truncated++; return null; }

    if (isPlainGroup(node)) {
      // transparent: place children at the SAME depth (groups carry no column)
      const centers: number[] = [];
      for (const child of node.children) {
        if (!laneVisible(child)) continue;
        const c = place(child, depth);
        if (c !== null) centers.push(c);
      }
      return centers.length ? mean(centers) : null;
    }

    // epoch-N group -> a single synthetic epoch cell PER training node.
    if (node.kind === "group" && node.groupKind === "epoch") {
      // recurse into the epoch's children (inference/scoring/ppl/defenses/interp)
      // at depth+1 so the chain continues; AND register the epoch cell at `depth`.
      // The per-training key is the TRAINING NODE PATH = this epoch group's path
      // minus its trailing "/epoch-N" segment (so all epoch-N groups of ONE
      // training collapse into a single cell, but distinct trainings — even ones
      // sharing the bare "epoch-N" dirName — stay separate).
      const slash = node.path.lastIndexOf("/");
      const trainingKey = slash >= 0 ? node.path.slice(0, slash) : node.path;
      let cell = epochCellByTraining.get(trainingKey);
      if (!cell) {
        if (budget <= 0) { truncated++; return null; }
        budget--;
        const x = PAD + depth * COL_W;
        const y = nextY(colCursorY, depth, EPOCH_H);
        cell = {
          path: node.path,
          label: "epochs 0-3",
          level: "epoch",
          x, y, w: EPOCH_W, h: EPOCH_H,
          cx: x + Math.round(EPOCH_W / 2),
          cy: y + Math.round(EPOCH_H / 2),
          done: node.done, claimed: !!node.claimed,
          isEpoch: true, inChain: false,
        };
        epochCellByTraining.set(trainingKey, cell);
        nodes.push(cell);
      }
      // place the epoch's chain children one column to the right
      for (const child of node.children) {
        if (!laneVisible(child)) continue;
        if (isPlainGroup(child)) { place(child, depth + 1); continue; }
        place(child, depth + 1);
      }
      return cell.cy;
    }

    if (!laneVisible(node)) return null;
    if (budget <= 0) { truncated++; return null; }

    // place children first (right of this column) to center on them.
    const childCenters: number[] = [];
    for (const child of node.children) {
      if (!laneVisible(child)) continue;
      const c = place(child, depth + 1);
      if (c !== null) childCenters.push(c);
    }

    budget--;
    const x = PAD + depth * COL_W;
    let cy: number;
    if (childCenters.length) {
      cy = Math.round(mean(childCenters));
      // make sure we don't overlap previously placed nodes in this column
      const floor = colCursorY.get(depth) ?? PAD;
      if (cy - Math.round(NODE_H / 2) < floor) {
        cy = floor + Math.round(NODE_H / 2);
      }
      colCursorY.set(depth, cy + Math.round(NODE_H / 2) + ROW_GAP);
    } else {
      const y = nextY(colCursorY, depth, NODE_H);
      cy = y + Math.round(NODE_H / 2);
    }
    const y = cy - Math.round(NODE_H / 2);
    const laid: LaidNode = {
      path: node.path,
      label: shortLabel(node),
      level: node.level ?? "group",
      x, y, w: NODE_W, h: NODE_H,
      cx: x + Math.round(NODE_W / 2), cy,
      done: node.done, claimed: !!node.claimed,
      isEpoch: false, inChain: node.inChain,
    };
    nodes.push(laid);

    // chain edges to placed in-chain / side children
    for (const child of node.children) {
      if (!laneVisible(child)) continue;
      if (isPlainGroup(child)) {
        // edge skips the transparent group to its (placed) grandchildren
        for (const gc of child.children) {
          if (!laneVisible(gc)) continue;
          chainEdges.push({ fromDir: node.path, toDir: edgeTargetDir(gc) });
        }
      } else {
        chainEdges.push({ fromDir: node.path, toDir: edgeTargetDir(child) });
      }
    }
    return cy;
  }

  place(scope, 0);

  const byDir = new Map<string, LaidNode>();
  for (const n of nodes) byDir.set(n.path, n);

  // keep only edges whose endpoints both got placed (cap/lane drops)
  const liveEdges = chainEdges.filter((e) => byDir.has(e.fromDir) && byDir.has(e.toDir));

  const crossEdges = deriveCrossEdges(scope, byDir);

  let width = PAD, height = PAD;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.w + PAD);
    height = Math.max(height, n.y + n.h + PAD);
  }

  return {
    nodes, byDir, chainEdges: liveEdges, crossEdges,
    width: Math.round(width), height: Math.round(height), truncated,
  };
}

// The path an edge should point at: epoch groups collapse to the epoch cell key,
// so an edge into an epoch-N group lands on the synthetic cell (its path).
function edgeTargetDir(child: TreeNode): string {
  return child.path;
}

function nextY(cursor: Map<number, number>, depth: number, h: number): number {
  const y = cursor.get(depth) ?? PAD;
  cursor.set(depth, y + h + ROW_GAP);
  return y;
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function shortLabel(node: TreeNode): string {
  if (node.kind === "group") return node.dirName;
  const slug = node.slug ?? "";
  const lvl = node.level ?? "";
  // "function+01101001+<hash>" -> "function · 01101001"
  return slug ? `${lvl} ${slug}` : lvl;
}

// ---------------------------------------------------------------------------
// Cross-edge derivation from the placed set (the fixture does not pre-populate
// node.crossEdges; we infer them from referenceHash + structural twins that are
// BOTH visible in the current scope).
// ---------------------------------------------------------------------------

function deriveCrossEdges(
  scope: TreeNode, byDir: Map<string, LaidNode>,
): LaidCrossEdge[] {
  const edges: LaidCrossEdge[] = [];
  const placed = byDir;

  // collect all nodes in the scope subtree (regardless of placement) so we can
  // resolve partners by hash, then keep only edges whose BOTH ends are placed.
  const all: TreeNode[] = [];
  (function collect(n: TreeNode) {
    all.push(n);
    for (const c of n.children) collect(c);
  })(scope);

  const byHash = new Map<string, TreeNode>();
  for (const n of all) if (n.hash) byHash.set(n.hash, n);

  for (const n of all) {
    // interp / measurement nodes that carry referenceHash -> twin cross-edge.
    if (n.referenceHash) {
      const partner = byHash.get(n.referenceHash);
      if (partner && placed.has(n.path) && placed.has(partner.path)) {
        edges.push({
          kind: "function_false_twin",
          fromDir: n.path, toDir: partner.path,
          label: "twin Δ",
        });
      }
    }
    // defended pair: a standalone/runtime defense node nests its own inference/
    // scoring whose config matches the undefended sibling. Draw an edge from the
    // defense node to the nearest placed plain epoch cell sibling.
    if (n.level && n.level.startsWith("defense_") && placed.has(n.path)) {
      const epochCell = findEpochCellAncestor(n, scope, placed);
      if (epochCell) {
        edges.push({
          kind: n.contract === "sanitizer" ? "sanitize_pair" : "defended_pair",
          fromDir: epochCell, toDir: n.path,
          label: n.contract === "sanitizer" ? "asr_drop" : "*_drop",
        });
      }
    }
  }

  // epoch-0 trajectory twin: a "-none" base-eval training node's epoch cell
  // joins to the trained training node's epoch cell under the same dataset.
  linkEpochZero(scope, placed, edges);

  return dedupeEdges(edges);
}

// Find the path of the placed epoch cell that is an ancestor of `n`.
function findEpochCellAncestor(
  n: TreeNode, scope: TreeNode, placed: Map<string, LaidNode>,
): string | null {
  // build a parent map within scope (keyed by node.path)
  const parent = new Map<string, TreeNode>();
  (function walk(node: TreeNode) {
    for (const c of node.children) { parent.set(c.path, node); walk(c); }
  })(scope);
  let cur: TreeNode | undefined = parent.get(n.path);
  while (cur) {
    if (cur.kind === "group" && cur.groupKind === "epoch" && placed.has(cur.path)) {
      return cur.path;
    }
    cur = parent.get(cur.path);
  }
  return null;
}

// Connect the -none base-eval epoch cell to the trained run's epoch cell.
function linkEpochZero(
  scope: TreeNode, placed: Map<string, LaidNode>, edges: LaidCrossEdge[],
): void {
  // dataset -> its training children; pair the base-eval (backend:none) epoch
  // with a real training epoch cell.
  (function walk(node: TreeNode) {
    if (node.level === "dataset") {
      const trainings = node.children.filter((c) => c.level === "training");
      const base = trainings.find(
        (t) => (t.config?.backend as string | undefined) === "none",
      );
      const trained = trainings.find(
        (t) => (t.config?.backend as string | undefined) && t.config?.backend !== "none",
      );
      if (base && trained) {
        const baseCell = firstEpochCell(base);
        const trainedCell = firstEpochCell(trained);
        if (baseCell && trainedCell && placed.has(baseCell) && placed.has(trainedCell)) {
          edges.push({
            kind: "epoch0_trajectory",
            fromDir: baseCell, toDir: trainedCell,
            label: "epoch-0 base",
          });
        }
      }
    }
    for (const c of node.children) walk(c);
  })(scope);
}

function firstEpochCell(training: TreeNode): string | null {
  for (const c of training.children) {
    if (c.kind === "group" && c.groupKind === "epoch") return c.path;
  }
  return null;
}

function dedupeEdges(edges: LaidCrossEdge[]): LaidCrossEdge[] {
  const seen = new Set<string>();
  const out: LaidCrossEdge[] = [];
  for (const e of edges) {
    const k = `${e.kind}|${e.fromDir}|${e.toDir}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Epoch polyline: per-epoch ASR (rising) + plantedness threshold, sourced from
// the frozen tidy rows (metricName "asr") for the training trajectory the cell
// belongs to. Returns 4 y-fractions (epoch 0..3) plus the planted-crossing idx.
// ---------------------------------------------------------------------------

interface EpochSeries {
  asr: number[];                 // length up to 4, in [0,1]
  plantedCrossIdx: number | null;
}

function epochSeriesFor(
  cell: LaidNode, fixture: FixtureBundle,
  asrByTrainingKey: Map<string, Map<number, number>>,
  trainingKeyOf: (nodePath: string) => string | null,
): EpochSeries {
  // The training KEY (the training node's path) for this epoch cell, resolved in
  // O(1) via the precomputed resolver (climbs to the training ancestor). The
  // per-epoch ASR values come from the precomputed asrByTrainingKey map — keyed
  // by training PATH (not bare trainingHash, which is shared across functions in
  // real data) — so the polyline shows THIS chain's ASR only. No per-cell scan.
  const trainingKey = trainingKeyOf(cell.path);
  // The real loader keys the asr map by the full training-node PATH; the
  // synthetic fixture keys it by the bare 12-hex training hash. Try the path
  // first, then fall back to the bare hash (the last '+'-segment of the training
  // path). Each source populates only one of these keys, so there is no
  // cross-source collision and Demo + Real both resolve their own ASR series.
  let byEpoch = trainingKey ? asrByTrainingKey.get(trainingKey) : undefined;
  if (!byEpoch && trainingKey) {
    const bareHash = trainingKey.slice(trainingKey.lastIndexOf("+") + 1);
    if (bareHash && bareHash !== trainingKey) byEpoch = asrByTrainingKey.get(bareHash);
  }
  const asr: number[] = [];
  for (let e = 0; e < 4; e++) {
    if (byEpoch?.has(e)) asr.push(byEpoch.get(e)!);
  }
  // planting-crossing: the experiment whose chain includes this training path
  // (chainDirs holds ancestor path keys, so the training path is one of them).
  let plantedCrossIdx: number | null = null;
  if (trainingKey) {
    const exp = fixture.experiments.find((r) => r.chainDirs.includes(trainingKey));
    if (exp && exp.plantedEpoch !== null && exp.plantedEpoch >= 0 && exp.plantedEpoch < asr.length) {
      plantedCrossIdx = exp.plantedEpoch;
    }
  }
  return { asr, plantedCrossIdx };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DagPane({ fixture }: DagPaneProps) {
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const collapseCensus = useBoolbackStore((s) => s.collapseCensus);
  const dagPan = useBoolbackStore((s) => s.dagPan);
  const dagZoom = useBoolbackStore((s) => s.dagZoom);
  const select = useBoolbackStore((s) => s.select);
  const hover = useBoolbackStore((s) => s.hover);
  const setDagPan = useBoolbackStore((s) => s.setDagPan);
  const setDagZoom = useBoolbackStore((s) => s.setDagZoom);

  // lane toggles are local UI (not in the frozen store)
  const [lanes, setLanes] = useState<Lanes>({
    showPpl: true, showDefenses: true, showInterp: true, showScans: false,
    collapseCensus,
  });

  const { nodeIndex } = fixture;

  // parent lookup built once off nodeIndex identity (keyed by node.path)
  const parentOf = useMemo(() => {
    const parent = new Map<string, string>();
    for (const n of nodeIndex.values()) {
      for (const c of n.children) parent.set(c.path, n.path);
    }
    return (d: string) => parent.get(d) ?? null;
  }, [nodeIndex]);

  const scope = useMemo(
    () => scopeRootFor(selectedDir, nodeIndex, parentOf),
    [selectedDir, nodeIndex, parentOf],
  );

  // perf-3: precompute ASR-by-training-KEY and a path->training-key resolver
  // ONCE off fixture identity, so each EpochCell does O(1) lookups instead of
  // re-scanning all of fixture.tidy / fixture.nodeIndex per cell.
  //
  // The REAL loader keys the asr tidy rows by the TRAINING NODE PATH (a
  // path-scoped key), NOT a bare trainingHash — the real trainingHash is shared
  // across many functions, so a bare-hash map would pull ASR from sibling
  // functions' chains. The SYNTHETIC fixture keys them by the bare training hash
  // (its dirNames are globally unique, so no collision). epochSeriesFor resolves
  // both: it tries the training PATH, then falls back to the bare hash.
  const asrByTrainingKey = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    for (const tr of fixture.tidy) {
      if (tr.metricName !== "asr") continue;
      if (typeof tr.trainingHash !== "string") continue;
      if (typeof tr.epoch !== "number") continue;
      if (typeof tr.value !== "number") continue;
      let inner = m.get(tr.trainingHash);
      if (!inner) { inner = new Map<number, number>(); m.set(tr.trainingHash, inner); }
      inner.set(tr.epoch, tr.value);
    }
    return m;
  }, [fixture]);

  // path -> training-ancestor PATH, by climbing parentOf to the training node.
  // The training node's path is the path-scoped key the asr map is keyed by.
  // Resolved eagerly into a Map for every indexed path so lookups are O(1).
  const trainingKeyOf = useMemo(() => {
    const resolved = new Map<string, string | null>();
    const climb = (nodePath: string): string | null => {
      let cur: string | null = nodePath;
      while (cur) {
        const n = nodeIndex.get(cur);
        if (n && n.level === "training") return n.path ?? null;
        cur = parentOf(cur);
      }
      return null;
    };
    for (const nodePath of nodeIndex.keys()) {
      resolved.set(nodePath, climb(nodePath));
    }
    return (nodePath: string): string | null => resolved.get(nodePath) ?? null;
  }, [nodeIndex, parentOf]);

  const lanesKey = `${lanes.showPpl}|${lanes.showDefenses}|${lanes.showInterp}|${lanes.showScans}|${collapseCensus}`;

  // THE pure, memoized layout. Keyed on [scopeId, lanesKey] — pan/zoom never
  // appear here, so transforming the <g> never triggers relayout.
  const layout = useMemo<DagLayout | null>(() => {
    if (!scope) return null;
    return layoutDag(scope, { ...lanes, collapseCensus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.path, lanesKey]);

  // pan drag state (refs — no re-render while dragging)
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // only start a pan on the background (not a node) — nodes stopPropagation
    dragRef.current = { x: e.clientX, y: e.clientY, px: dagPan.x, py: dagPan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [dagPan.x, dagPan.y]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDagPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, [setDagPan]);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    // zoom toward cursor: keep the world point under the cursor fixed.
    const rect = svgRef.current?.getBoundingClientRect();
    const cxp = rect ? e.clientX - rect.left : 0;
    const cyp = rect ? e.clientY - rect.top : 0;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextZoom = Math.max(0.3, Math.min(2.5, dagZoom * factor));
    const applied = nextZoom / dagZoom;
    // p_screen = pan + zoom * p_world  =>  keep cursor fixed:
    setDagPan({
      x: cxp - applied * (cxp - dagPan.x),
      y: cyp - applied * (cyp - dagPan.y),
    });
    setDagZoom(nextZoom);
  }, [dagZoom, dagPan.x, dagPan.y, setDagPan, setDagZoom]);

  const fit = useCallback(() => {
    if (!layout || !svgRef.current) { setDagPan({ x: 0, y: 0 }); setDagZoom(1); return; }
    const rect = svgRef.current.getBoundingClientRect();
    const z = Math.max(0.3, Math.min(1.6,
      Math.min(rect.width / layout.width, rect.height / layout.height) * 0.92));
    setDagZoom(z);
    setDagPan({
      x: Math.round((rect.width - layout.width * z) / 2),
      y: Math.round((rect.height - layout.height * z) / 2),
    });
  }, [layout, setDagPan, setDagZoom]);

  const reset = useCallback(() => { setDagPan({ x: 0, y: 0 }); setDagZoom(1); }, [setDagPan, setDagZoom]);

  const onNodeClick = useCallback((dir: string) => {
    select(dir);
  }, [select]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-bg">
      <svg
        ref={svgRef}
        role="group"
        aria-label="Artifact DAG"
        className="w-full h-full touch-none select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <g transform={`translate(${dagPan.x} ${dagPan.y}) scale(${dagZoom})`}>
          {layout && (
            <DagBody
              layout={layout}
              fixture={fixture}
              asrByTrainingKey={asrByTrainingKey}
              trainingKeyOf={trainingKeyOf}
              selectedDir={selectedDir}
              hoveredDir={hoveredDir}
              onNodeClick={onNodeClick}
              onNodeHover={hover}
            />
          )}
        </g>
      </svg>

      {!scope && (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm font-mono pointer-events-none">
          select a node to graph its subtree
        </div>
      )}

      <DagControls
        lanes={lanes}
        setLanes={setLanes}
        onFit={fit}
        onReset={reset}
        zoom={dagZoom}
        truncated={layout?.truncated ?? 0}
        nodeCount={layout?.nodes.length ?? 0}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG body (memo-friendly: only re-renders on layout / selection / hover)
// ---------------------------------------------------------------------------

function DagBody({
  layout, fixture, asrByTrainingKey, trainingKeyOf, selectedDir, hoveredDir, onNodeClick, onNodeHover,
}: {
  layout: DagLayout;
  fixture: FixtureBundle;
  asrByTrainingKey: Map<string, Map<number, number>>;
  trainingKeyOf: (nodePath: string) => string | null;
  selectedDir: string | null;
  hoveredDir: string | null;
  onNodeClick: (dir: string) => void;
  onNodeHover: (dir: string | null) => void;
}) {
  const { nodes, byDir, chainEdges, crossEdges } = layout;

  return (
    <>
      {/* chain edges (orthogonal elbows) under everything */}
      <g fill="none" stroke="var(--color-border)" strokeWidth={1.5}>
        {chainEdges.map((e, i) => {
          const a = byDir.get(e.fromDir);
          const b = byDir.get(e.toDir);
          if (!a || !b) return null;
          return <path key={`ch${i}`} d={elbow(a, b)} stroke="var(--color-border)" />;
        })}
      </g>

      {/* dashed colored cross-edges */}
      <g fill="none" strokeWidth={1.5}>
        {crossEdges.map((e, i) => {
          const a = byDir.get(e.fromDir);
          const b = byDir.get(e.toDir);
          if (!a || !b) return null;
          const dim = CROSS_DIM[e.kind];
          return (
            <g key={`cx${i}`}>
              <path
                d={bezier(a, b)}
                stroke={CROSS_STROKE[e.kind]}
                strokeDasharray="5 4"
                strokeOpacity={dim ? 0.45 : 0.85}
              />
              {e.label && (
                <text
                  x={Math.round((a.cx + b.cx) / 2)}
                  y={Math.round((a.cy + b.cy) / 2) - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={CROSS_STROKE[e.kind]}
                  fillOpacity={dim ? 0.6 : 0.9}
                  className="font-mono pointer-events-none"
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {/* nodes — keyed by node.path (globally unique now); selection/hover also
          compare against path (selectedDir/hoveredDir hold paths). */}
      {nodes.map((n) => (
        n.isEpoch
          ? <EpochCell key={n.path} cell={n} fixture={fixture} asrByTrainingKey={asrByTrainingKey} trainingKeyOf={trainingKeyOf} selected={n.path === selectedDir} onClick={onNodeClick} onHover={onNodeHover} />
          : <NodeBox key={n.path} node={n} selected={n.path === selectedDir} hovered={n.path === hoveredDir} onClick={onNodeClick} onHover={onNodeHover} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Node box
// ---------------------------------------------------------------------------

function NodeBox({
  node, selected, hovered, onClick, onHover,
}: {
  node: LaidNode;
  selected: boolean;
  hovered: boolean;
  onClick: (dir: string) => void;
  onHover: (dir: string | null) => void;
}) {
  const [focused, setFocused] = useState(false);
  const stroke = focused
    ? "var(--color-accent)"
    : selected
      ? "var(--color-accent)"
      : hovered
        ? "var(--color-accent)"
        : "var(--color-border)";
  const pipCy = Math.round(node.h / 2);

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={node.path}
      className="cursor-pointer outline-none"
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(node.path); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick(node.path);
        }
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerEnter={() => onHover(node.path)}
      onPointerLeave={() => onHover(null)}
    >
      <title>{node.done ? "done" : node.claimed ? "claimed/lock" : "no-done"}</title>
      <rect
        width={node.w} height={node.h} rx={6}
        fill={selected ? "var(--color-surface-alt)" : "var(--color-surface)"}
        stroke={stroke}
        strokeWidth={focused || selected ? 2 : 1}
        fillOpacity={0.95}
      />
      {/* status pip: shape-coded like TreePane (filled=done, ring=claimed, thin ring=no-done) */}
      {node.done ? (
        <circle cx={12} cy={pipCy} r={4} fill="var(--color-success)" />
      ) : node.claimed ? (
        <circle cx={12} cy={pipCy} r={4} fill="none" stroke="var(--color-warning)" strokeWidth={1.5} />
      ) : (
        <circle cx={12} cy={pipCy} r={4} fill="none" stroke="var(--color-text-faint)" strokeWidth={1.25} />
      )}
      {/* label */}
      <text
        x={24} y={Math.round(node.h / 2) + 4}
        fontSize={11}
        fill={selected ? "var(--color-text)" : "var(--color-text-muted)"}
        className="font-mono pointer-events-none"
      >
        {clip(node.label, 17)}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Epoch cell with inline plantedness/ASR polyline
// ---------------------------------------------------------------------------

function EpochCell({
  cell, fixture, asrByTrainingKey, trainingKeyOf, selected, onClick, onHover,
}: {
  cell: LaidNode;
  fixture: FixtureBundle;
  asrByTrainingKey: Map<string, Map<number, number>>;
  trainingKeyOf: (nodePath: string) => string | null;
  selected: boolean;
  onClick: (dir: string) => void;
  onHover: (dir: string | null) => void;
}) {
  const [focused, setFocused] = useState(false);
  const series = useMemo(
    () => epochSeriesFor(cell, fixture, asrByTrainingKey, trainingKeyOf),
    [cell, fixture, asrByTrainingKey, trainingKeyOf],
  );
  const innerPad = 8;
  const plotW = cell.w - innerPad * 2;
  const plotH = cell.h - 20;
  const n = Math.max(1, series.asr.length);
  const stepX = n > 1 ? plotW / (n - 1) : 0;

  const pts = series.asr.map((v, i) => {
    const x = Math.round(innerPad + i * stepX);
    const y = Math.round(innerPad + (1 - clamp01(v)) * plotH);
    return `${x},${y}`;
  }).join(" ");

  // plantedness threshold line at 0.95
  const threshY = Math.round(innerPad + (1 - 0.95) * plotH);

  return (
    <g
      transform={`translate(${cell.x} ${cell.y})`}
      role="button"
      tabIndex={0}
      aria-label={cell.path}
      className="cursor-pointer outline-none"
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(cell.path); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick(cell.path);
        }
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerEnter={() => onHover(cell.path)}
      onPointerLeave={() => onHover(null)}
    >
      <title>{cell.done ? "done" : cell.claimed ? "claimed/lock" : "no-done"}</title>
      <rect
        width={cell.w} height={cell.h} rx={6}
        fill={selected ? "var(--color-surface-alt)" : "var(--color-surface)"}
        stroke={focused || selected ? "var(--color-accent)" : "var(--color-border)"}
        strokeWidth={focused || selected ? 2 : 1}
        fillOpacity={0.95}
      />
      {/* plantedness threshold (0.95) */}
      <line
        x1={innerPad} y1={threshY} x2={cell.w - innerPad} y2={threshY}
        stroke="var(--color-success)" strokeOpacity={0.35} strokeDasharray="3 3" strokeWidth={1}
      />
      {/* ASR trajectory */}
      {series.asr.length > 1 && (
        <polyline
          points={pts}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
        />
      )}
      {/* per-epoch dots; planting-crossing dot rendered in success */}
      {series.asr.map((v, i) => {
        const x = Math.round(innerPad + i * stepX);
        const y = Math.round(innerPad + (1 - clamp01(v)) * plotH);
        const crossed = series.plantedCrossIdx === i;
        return (
          <circle
            key={i} cx={x} cy={y} r={crossed ? 3.2 : 2}
            fill={crossed ? "var(--color-success)" : "var(--color-accent)"}
          />
        );
      })}
      {/* caption */}
      <text
        x={innerPad} y={cell.h - 5} fontSize={9}
        fill="var(--color-text-faint)" className="font-mono pointer-events-none"
      >
        ASR · epochs 0-{Math.max(0, series.asr.length - 1)}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Floating control panel (clouds control-panel idiom)
// ---------------------------------------------------------------------------

function DagControls({
  lanes, setLanes, onFit, onReset, zoom, truncated, nodeCount,
}: {
  lanes: Lanes;
  setLanes: (next: Lanes) => void;
  onFit: () => void;
  onReset: () => void;
  zoom: number;
  truncated: number;
  nodeCount: number;
}) {
  return (
    <div className="absolute top-4 left-4 z-10 w-60 max-h-[calc(100vh-8rem)] overflow-y-auto rounded-lg border border-border bg-surface/85 backdrop-blur-md p-4 text-sm animate-settle">
      <div className="font-display text-base font-semibold mb-3">DAG</div>

      <Section title="Lanes">
        <CheckRow checked={lanes.showPpl} onChange={(v) => setLanes({ ...lanes, showPpl: v })} label="Perplexity (ppl)" />
        <CheckRow checked={lanes.showDefenses} onChange={(v) => setLanes({ ...lanes, showDefenses: v })} label="Defenses" />
        <CheckRow checked={lanes.showInterp} onChange={(v) => setLanes({ ...lanes, showInterp: v })} label="Interp" />
        <CheckRow checked={lanes.showScans} onChange={(v) => setLanes({ ...lanes, showScans: v })} label="Scans" />
      </Section>

      <Section title="View">
        <div className="flex gap-2">
          <button
            onClick={onFit}
            className="flex-1 rounded-md border border-border bg-surface-alt px-2 py-1.5 text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
          >
            Fit
          </button>
          <button
            onClick={onReset}
            className="flex-1 rounded-md border border-border bg-surface-alt px-2 py-1.5 text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
          >
            Reset
          </button>
        </div>
        <div className="text-text-faint text-xs mt-2 font-mono">
          zoom {zoom.toFixed(2)}× · {nodeCount} nodes
          {truncated > 0 && <span className="text-warning"> · +{truncated} hidden</span>}
        </div>
      </Section>

      <Section title="Cross-edges">
        <div className="space-y-1">
          {CROSS_KINDS.map((c) => (
            <div key={c.kind} className="flex items-center gap-2 text-xs text-text-muted">
              <svg width={26} height={8} className="shrink-0">
                <line x1={0} y1={4} x2={26} y2={4} stroke={c.stroke} strokeWidth={1.5}
                  strokeDasharray="4 3" strokeOpacity={CROSS_DIM[c.kind] ? 0.45 : 0.9} />
              </svg>
              <span className={c.cls}>{c.label}</span>
            </div>
          ))}
        </div>
      </Section>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-faint font-mono leading-relaxed">
        <div><span className="text-text-muted">drag</span> background to pan</div>
        <div><span className="text-text-muted">scroll</span> to zoom · <span className="text-text-muted">click</span> a node to select</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-border pt-3 first:border-t-0 first:pt-0 first:mt-0">
      <div className="text-text font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers (integer-snapped paths for crisp strokes)
// ---------------------------------------------------------------------------

/** Orthogonal elbow from the right edge of `a` to the left edge of `b`. */
function elbow(a: LaidNode, b: LaidNode): string {
  const x1 = Math.round(a.x + a.w);
  const y1 = Math.round(a.cy);
  const x2 = Math.round(b.x);
  const y2 = Math.round(b.cy);
  const midX = Math.round(x1 + (x2 - x1) / 2);
  return `M${x1} ${y1} H${midX} V${y2} H${x2}`;
}

/** Dashed quadratic Bézier between two node centers (bowed for separation). */
function bezier(a: LaidNode, b: LaidNode): string {
  const x1 = Math.round(a.cx);
  const y1 = Math.round(a.cy);
  const x2 = Math.round(b.cx);
  const y2 = Math.round(b.cy);
  const mx = Math.round((x1 + x2) / 2);
  const my = Math.round((y1 + y2) / 2);
  // bow perpendicular-ish: lift the control point above the midpoint
  const bow = Math.round(Math.min(60, 24 + Math.abs(x2 - x1) / 6));
  return `M${x1} ${y1} Q${mx} ${my - bow} ${x2} ${y2}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
