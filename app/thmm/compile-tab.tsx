/**
 * Compile tab — THCC source on the left, live-compiled THMM listing on the
 * right, with bidirectional source↔instruction highlighting:
 *
 *   • Hover an instruction → its source span lights up underneath the
 *     editor caret as a tinted background range.
 *   • Move the cursor in the source → all instructions whose origin span
 *     contains the cursor light up in the listing.
 *
 * The source highlight is rendered by a `<pre>` layered behind a transparent
 * `<textarea>` with identical font + padding. Wrapping is disabled (overflow
 * scrolls horizontally) so character offsets line up byte-for-byte between
 * the two layers — no per-character measurement needed.
 *
 * "Load to RAM" hands the encoded bit-string source to the Sim tab via the
 * page-level callback and switches tabs.
 */
"use client";

import { useMemo, useRef, useState } from "react";
import {
  type CompileResult,
  type ThmmInst,
  compile,
  formatError,
  instructionsToBitsSource,
  REGRESSION_THCC,
} from "./thcc";

type Props = {
  source: string;
  onSourceChange: (s: string) => void;
  onLoadToRam: (bitsSource: string) => void;
};

export default function CompileTab({ source, onSourceChange, onLoadToRam }: Props) {
  const result: CompileResult = useMemo(() => compile(source), [source]);

  // Highlight state — instruction-driven hover beats cursor-driven implicit
  // highlight. Both feed into the shared "what's lit up" computation below.
  const [hoveredInst, setHoveredInst] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number>(-1);

  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Effective source highlight: prefer the hovered instruction's span; else
  // fall back to nothing (cursor only feeds the listing, not the editor).
  const insts: ThmmInst[] = result.ok ? result.instructions : [];
  const sourceHighlightSpan =
    hoveredInst !== null && insts[hoveredInst]
      ? insts[hoveredInst].span
      : null;

  // Which instructions to highlight in the listing.
  const litInsts = new Set<number>();
  if (hoveredInst !== null) {
    litInsts.add(hoveredInst);
  } else if (cursor >= 0 && result.ok) {
    insts.forEach((inst, i) => {
      if (cursor >= inst.span.start && cursor <= inst.span.end) {
        litInsts.add(i);
      }
    });
  }

  // Keep the highlight overlay scrolled in lockstep with the textarea.
  const handleScroll = () => {
    if (editorRef.current && preRef.current) {
      preRef.current.scrollTop = editorRef.current.scrollTop;
      preRef.current.scrollLeft = editorRef.current.scrollLeft;
    }
  };

  const handleSelect = () => {
    if (editorRef.current) setCursor(editorRef.current.selectionStart);
  };

  const handleLoad = () => {
    if (!result.ok) return;
    onLoadToRam(instructionsToBitsSource(result.instructions));
  };

  return (
    <div className="space-y-4">
      {/* Pipeline status strip + Load button */}
      <div className="flex flex-wrap items-center gap-3 animate-settle">
        <PipelineStrip result={result} />
        <div className="flex-1" />
        <button
          onClick={() => onSourceChange(REGRESSION_THCC)}
          className="px-3 py-1 text-[10px] font-mono uppercase tracking-[0.18em]
                     border border-border rounded text-text-muted
                     hover:text-text hover:border-accent/60 transition-colors"
        >
          reset to demo
        </button>
        <button
          onClick={handleLoad}
          disabled={!result.ok}
          className="px-4 py-1.5 text-xs font-mono uppercase tracking-[0.18em]
                     border border-accent/60 text-accent rounded
                     hover:border-accent hover:bg-accent/10
                     disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-accent/60
                     transition-colors"
        >
          load to ram →
        </button>
      </div>

      {/* Two-column compile view */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-settle-delay-1">
        {/* THCC source side */}
        <Panel title="THCC source" subtitle="C-style arithmetic">
          <SourceEditor
            source={source}
            highlight={sourceHighlightSpan}
            onChange={onSourceChange}
            onSelect={handleSelect}
            onScroll={handleScroll}
            editorRef={editorRef}
            preRef={preRef}
          />
        </Panel>

        {/* THMM assembly side */}
        <Panel
          title="THMM assembly"
          subtitle={result.ok ? `${result.instructions.length} words` : "—"}
        >
          {result.ok ? (
            <AssemblyListing
              insts={result.instructions}
              litInsts={litInsts}
              onHoverInst={setHoveredInst}
            />
          ) : (
            <div className="font-mono text-xs text-error p-3">
              {formatError(result.error)}
            </div>
          )}
        </Panel>
      </div>

      {/* Variable address table — only after successful compile */}
      {result.ok && result.varMap.length > 0 && (
        <div className="animate-settle-delay-2">
          <Panel title="Variables" subtitle="post-link RAM addresses">
            <VarTable varMap={result.varMap} />
          </Panel>
        </div>
      )}
    </div>
  );
}

// ==========================================================================
// Pipeline strip — three phase markers that color-code the compile state
// ==========================================================================

function PipelineStrip({ result }: { result: CompileResult }) {
  const failed = !result.ok ? result.error.kind : null;
  const parseOk = failed !== "parse";
  const cgOk =
    parseOk &&
    failed !== "undefinedVar" &&
    failed !== "duplicateDecl" &&
    failed !== "literalOutOfRange";
  const linkOk = result.ok;

  return (
    <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em]">
      <Phase label="parse" ok={parseOk} />
      <Arrow />
      <Phase label="codegen" ok={cgOk} />
      <Arrow />
      <Phase label="link" ok={linkOk} />
    </div>
  );
}

