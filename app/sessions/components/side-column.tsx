"use client";

// One side column of the sessions page: a heading with its collapse control,
// a drag handle on the edge facing the center, and its body scrolling on its
// own. Collapsed, it is a narrow strip holding the control that opens it.

import { useResizable } from "@/app/boolback/lib/use-resizable";

export default function SideColumn({
  side,
  title,
  open,
  width,
  min,
  max,
  onToggle,
  onResize,
  children,
}: {
  side: "left" | "right";
  title: string;
  open: boolean;
  width: number;
  min: number;
  max: number;
  onToggle: () => void;
  onResize: (width: number) => void;
  children: React.ReactNode;
}) {
  // The handle sits on the column's inner edge: the left column's right edge
  // grows it when dragged right, the right column's left edge when dragged left.
  const { size, handleProps } = useResizable({
    size: width,
    min,
    max,
    edge: side === "left" ? "right" : "left",
    onCommit: onResize,
  });
  const border = side === "left" ? "border-r" : "border-l";
  const inward = side === "left" ? "‹" : "›";
  const outward = side === "left" ? "›" : "‹";

  if (!open) {
    return (
      <div className={`shrink-0 w-8 ${border} border-border flex flex-col items-center py-2`}>
        <button
          type="button"
          aria-label={`open ${title}`}
          onClick={onToggle}
          className="rounded px-1.5 py-0.5 text-sm text-text-muted hover:bg-surface-alt hover:text-text"
        >
          {outward}
        </button>
      </div>
    );
  }

  const handle = (
    <div
      {...handleProps}
      aria-label={`resize ${title}`}
      className="w-1 shrink-0 bg-border hover:bg-accent/50 active:bg-accent/70"
    />
  );

  return (
    <>
      {side === "right" && handle}
      <aside
        aria-label={title}
        style={{ width: size }}
        className="shrink-0 min-w-0 flex flex-col bg-surface/30"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-faint">{title}</h2>
          <button
            type="button"
            aria-label={`collapse ${title}`}
            onClick={onToggle}
            className="rounded px-1.5 py-0.5 text-sm text-text-muted hover:bg-surface-alt hover:text-text"
          >
            {inward}
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </aside>
      {side === "left" && handle}
    </>
  );
}
