"use client";

// app/boolback/components/tree-pane.tsx
//
// Left artifact tree. Root is a synthetic "artifacts" node whose children are
// the bundle's function roots (Bundle.tree). The tree has exactly three real
// levels: function -> dataset -> training. There is no census fold, no DAG, no
// scope/focus concept.
//
// The tree is a PURE NAVIGATOR (Phase 1): clicking selects/expands and reveals
// the chain — it never filters. (Subtree scope chips were removed; the function
// becomes an ordinary parameter filter in a later phase.)
//   - DETAILS button: opens the right detail panel for that node (openDetail).
//   - Clicking ELSEWHERE on the row expands/collapses it (and selects it).
// A typeahead box at the top finds dirs nested under the tree cursor.

import { useCallback, useMemo } from "react";
import type { Bundle, TreeNode } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { TreeTypeahead } from "./tree-typeahead";

interface TreePaneProps {
  bundle: Bundle;
  /** Collapse the pane to the client's slim rail (button beside the typeahead). */
  onCollapse?: () => void;
}

const ROOT_PATH = "__artifacts__";

interface FlatRow {
  node: TreeNode;
  depth: number;
  isRoot: boolean;
}

// Flatten the synthetic root + visible (expanded) descendants in render order.
function flatten(roots: TreeNode[], expanded: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const rootOpen = expanded.has(ROOT_PATH);

  out.push({
    node: {
      path: ROOT_PATH,
      dirName: "artifacts",
      level: "function",
      slug: "",
      hash: "",
      kind: "function",
      done: roots.length > 0,
      run_ids: [],
      children: roots,
    },
    depth: 0,
    isRoot: true,
  });
  if (!rootOpen) return out;

  const visit = (node: TreeNode, depth: number) => {
    out.push({ node, depth, isRoot: false });
    if (!expanded.has(node.path)) return;
    for (const c of node.children) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 1);
  return out;
}

function levelColor(level: TreeNode["level"]): string {
  if (level === "function") return "text-accent";
  if (level === "dataset") return "text-success";
  return "text-warning";
}

// ---------------------------------------------------------------------------
// Status pip: done -> filled success; else hollow.
// ---------------------------------------------------------------------------
function StatusPip({ done }: { done: boolean }) {
  return (
    <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 ${done ? "text-success" : "text-text-faint"}`} aria-hidden>
      {done ? (
        <circle cx="6" cy="6" r="3.5" fill="currentColor" />
      ) : (
        <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
      )}
    </svg>
  );
}

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
  open: boolean;
  onExpand: (node: TreeNode, isRoot: boolean) => void;
  onDetails: (path: string) => void;
  onHover: (path: string | null) => void;
}

function TreeRow({
  row, selected, open, onExpand, onDetails, onHover,
}: TreeRowProps) {
  const { node, depth, isRoot } = row;
  const hasChildren = node.children.length > 0;
  const paddingLeft = 8 + depth * 14;

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      onMouseEnter={() => onHover(isRoot ? null : node.path)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onExpand(node, isRoot)}
      style={{ paddingLeft }}
      className={[
        "group flex items-center gap-1.5 pr-1.5 h-7 cursor-pointer select-none whitespace-nowrap text-xs",
        selected ? "bg-surface-alt text-text" : "text-text-muted hover:text-text",
      ].join(" ")}
    >
      <Caret open={open} hasChildren={hasChildren} />
      <StatusPip done={node.done} />

      {/* three-zone dirName */}
      {isRoot ? (
        <span className="font-mono text-text-faint truncate">artifacts</span>
      ) : (
        <span className="font-mono truncate flex-1 min-w-0">
          <span className={`${levelColor(node.level)} font-semibold`}>{node.level}</span>
          {node.slug !== "" && (
            <>
              <span className="text-text-faint">+</span>
              <span className="text-text/90">{node.slug}</span>
            </>
          )}
          {node.hash !== "" && <span className="text-text-faint">+{node.hash}</span>}
        </span>
      )}

      {/* per-row affordance (hidden until row hover) */}
      {!isRoot && (
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onDetails(node.path);
            }}
            title="Open details panel"
            className="rounded px-1 py-0.5 text-[10px] font-mono leading-none text-text-faint opacity-0 group-hover:opacity-100 hover:text-accent transition-opacity"
          >
            ⓘ details
          </button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreePane
// ---------------------------------------------------------------------------
export function TreePane({ bundle, onCollapse }: TreePaneProps) {
  const roots = bundle.tree;

  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const expanded = useBoolbackStore((s) => s.expanded);
  const treeCursor = useBoolbackStore((s) => s.treeCursor);

  const select = useBoolbackStore((s) => s.select);
  const hover = useBoolbackStore((s) => s.hover);
  const toggleExpand = useBoolbackStore((s) => s.toggleExpand);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const setTreeCursor = useBoolbackStore((s) => s.setTreeCursor);

  const rows = useMemo(() => flatten(roots, expanded), [roots, expanded]);

  // expand/collapse + select on a plain row click
  const onExpand = useCallback(
    (node: TreeNode, isRoot: boolean) => {
      const path = isRoot ? ROOT_PATH : node.path;
      toggleExpand(path);
      if (!isRoot) select(node.path);
    },
    [toggleExpand, select],
  );

  // typeahead pick: reveal the chain to the node + select it
  const onTypeaheadPick = useCallback(
    (node: TreeNode) => {
      // reveal: open root + every ancestor path prefix of node.path
      const segments = node.path.split("/");
      const chain: string[] = [ROOT_PATH];
      let acc = "";
      for (const seg of segments) {
        acc = acc === "" ? seg : `${acc}/${seg}`;
        chain.push(acc);
      }
      expandChain(chain);
      select(node.path);
    },
    [expandChain, select],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <TreeTypeahead
            tree={roots}
            cursor={treeCursor}
            onPick={onTypeaheadPick}
            onCursorChange={setTreeCursor}
          />
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse the artifact tree"
            aria-label="Collapse the artifact tree"
            className="shrink-0 border-b border-border px-1.5 text-xs text-text-faint transition-colors hover:text-accent"
          >
            «
          </button>
        )}
      </div>
      <div
        role="tree"
        aria-label="Artifact tree"
        className="min-w-max flex-1 overflow-auto py-1"
      >
        {rows.map((row) => {
          const path = row.isRoot ? ROOT_PATH : row.node.path;
          const open = expanded.has(path);
          const isSel = !row.isRoot && row.node.path === selectedDir;
          return (
            <TreeRow
              key={path}
              row={row}
              selected={isSel}
              open={open}
              onExpand={onExpand}
              onDetails={openDetail}
              onHover={hover}
            />
          );
        })}
      </div>
    </div>
  );
}

export default TreePane;
