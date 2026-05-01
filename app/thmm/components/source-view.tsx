/**
 * Read-only or editable source code with line numbers and span highlights.
 * One or more spans can be highlighted at once; the viewer renders an
 * accent overlay for each.
 */
"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import type { Span } from "../thcc";

type Props = {
  source: string;
  highlights?: Span[];
  /** When true, source is rendered as a textarea the user can edit. */
  editable?: boolean;
  onChange?: (next: string) => void;
  /** Optional click handler keyed by source line index (1-based). */
  onLineClick?: (line: number) => void;
};

export default function SourceView({
  source, highlights, editable, onChange, onLineClick,
}: Props) {
  const lines = useMemo(() => source.split("\n"), [source]);

  // Derive per-line span ranges by intersecting each highlight with each
  // line. Most THCC examples are tiny so a quadratic scan is fine.
  const lineHighlights = useMemo(() => {
    if (!highlights || highlights.length === 0) return [];
    const out: { line: number; startCol: number; endCol: number }[] = [];
    let pos = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineStart = pos;
      const lineEnd = pos + lines[li].length;
      for (const h of highlights) {
        const s = Math.max(h.start, lineStart);
        const e = Math.min(h.end, lineEnd);
        if (s <= e && (h.end >= lineStart && h.start <= lineEnd)) {
          out.push({ line: li, startCol: s - lineStart, endCol: e - lineStart });
        }
      }
      pos = lineEnd + 1; // +1 for the newline
    }
    return out;
  }, [highlights, lines]);

  if (editable) {
    return (
      <AutoSizeTextarea
        value={source}
        onChange={(next) => onChange?.(next)}
      />
    );
  }

  return (
    <pre className="bg-white/[0.02] border border-white/10 rounded-lg p-4 font-mono text-sm leading-relaxed overflow-auto m-0">
      {lines.map((line, i) => {
        const hl = lineHighlights.filter(h => h.line === i);
        const isHighlighted = hl.length > 0;
        return (
          <div
            key={i}
            onClick={onLineClick ? () => onLineClick(i + 1) : undefined}
            className={`flex ${isHighlighted ? "bg-accent/10" : ""} ${onLineClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
          >
            <span className="select-none text-text-faint w-10 text-right pr-3">{i + 1}</span>
            <span className="text-text whitespace-pre flex-1">
              {hl.length > 0 ? renderHighlightedLine(line, hl) : line}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

function AutoSizeTextarea({
  value, onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Sync the textarea's intrinsic height to its content. Runs every render
  // so paste / external prop updates / first mount all resize correctly.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      rows={1}
      className="w-full bg-white/[0.02] border border-white/10 rounded-lg p-4 font-mono text-sm text-text leading-relaxed outline-none focus:border-white/20 overflow-hidden resize-none"
    />
  );
}

function renderHighlightedLine(
  line: string,
  hl: { startCol: number; endCol: number }[],
): React.ReactNode {
  // Merge overlapping ranges into a single set of segments.
  const sorted = [...hl].sort((a, b) => a.startCol - b.startCol);
  const merged: { startCol: number; endCol: number }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startCol <= last.endCol) {
      last.endCol = Math.max(last.endCol, r.endCol);
    } else {
      merged.push({ ...r });
    }
  }
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const seg of merged) {
    if (seg.startCol > cursor) {
      out.push(line.slice(cursor, seg.startCol));
    }
    out.push(
      <span key={`${seg.startCol}-${seg.endCol}`} className="bg-accent/20 text-accent rounded-sm px-[1px]">
        {line.slice(seg.startCol, seg.endCol)}
      </span>,
    );
    cursor = seg.endCol;
  }
  if (cursor < line.length) out.push(line.slice(cursor));
  return out;
}
