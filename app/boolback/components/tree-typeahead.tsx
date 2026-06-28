"use client";

// app/boolback/components/tree-typeahead.tsx
//
// Replaces the old opaque global text filter. A small text box that, as you
// type, surfaces an arrow-key-navigable dropdown of directories nested under the
// current tree cursor (the focused dir, or the whole tree when no cursor is
// set), type-filtered by substring. Picking an entry:
//   - selects it + reveals it (expandChain) via onPick,
//   - moves the tree cursor onto it.
//
// It is a NAVIGATION aid only — it does NOT add a filter chip (that is the job
// of a row's Filter button). Pure React; nav-bar dropdown idiom.

import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../lib/types";

interface Candidate {
  node: TreeNode;
  /** Display: the node's own dirName (last path segment). */
  label: string;
  /** Depth below the cursor (for subtle indentation). */
  depth: number;
}

interface TreeTypeaheadProps {
  tree: TreeNode[];
  /** Path of the dir the search is scoped under (null => whole tree). */
  cursor: string | null;
  /** Reveal + select a chosen node (parent wires expandChain + select). */
  onPick: (node: TreeNode) => void;
  /** Move the typeahead cursor onto the chosen node. */
  onCursorChange: (path: string | null) => void;
}

// Flatten the subtree rooted at `cursor` (or all roots) into candidates carrying
// their depth. The cursor node itself is excluded — you search WITHIN it.
function collectCandidates(tree: TreeNode[], cursor: string | null): Candidate[] {
  const out: Candidate[] = [];

  const walk = (node: TreeNode, depth: number) => {
    out.push({ node, label: node.dirName, depth });
    for (const c of node.children) walk(c, depth + 1);
  };

  if (cursor === null) {
    for (const root of tree) walk(root, 0);
    return out;
  }

  // find the cursor node, then walk its children only.
  const find = (nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === cursor) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const anchor = find(tree);
  if (!anchor) {
    // stale cursor — fall back to whole tree
    for (const root of tree) walk(root, 0);
    return out;
  }
  for (const c of anchor.children) walk(c, 0);
  return out;
}

export function TreeTypeahead({
  tree,
  cursor,
  onPick,
  onCursorChange,
}: TreeTypeaheadProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const candidates = useMemo(() => collectCandidates(tree, cursor), [tree, cursor]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return candidates.slice(0, 60);
    return candidates
      .filter((c) => c.label.toLowerCase().includes(q))
      .slice(0, 60);
  }, [candidates, query]);

  // keep active index in bounds when results change
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // scroll the active option into view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const cursorLabel = useMemo(() => {
    if (cursor === null) return "all";
    const slash = cursor.lastIndexOf("/");
    return slash >= 0 ? cursor.slice(slash + 1) : cursor;
  }, [cursor]);

  const choose = (c: Candidate) => {
    onPick(c.node);
    onCursorChange(c.node.path);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = results[active];
      if (c) choose(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className="relative px-2 py-1.5 border-b border-border">
      <div
        className="font-mono flex items-center gap-2 bg-surface border border-border px-2 h-7 rounded-md focus-within:border-accent/80 transition-colors"
        onClick={() => inputRef.current?.focus()}
      >
        <span className="text-accent text-xs select-none leading-none shrink-0" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          placeholder={`find dir in ${cursorLabel}…`}
          aria-label="Find a directory under the tree cursor"
          className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint text-xs"
        />
        {cursor !== null && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCursorChange(null)}
            title="Search the whole tree"
            aria-label="Clear typeahead cursor"
            className="text-text-faint hover:text-text text-[10px] leading-none shrink-0"
          >
            scope ✕
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute left-2 right-2 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface/95 backdrop-blur-md py-1 shadow-lg animate-settle"
        >
          {results.map((c, i) => (
            <li
              key={c.node.path}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              style={{ paddingLeft: 8 + c.depth * 10 }}
              className={[
                "flex cursor-pointer items-center gap-1.5 pr-2 py-0.5 font-mono text-[11px] whitespace-nowrap",
                i === active ? "bg-surface-alt text-accent" : "text-text-muted",
              ].join(" ")}
            >
              <LevelDot level={c.node.level} />
              <span className="truncate">{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      {open && results.length === 0 && query.trim() !== "" && (
        <div className="absolute left-2 right-2 top-full z-40 mt-1 rounded-lg border border-border bg-surface/95 backdrop-blur-md px-3 py-2 text-[11px] text-text-faint">
          no dir matches “{query}”
        </div>
      )}
    </div>
  );
}

function LevelDot({ level }: { level: TreeNode["level"] }) {
  const color =
    level === "function" ? "var(--color-accent)"
      : level === "dataset" ? "var(--color-success)"
        : "var(--color-warning)";
  return (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

export default TreeTypeahead;
