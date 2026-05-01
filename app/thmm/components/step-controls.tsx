/**
 * Step controls used by the Parse and Codegen scenes. Combines a slider
 * (drag to scrub through the steps) with discrete back / forward / reset /
 * jump-to-end buttons.
 */
"use client";

type Props = {
  /** How many steps have been advanced (0..total). */
  value: number;
  /** Total number of steps available. */
  total: number;
  /** Update the visible count. */
  onChange: (next: number) => void;
  /** Optional label for the unit being stepped, e.g. "statement". */
  unit?: string;
  /** Optional extra info shown on the right (e.g. emitted-instruction count). */
  rightSlot?: React.ReactNode;
};

export default function StepControls({
  value, total, onChange, unit = "step", rightSlot,
}: Props) {
  const atStart = value <= 0;
  const atEnd = value >= total;

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-3 flex items-center gap-3 flex-wrap">
      <button
        onClick={() => onChange(0)}
        disabled={atStart}
        className="px-2 py-1 text-xs rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
        title="Reset"
      >
        ⏮
      </button>
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={atStart}
        className="px-2 py-1 text-xs rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
        title="Step back"
      >
        ◀
      </button>
      <button
        onClick={() => onChange(Math.min(total, value + 1))}
        disabled={atEnd}
        className="px-2 py-1 text-xs rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
        title="Step forward"
      >
        ▶
      </button>
      <button
        onClick={() => onChange(total)}
        disabled={atEnd}
        className="px-2 py-1 text-xs rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
        title="Jump to end"
      >
        ⏭
      </button>

      <div className="flex items-center gap-2 flex-1 min-w-[12rem]">
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="flex-1"
        />
        <div className="text-xs text-text-muted font-mono whitespace-nowrap">
          {value} / {total} {unit}{total === 1 ? "" : "s"}
        </div>
      </div>

      {rightSlot && (
        <div className="text-xs text-text-muted ml-auto">{rightSlot}</div>
      )}
    </div>
  );
}
