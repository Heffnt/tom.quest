/**
 * Transport controls for the simulator: step, play / pause, reset, and a
 * speed slider. The parent owns the animation loop; this component just
 * emits intents.
 */
"use client";

type Props = {
  running: boolean;
  halted: boolean;
  cycle: number;
  speed: number;              // index into SPEEDS
  onStep: () => void;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeed: (i: number) => void;
};

/**
 * Log-ish speed scale — values are ticks per second. The last entry (`0`)
 * is the "Max" sentinel: the loop uses requestAnimationFrame and ticks as
 * fast as the browser will render.
 */
export const SPEEDS = [1, 2, 4, 8, 16, 32, 60, 0] as const;

export function speedLabel(i: number): string {
  const v = SPEEDS[i];
  return v === 0 ? "Max" : `${v} Hz`;
}

export default function Controls({
  running,
  halted,
  cycle,
  speed,
  onStep,
  onPlay,
  onPause,
  onReset,
  onSpeed,
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-text">Controls</h2>
        <span className="text-xs text-text-muted font-mono">
          cycle {cycle}
          {halted && <span className="ml-2 text-error">HALT</span>}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onStep} disabled={halted} primary={!running && !halted}>
          Step
        </Button>
        {running ? (
          <Button onClick={onPause}>Pause</Button>
        ) : (
          <Button onClick={onPlay} disabled={halted} primary={!halted}>
            Play
          </Button>
        )}
        <Button onClick={onReset}>Reset</Button>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs text-text-muted font-mono">speed</label>
        <input
          type="range"
          min={0}
          max={SPEEDS.length - 1}
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-xs font-mono text-text w-12 text-right">
          {speedLabel(speed)}
        </span>
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const base = "px-3 py-1 text-xs font-mono rounded border transition-colors";
  const style = primary
    ? "border-accent/60 text-accent hover:border-accent"
    : "border-border text-text-muted hover:text-text hover:border-accent/60";
  const dis = "disabled:opacity-40 disabled:hover:text-text-muted disabled:hover:border-border";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${style} ${dis}`}
    >
      {children}
    </button>
  );
}