function Phase({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 border rounded ${
        ok
          ? "text-accent border-accent/40 bg-accent/[0.06]"
          : "text-error border-error/50 bg-error/[0.05]"
      }`}
    >
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="text-text-faint">→</span>;
}

// ==========================================================================
// Panel — shared chrome for the two halves of the compile view
// ==========================================================================

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex items-baseline justify-between px-3 py-2 border-b border-border">
        <h3 className="text-[10px] uppercase tracking-[0.25em] font-display text-text-muted">
          {title}
        </h3>
        {subtitle && (
          <span className="text-[10px] font-mono text-text-faint">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ==========================================================================
// Source editor — textarea with a synced highlight overlay
// ==========================================================================

const EDITOR_FONT_PX = 12;
const EDITOR_LINE_PX = 18;
const EDITOR_PAD = 12;

function SourceEditor({
  source,
  highlight,
  onChange,
  onSelect,
  onScroll,
  editorRef,
  preRef,
}: {
  source: string;
  highlight: { start: number; end: number } | null;
  onChange: (s: string) => void;
  onSelect: () => void;
  onScroll: () => void;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  preRef: React.RefObject<HTMLPreElement | null>;
}) {
  const sharedStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
    fontSize: `${EDITOR_FONT_PX}px`,
    lineHeight: `${EDITOR_LINE_PX}px`,
    padding: `${EDITOR_PAD}px`,
    margin: 0,
    tabSize: 2,
    whiteSpace: "pre",
    border: 0,
  };

  return (
    <div className="relative" style={{ height: 480 }}>
      {/* Highlight layer — invisible text, visible background span */}
      <pre
        ref={preRef}
        aria-hidden
        className="absolute inset-0 overflow-hidden text-transparent"
        style={{
          ...sharedStyle,
          // Selection background should match the editor's monospace grid.
          background: "transparent",
        }}
      >
        {renderHighlightLayer(source, highlight)}
      </pre>

      <textarea
        ref={editorRef}
        value={source}
        onChange={(e) => onChange(e.target.value)}
        onSelect={onSelect}
        onClick={onSelect}
        onKeyUp={onSelect}
        onScroll={onScroll}
        spellCheck={false}
        className="absolute inset-0 w-full h-full bg-transparent
                   text-text caret-accent outline-none resize-none
                   focus:ring-0"
        style={{
          ...sharedStyle,
          color: "var(--color-text)",
          background: "transparent",
        }}
      />
    </div>
  );
}

function renderHighlightLayer(
  src: string,
  span: { start: number; end: number } | null,
): React.ReactNode {
  if (!span || span.end <= span.start) return src;
  const before = src.slice(0, span.start);
  const mid = src.slice(span.start, span.end);
  const after = src.slice(span.end);
  return (
    <>
      {before}
      <span
        style={{
          background: "var(--color-accent-dim)",
          // A thin under-rule reads as "this is the lit range" without
          // depending on a colored background contrast against the caret.
          boxShadow: "inset 0 -1px 0 var(--color-accent)",
        }}
      >
        {mid}
      </span>
      {after}
    </>
  );
}

// ==========================================================================
// Assembly listing
// ==========================================================================

function AssemblyListing({
  insts,
  litInsts,
  onHoverInst,
}: {
  insts: ThmmInst[];
  litInsts: Set<number>;
  onHoverInst: (i: number | null) => void;
}) {
  return (
    <div className="overflow-y-auto" style={{ maxHeight: 480 }}>
      <table className="w-full font-mono text-xs">
        <tbody>
          {insts.map((inst, i) => {
            const lit = litInsts.has(i);
            return (
              <tr
                key={i}
                onMouseEnter={() => onHoverInst(i)}
                onMouseLeave={() => onHoverInst(null)}
                className="cursor-default"
                style={{
                  background: lit ? "var(--color-accent-dim)" : "transparent",
                  boxShadow: lit
                    ? "inset 2px 0 0 var(--color-accent)"
                    : "inset 2px 0 0 transparent",
                  transition: "background-color 80ms",
                }}
              >
                <td className="pl-3 pr-2 py-0.5 text-text-faint w-12 text-right">
                  {i}
                </td>
                <td className="pr-2 py-0.5 text-text-muted w-24">
                  {inst.bits.match(/.{4}/g)?.join(" ")}
                </td>
                <td className="pr-2 py-0.5 text-text-muted w-12">{inst.hex}</td>
                <td
                  className="pr-3 py-0.5"
                  style={{ color: lit ? "var(--color-accent)" : "var(--color-text)" }}
                >
                  {inst.asm}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ==========================================================================
// Variable table
// ==========================================================================

function VarTable({
  varMap,
}: {
  varMap: { name: string; addr: number }[];
}) {
  return (
    <div className="px-3 py-2 font-mono text-xs flex flex-wrap gap-x-6 gap-y-1">
      {varMap.map((v) => (
        <div key={v.name} className="flex items-baseline gap-2">
          <span className="text-text">{v.name}</span>
          <span className="text-text-faint">→</span>
          <span className="text-accent">RAM[{v.addr}]</span>
        </div>
      ))}
    </div>
  );
}
