"use client";

// app/boolback/components/tree-pane.tsx
// Recursive content-addressed directory tree (left pane). Pure divs + inline SVG
// glyphs, nav-term list idiom. Selection-driver wired through the zustand store
// (selector-consumed). The immutable fixture is passed DOWN as a prop.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TreeNode, NodeKind } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { pathToNode } from "../data/fixture";
import type { FixtureBundle } from "../data/fixture";
import { applyFilters } from "../lib/select";

interface TreePaneProps {
  fixture: FixtureBundle;
}

// A node as it appears flattened in render order, carrying its depth and
// whether it sits on a side-branch (defense_/interp/scan_) rule.
interface FlatRow {
  node: TreeNode;
  depth: number;
  sideBranch: boolean;
  // census virtual group rows carry a synthetic node (kind "group", groupKind null).
  censusGroup: boolean;
  censusChildren?: TreeNode[]; // the 34 folded function nodes (only on a censusGroup row)
}

const CENSUS_GROUP_DIR = "__census_group__";

// ---------------------------------------------------------------------------
// level badge color (three-zone styling, zone 1)
// ---------------------------------------------------------------------------
function levelBadgeClass(level: NodeKind | null): string {
  if (!level) return "text-text-faint";
  if (level === "function") return "text-accent";
  if (level === "dataset") return "text-success";
  if (level === "training") return "text-warning";
  if (level === "inference") return "text-text";
  if (level === "scoring") return "text-accent";
  if (level === "ppl") return "text-text-muted";
  if (level === "interp") return "text-text-muted";
  if (level === "model") return "text-text-muted";
  if (level.startsWith("defense_")) return "text-error";
  if (level.startsWith("scan_")) return "text-error";
  return "text-text-muted";
}

// The level token shown in the badge zone (strip the specialized suffix prefix
// to its taxonomy head so the badge stays short).
function levelToken(node: TreeNode): string {
  if (node.level) return node.level;
  return node.groupKind ?? "group";
}

function isSideBranchNode(node: TreeNode): boolean {
  if (!node.level) return false;
  return node.level.startsWith("defense_") || node.level.startsWith("scan_") || node.level === "interp";
}

// ---------------------------------------------------------------------------
// Flatten the visible tree (respecting expansion + census collapse). Built once
// per (root/focusRoot, expanded, collapseCensus) so keyboard nav is deterministic.
// ---------------------------------------------------------------------------
function flatten(
  root: TreeNode,
  expanded: Set<string>,
  collapseCensus: boolean,
): FlatRow[] {
  const out: FlatRow[] = [];

  const visit = (node: TreeNode, depth: number, onSideRule: boolean) => {
    const sideRule = onSideRule || isSideBranchNode(node);
    out.push({ node, depth, sideBranch: sideRule, censusGroup: false });
    if (!expanded.has(node.path)) return;

    const children = node.children;
    if (children.length === 0) return;

    // Census fold: when collapseCensus, fold a run of >=3 sibling arity-3 census
    // function nodes (function+<8-bit bitstring>+...) into one virtual ×N group.
    if (collapseCensus) {
      const census = children.filter(
        (c) => c.level === "function" && (c.slug?.length ?? 0) === 8,
      );
      if (census.length >= 3) {
        const rest = children.filter((c) => !census.includes(c));
        // virtual group row first
        out.push({
          node: makeCensusNode(census.length),
          depth: depth + 1,
          sideBranch: sideRule,
          censusGroup: true,
          censusChildren: census,
        });
        if (expanded.has(CENSUS_GROUP_DIR)) {
          for (const c of census) visit(c, depth + 2, sideRule);
        }
        for (const c of rest) visit(c, depth + 1, sideRule);
        return;
      }
    }

    for (const c of children) visit(c, depth + 1, sideRule);
  };

  visit(root, 0, false);
  return out;
}

