/**
 * Assembly listing — one instruction per line, optional address column.
 * Highlight set is by instruction index. Used by codegen, link, and
 * execute scenes.
 */
"use client";

type Row = {
  /** Address column text (e.g. "  14:" or "x0:"). Pass null to skip column. */
  addr: string | null;
  /** Mnemonic + operand string. */
  asm: string;
};

type Props = {
  rows: Row[];
  /** Indices to highlight in accent. */
  highlight?: Set<number> | number[];
  /** Indices to dim. Used to mark "not yet emitted" in stepping mode. */
  dimmed?: Set<number> | number[];
  /** Click handler — receives the row index. */
  onRowClick?: (idx: number) => void;
};

export default function AsmView({ rows, highlight, dimmed, onRowClick }: Props) {
  const hi = toSet(highlight);
  const dim = toSet(dimmed);
  return (
    <pre className="bg-white/[0.02] border border-white/10 rounded-lg p-4 font-mono text-sm leading-relaxed overflow-auto m-0">
      {rows.map((r, i) => {
        const isHi = hi?.has(i) ?? false;
        const isDim = dim?.has(i) ?? false;
        return (
          <div
            key={i}
            onClick={onRowClick ? () => onRowClick(i) : undefined}
            className={`flex ${isHi ? "bg-accent/10" : ""} ${isDim ? "opacity-30" : ""} ${onRowClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
          >
            {r.addr !== null && (
              <span className="text-text-faint w-12 text-right pr-3 select-none">{r.addr}</span>
            )}
            <span className={isHi ? "text-accent" : "text-text"}>{r.asm}</span>
          </div>
        );
      })}
    </pre>
  );
}

function toSet(input: Set<number> | number[] | undefined): Set<number> | undefined {
  if (!input) return undefined;
  return input instanceof Set ? input : new Set(input);
}
