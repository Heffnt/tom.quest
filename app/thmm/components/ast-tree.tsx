/**
 * Indented-text rendering of the AST. No SVG, no animations — just nested
 * lines that mirror the parser's tree structure. Each node is clickable
 * and reports its source span so the caller can sync-highlight the source.
 */
"use client";

import type { Expr, Program, Span, Stmt } from "../thcc";

type Props = {
  program: Program;
  /** Indices of top-level statements that should be visible. Earlier ones
   *  are rendered, later ones hidden — used by the parse scene's stepping. */
  visibleCount?: number;
  onNodeClick?: (span: Span) => void;
  highlightSpan?: Span | null;
};

export default function AstTree({ program, visibleCount, onNodeClick, highlightSpan }: Props) {
  const n = visibleCount ?? program.length;
  return (
    <div className="bg-white/[0.02] border border-white/10 rounded-lg p-4 font-mono text-sm leading-relaxed overflow-auto">
      {program.slice(0, n).map((s, i) => (
        <StmtNode key={i} stmt={s} onClick={onNodeClick} highlight={highlightSpan} />
      ))}
      {n < program.length && (
        <div className="text-text-faint mt-2">
          {program.length - n} more statement{program.length - n === 1 ? "" : "s"} not yet parsed…
        </div>
      )}
    </div>
  );
}

function StmtNode({
  stmt, onClick, highlight,
}: {
  stmt: Stmt;
  onClick?: (span: Span) => void;
  highlight?: Span | null;
}) {
  const isHi = sameSpan(highlight, stmt.span);
  return (
    <div className={`mb-2 ${isHi ? "bg-accent/10 -mx-2 px-2 py-1 rounded" : ""}`}>
      <button
        type="button"
        onClick={() => onClick?.(stmt.span)}
        className={`text-left ${isHi ? "text-accent" : "text-text"} hover:text-accent`}
      >
        {stmt.kind === "decl"
          ? <>Decl <span className="text-accent">{stmt.name}</span></>
          : <>DeclEmpty <span className="text-accent">{stmt.name}</span></>}
      </button>
      {stmt.kind === "decl" && (
        <div className="pl-6 border-l border-white/10 ml-1 mt-1">
          <ExprNode expr={stmt.expr} onClick={onClick} highlight={highlight} />
        </div>
      )}
    </div>
  );
}

function ExprNode({
  expr, onClick, highlight,
}: {
  expr: Expr;
  onClick?: (span: Span) => void;
  highlight?: Span | null;
}) {
  const isHi = sameSpan(highlight, expr.span);
  if (expr.kind === "lit") {
    return (
      <button
        type="button"
        onClick={() => onClick?.(expr.span)}
        className={`block text-left hover:text-accent ${isHi ? "text-accent" : "text-text"}`}
      >
        Lit <span className="text-warning">{expr.value}</span>
      </button>
    );
  }
  if (expr.kind === "var") {
    return (
      <button
        type="button"
        onClick={() => onClick?.(expr.span)}
        className={`block text-left hover:text-accent ${isHi ? "text-accent" : "text-text"}`}
      >
        Var <span className="text-accent">{expr.name}</span>
      </button>
    );
  }
  return (
    <div className={isHi ? "bg-accent/10 -mx-2 px-2 py-1 rounded" : ""}>
      <button
        type="button"
        onClick={() => onClick?.(expr.span)}
        className={`text-left hover:text-accent ${isHi ? "text-accent" : "text-text"}`}
      >
        BinOp <span className="text-success">{expr.op}</span>
      </button>
      <div className="pl-6 border-l border-white/10 ml-1 mt-1">
        <ExprNode expr={expr.left} onClick={onClick} highlight={highlight} />
        <ExprNode expr={expr.right} onClick={onClick} highlight={highlight} />
      </div>
    </div>
  );
}

function sameSpan(a: Span | null | undefined, b: Span): boolean {
  return !!a && a.start === b.start && a.end === b.end;
}