function makeCensusNode(count: number): TreeNode {
  return {
    dirName: CENSUS_GROUP_DIR,
    path: CENSUS_GROUP_DIR,
    kind: "group",
    groupKind: null,
    level: null,
    slug: `census ×${count}`,
    hash: null,
    config: null,
    elidedKeys: [],
    done: false,
    claimed: false,
    inChain: false,
    projected: false,
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Status pip: done -> filled success dot; claimed -> warning ring; else hollow.
// ---------------------------------------------------------------------------
function StatusPip({ node }: { node: TreeNode }) {
  if (node.kind === "group") {
    // group dirs get a folder glyph instead of a pip
    return (
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-text-faint" aria-hidden>
        <path
          fill="currentColor"
          d="M1 3a1 1 0 0 1 1-1h2.5l1 1H10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z"
        />
      </svg>
    );
  }
  if (node.done) {
    return (
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-success" aria-hidden>
        <circle cx="6" cy="6" r="3.5" fill="currentColor" />
      </svg>
    );
  }
  if (node.claimed) {
    return (
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-warning" aria-hidden>
        <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  // no-done hollow ring
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-text-faint" aria-hidden>
      <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

// caret for expandable rows
function Caret({ open, hasChildren }: { open: boolean; hasChildren: boolean }) {
  if (!hasChildren) return <span className="inline-block w-3 shrink-0" aria-hidden />;
  return (
    <span
      className={`inline-block w-3 shrink-0 text-center text-[10px] leading-none transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      ▸
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------
interface TreeRowProps {
  row: FlatRow;
  selected: boolean;
  dimmed: boolean;
  onSelect: (row: FlatRow) => void;
  onToggle: (dir: string) => void;
  onHover: (dir: string | null) => void;
}

function TreeRow({ row, selected, dimmed, onSelect, onToggle, onHover }: TreeRowProps) {
  const { node, depth, sideBranch, censusGroup } = row;
  const expanded = useBoolbackStore((s) => s.expanded);
  const open = censusGroup
    ? expanded.has(CENSUS_GROUP_DIR)
    : expanded.has(node.path);
  const hasChildren = censusGroup
    ? (row.censusChildren?.length ?? 0) > 0
    : node.children.length > 0;

  const isGroup = node.kind === "group";
  const paddingLeft = 8 + depth * 14;

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      onMouseEnter={() => onHover(censusGroup ? null : node.path)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(row)}
      style={{ paddingLeft }}
      className={[
        "group flex items-center gap-1.5 pr-2 h-7 cursor-pointer select-none whitespace-nowrap text-xs",
        sideBranch ? "border-l border-error/30" : "",
        selected
          ? "bg-surface-alt text-text"
          : "text-text-muted hover:text-text",
        dimmed ? "opacity-40" : "",
      ].join(" ")}
    >
      <span className={selected ? "text-accent" : "text-transparent"} aria-hidden>
        {selected ? "▸" : "·"}
      </span>
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) onToggle(censusGroup ? CENSUS_GROUP_DIR : node.path);
        }}
        className="flex items-center shrink-0"
        aria-hidden={!hasChildren}
      >
        <Caret open={open} hasChildren={hasChildren} />
      </button>

      <StatusPip node={node} />

      {/* three-zone dirName */}
      {isGroup ? (
        <span className="font-mono text-text-faint truncate">
          {censusGroup ? node.slug : node.dirName}
        </span>
      ) : (
        <span className="font-mono truncate">
          <span className={`${levelBadgeClass(node.level)} font-semibold`}>
            {levelToken(node)}
          </span>
          {node.slug != null && (
            <>
              <span className="text-text-faint">+</span>
              <span className="text-text/90">{node.slug}</span>
            </>
          )}
          {node.hash != null && (
            <span className="text-text-faint">+{node.hash}</span>
          )}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreePane
// ---------------------------------------------------------------------------
export function TreePane({ fixture }: TreePaneProps) {
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const expanded = useBoolbackStore((s) => s.expanded);
  const focusRoot = useBoolbackStore((s) => s.focusRoot);
  const collapseCensus = useBoolbackStore((s) => s.collapseCensus);
  const filters = useBoolbackStore((s) => s.filters);

  const select = useBoolbackStore((s) => s.select);
  const hover = useBoolbackStore((s) => s.hover);
  const toggleExpand = useBoolbackStore((s) => s.toggleExpand);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const setScopeDir = useBoolbackStore((s) => s.setScopeDir);
  const setFocusRoot = useBoolbackStore((s) => s.setFocusRoot);

  // resolve the render root (focusRoot subtree or the real root)
  const renderRoot = useMemo(() => {
    if (focusRoot) {
      const sub = fixture.nodeIndex.get(focusRoot);
      if (sub) return sub;
    }
    return fixture.root;
  }, [focusRoot, fixture]);

  // flattened, ordered visible rows (drives keyboard nav + render)
  const rows = useMemo(
    () => flatten(renderRoot, expanded, collapseCensus),
    [renderRoot, expanded, collapseCensus],
  );

  // dim set: dirNames that survive the current experiment filter. Only narrows
  // when a filter is actually active (otherwise nothing is dimmed).
  const liveDirs = useMemo(() => {
    const filtered = applyFilters(fixture.experiments, filters);
    if (filtered.length === fixture.experiments.length) return null; // no narrowing
    const set = new Set<string>();
    for (const r of filtered) for (const d of r.chainDirs) set.add(d);
    return set;
  }, [fixture.experiments, filters]);

  // ---- selection handler ----
  const onSelect = useCallback(
    (row: FlatRow) => {
      const node = row.node;
      if (row.censusGroup) {
        // virtual group: just toggle it open (no real dir to select)
        toggleExpand(CENSUS_GROUP_DIR);
        return;
      }
      if (node.kind === "group") {
        // group / non-experiment node -> table scope chip + reveal (path-keyed)
        select(node.path);
        expandChain(pathToNode(node.path));
        setScopeDir(node.path);
        if (node.children.length > 0) toggleExpand(node.path);
        return;
      }
      select(node.path);
      expandChain(pathToNode(node.path));
      // selecting a non-experiment (non-chain-leaf) node scopes the table too
      if (!node.projected || node.level !== "scoring") {
        setScopeDir(node.path);
      }
    },
    [select, expandChain, setScopeDir, toggleExpand],
  );

  // ---- debounced hover (150ms via useRef setTimeout, thmm precedent) ----
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHover = useCallback(
    (dir: string | null) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => hover(dir), 150);
    },
    [hover],
  );
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  // ---- keyboard nav (mirror nav-term: up/down/left/right/Enter) ----
  const containerRef = useRef<HTMLDivElement>(null);
  const selIndex = useMemo(() => {
    if (!selectedDir) return -1;
    return rows.findIndex((r) => !r.censusGroup && r.node.path === selectedDir);
  }, [rows, selectedDir]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const idx = selIndex;
      const cur = idx >= 0 ? rows[idx] : null;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        let j = idx < 0 ? 0 : idx + 1;
        while (j < rows.length && rows[j].censusGroup) j++;
        if (rows[j]) onSelect(rows[j]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        let j = idx <= 0 ? 0 : idx - 1;
        while (j > 0 && rows[j].censusGroup) j--;
        if (rows[j] && !rows[j].censusGroup) onSelect(rows[j]);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!cur) return;
        const dir = cur.node.path;
        const hasKids = cur.censusGroup
          ? (cur.censusChildren?.length ?? 0) > 0
          : cur.node.children.length > 0;
        const isOpen = cur.censusGroup
          ? expanded.has(CENSUS_GROUP_DIR)
          : expanded.has(dir);
        if (hasKids && !isOpen) toggleExpand(cur.censusGroup ? CENSUS_GROUP_DIR : dir);
        else if (hasKids && idx + 1 < rows.length) {
          const child = rows[idx + 1];
          if (child && !child.censusGroup) onSelect(child);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!cur) return;
        const dir = cur.node.path;
        const isOpen = cur.censusGroup
          ? expanded.has(CENSUS_GROUP_DIR)
          : expanded.has(dir);
        const hasKids = cur.censusGroup
          ? (cur.censusChildren?.length ?? 0) > 0
          : cur.node.children.length > 0;
        if (hasKids && isOpen) {
          toggleExpand(cur.censusGroup ? CENSUS_GROUP_DIR : dir);
        } else if (!cur.censusGroup) {
          // jump to parent (path keys)
          const path = pathToNode(dir);
          const parent = path[path.length - 2];
          if (parent) {
            const pIdx = rows.findIndex((r) => !r.censusGroup && r.node.path === parent);
            if (pIdx >= 0) onSelect(rows[pIdx]);
          }
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (cur) onSelect(cur);
      }
    },
    [rows, selIndex, expanded, onSelect, toggleExpand],
  );

  return (
    <div
      ref={containerRef}
      role="tree"
      tabIndex={0}
      aria-label="Artifact tree"
      onKeyDown={onKeyDown}
      className="min-w-max py-1 outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    >
      {focusRoot && (
        <button
          type="button"
          onClick={() => setFocusRoot(null)}
          className="mb-1 ml-2 font-mono text-[10px] text-text-muted hover:text-accent transition-colors"
        >
          ↑ exit subtree focus
        </button>
      )}
      {rows.map((row, i) => {
        const isSel = !row.censusGroup && row.node.path === selectedDir;
        const dimmed =
          liveDirs !== null &&
          !row.censusGroup &&
          row.node.kind !== "group" &&
          row.node.inChain &&
          !liveDirs.has(row.node.path);
        return (
          <TreeRow
            // node.path is globally unique now; positional suffix kept only to
            // disambiguate the same path appearing twice (census fold edge case).
            key={row.censusGroup ? `census-${i}` : `${row.node.path}-${i}`}
            row={row}
            selected={isSel}
            dimmed={dimmed}
            onSelect={onSelect}
            onToggle={toggleExpand}
            onHover={onHover}
          />
        );
      })}
    </div>
  );
}

export default TreePane;
