/**
 * RAM inspector — a 16×16 grid of the 256 RAM cells, each shown as a 4-digit
 * hex value. Highlights the current PC cell (subtle bg) and the cell most
 * recently read / written this cycle (amber accents).
 */
"use client";

import type { Bits, Signals } from "./cpu";
import { toUint } from "./cpu";

type Props = {
  ram: Bits[];
  signals: Signals | null;
  pc: Bits;
};

function hex4(bits: Bits): string {
  return toUint(bits).toString(16).padStart(4, "0").toUpperCase();
}

export default function RamView({ ram, signals, pc }: Props) {
  const pcIdx = toUint(pc);

  // Active addresses this cycle: we read whatever Addr Mux emitted, and we
  // wrote whatever Ram Data pointed to iff RamWE was actually effective.
  const readIdx = signals ? toUint(signals.addr8) : -1;
  const writeIdx = signals && signals.ramWe1 === "1" ? toUint(signals.ramData8) : -1;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-text">RAM</h2>
        <span className="text-xs text-text-muted font-mono">
          256 × 16b — hex. PC cell highlighted.
        </span>
      </div>

      <div
        className="grid gap-[2px] font-mono text-[10px]"
        style={{ gridTemplateColumns: "auto repeat(16, 1fr)" }}
      >
        {/* Column header row: low nibble of address */}
        <div />
        {Array.from({ length: 16 }, (_, col) => (
          <div key={col} className="text-text-faint text-center py-0.5">
            {col.toString(16).toUpperCase()}
          </div>
        ))}

        {/* 16 rows × 16 cells. Each row starts with the high nibble. */}
        {Array.from({ length: 16 }, (_, row) => (
          <div key={`r${row}-h`} className="contents">
            <div className="text-text-faint text-right pr-2 py-0.5 flex items-center justify-end">
              {row.toString(16).toUpperCase()}
            </div>
            {Array.from({ length: 16 }, (_, col) => {
              const idx = row * 16 + col;
              const isPc = idx === pcIdx;
              const isRead = idx === readIdx;
              const isWrite = idx === writeIdx;
              const value = ram[idx];
              const isZero = value === "0000000000000000";

              // Layered highlights:
              //   write > read > pc > default
              let bg = "transparent";
              let border = "transparent";
              let color = isZero ? "var(--color-text-faint)" : "var(--color-text-muted)";

              if (isPc) {
                bg = "rgba(232, 160, 64, 0.10)";
                color = "var(--color-text)";
              }
              if (isRead) {
                border = "var(--color-accent)";
                color = "var(--color-accent)";
              }
              if (isWrite) {
                bg = "var(--color-accent)";
                color = "#0a0e17";
              }

              return (
                <div
                  key={`c${idx}`}
                  title={`0x${idx.toString(16).padStart(2, "0").toUpperCase()} = 0x${hex4(value)} (${value})`}
                  className="text-center py-0.5 rounded-[2px] border"
                  style={{
                    backgroundColor: bg,
                    borderColor: border,
                    color,
                  }}
                >
                  {hex4(value)}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-3 flex gap-4 text-xs text-text-muted">
        <span>
          <span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px]"
                style={{ backgroundColor: "rgba(232, 160, 64, 0.10)" }} />
          PC
        </span>
        <span>
          <span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px] border"
                style={{ borderColor: "var(--color-accent)" }} />
          read
        </span>
        <span>
          <span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px]"
                style={{ backgroundColor: "var(--color-accent)" }} />
          write
        </span>
      </div>
    </div>
  );
}
