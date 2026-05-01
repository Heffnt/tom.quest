/**
 * Output panel — surfaces the answer the program is computing as a single
 * focused readout. Each named output variable from the active scenario is
 * shown with its current RAM value. ASCII-mode scenarios (Caesar) collapse
 * the list into a single decoded string so the audience watches the
 * plaintext form letter by letter.
 *
 * Cells whose RAM value has changed since reset render in accent. Empty
 * cells (still 0) render dimmed.
 */
"use client";

import type { Bits } from "../cpu";
import { toUint } from "../cpu";
import type { VarBinding } from "../thcc";
import type { Scenario } from "../scenarios";

type Props = {
  scenario: Scenario;
  varMap: VarBinding[];
  ram: Bits[];
};

export default function OutputPanel({ scenario, varMap, ram }: Props) {
  const cells = scenario.outputs
    .map(name => {
      const v = varMap.find(b => b.name === name);
      if (!v) return null;
      return { name, addr: v.addr, value: ram[v.addr] };
    })
    .filter((c): c is { name: string; addr: number; value: Bits } => c !== null);

  if (cells.length === 0) return null;

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">Output</div>
          <div className="text-xs text-text-muted">
            {scenario.asAscii
              ? "Decoded plaintext, byte by byte."
              : cells.length === 1
                ? `Final value of ${cells[0].name}.`
                : `Final values of ${cells.map(c => c.name).join(", ")}.`}
          </div>
        </div>
      </div>

      {scenario.asAscii ? (
        <AsciiStrip cells={cells} />
      ) : (
        <ValueGrid cells={cells} />
      )}
    </div>
  );
}

function ValueGrid({
  cells,
}: {
  cells: { name: string; addr: number; value: Bits }[];
}) {
  return (
    <div className="font-mono text-sm grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-1">
      <div className="text-text-faint text-xs uppercase tracking-wide">var</div>
      <div className="text-text-faint text-xs uppercase tracking-wide">addr</div>
      <div className="text-text-faint text-xs uppercase tracking-wide">value</div>
      {cells.map(c => {
        const filled = c.value !== "0000000000000000";
        const sint = toSint16(c.value);
        return (
          <div key={c.name} className="contents">
            <div className={filled ? "text-accent" : "text-text-muted"}>{c.name}</div>
            <div className={filled ? "text-text" : "text-text-faint"}>
              0x{c.addr.toString(16).padStart(2, "0").toUpperCase()}
            </div>
            <div className={filled ? "text-accent text-lg" : "text-text-faint text-lg"}>
              {sint}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AsciiStrip({
  cells,
}: {
  cells: { name: string; addr: number; value: Bits }[];
}) {
  return (
    <div className="font-mono">
      <div className="flex flex-wrap gap-1.5 mb-3">
        {cells.map(c => {
          const code = toUint(c.value) & 0xff;
          const filled = code !== 0;
          const ch = printableOrDot(code);
          return (
            <div
              key={c.name}
              className={`w-9 h-12 flex flex-col items-center justify-center rounded border ${
                filled
                  ? "border-accent bg-accent/10"
                  : "border-white/10 bg-white/[0.02]"
              }`}
              title={`${c.name} = RAM[0x${c.addr.toString(16).padStart(2, "0").toUpperCase()}] = ${code}`}
            >
              <span className={`text-2xl ${filled ? "text-accent" : "text-text-faint"}`}>
                {ch}
              </span>
              <span className={`text-[9px] ${filled ? "text-text-muted" : "text-text-faint"}`}>
                {code || "·"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-sm text-text-muted">
        Decoded:{" "}
        <span className="text-accent text-lg font-bold tracking-wide">
          {cells.map(c => printableOrDot(toUint(c.value) & 0xff)).join("")}
        </span>
      </div>
    </div>
  );
}

function printableOrDot(code: number): string {
  if (code === 32) return "␣";
  if (code >= 33 && code <= 126) return String.fromCharCode(code);
  return "·";
}

function toSint16(bits: Bits): number {
  const u = toUint(bits);
  return u >= 0x8000 ? u - 0x10000 : u;
}
