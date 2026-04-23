/**
 * Program editor — a monospace textarea for hand-encoded 16-bit strings.
 *
 * Format: one instruction per line, e.g.
 *
 *     0011000000000101   // loadn 5
 *     0100000000010101   // store 21
 *
 * Lines may have inline `//` or `#` comments and arbitrary whitespace within
 * the 16 significant bits; parsing collapses internal spaces before checking
 * the length. Blank lines are skipped.
 */
"use client";

import { useMemo } from "react";
import type { Bits } from "./cpu";

type ParseOk = { ok: true; program: Bits[] };
type ParseErr = { ok: false; line: number; message: string };
export type ParseResult = ParseOk | ParseErr;

/**
 * Parse the source text into a list of 16-bit strings. On error, returns
 * the (1-based) line number and a short message.
 */
export function parseProgram(source: string): ParseResult {
  const lines = source.split("\n");
  const program: Bits[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Strip comments and whitespace. Everything left must be 16 bits.
    let line = lines[i];
    const cut = Math.min(
      line.indexOf("//") === -1 ? Infinity : line.indexOf("//"),
      line.indexOf("#") === -1 ? Infinity : line.indexOf("#"),
    );
    if (Number.isFinite(cut)) line = line.slice(0, cut);
    const cleaned = line.replace(/\s+/g, "");
    if (cleaned.length === 0) continue;

    if (cleaned.length !== 16) {
      return {
        ok: false,
        line: i + 1,
        message: `expected 16 bits, got ${cleaned.length} ("${cleaned}")`,
      };
    }
    for (const c of cleaned) {
      if (c !== "0" && c !== "1") {
        return {
          ok: false,
          line: i + 1,
          message: `non-bit character: "${c}"`,
        };
      }
    }
    program.push(cleaned);
  }

  return { ok: true, program };
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  onReload: () => void;
};

export default function ProgramEditor({ value, onChange, onReload }: Props) {
  // Parse on every render so the user sees errors live. Cheap — programs are
  // at most a few hundred lines.
  const parse = useMemo(() => parseProgram(value), [value]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-text">Program</h2>
        <span className="text-xs text-text-muted font-mono">
          {parse.ok ? `${parse.program.length} words` : "error"}
        </span>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="flex-1 min-h-[280px] w-full bg-surface border border-border rounded-md p-3
                   font-mono text-xs text-text resize-none outline-none
                   focus:border-accent/60"
      />

      <div className="flex items-center justify-between mt-2">
        {parse.ok ? (
          <span className="text-xs text-text-muted">
            Parses cleanly. Click Reload to load into RAM and reset.
          </span>
        ) : (
          <span className="text-xs text-error font-mono">
            line {parse.line}: {parse.message}
          </span>
        )}
        <button
          onClick={onReload}
          disabled={!parse.ok}
          className="px-3 py-1 text-xs font-mono rounded border border-border
                     text-text-muted hover:text-text hover:border-accent/60
                     disabled:opacity-40 disabled:hover:text-text-muted
                     disabled:hover:border-border transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
