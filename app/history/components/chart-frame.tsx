"use client";

import type { ReactNode } from "react";

/** One chart's card: its title, a figure on the right of the title, and the chart. */
export default function ChartCard({ title, figure, label, children, className = "" }: {
  title: string;
  figure?: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={`rounded-lg border border-border bg-surface/40 p-3 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        {figure !== undefined && <div className="text-sm tabular-nums text-text-muted">{figure}</div>}
      </div>
      {children}
    </section>
  );
}
