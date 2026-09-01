"use client";

// The one progress visual for a batch: one segment per plan step, in plan
// order. Color says whose step it is (amber = Tom, green = agent), fill says
// done. Todos are end states and resolve late; the plan is what moves
// linearly, so the plan is what the bar shows.
import type { PlanStep } from "../lib";

export function planProgress(plan: PlanStep[] | undefined): {
  done: number;
  total: number;
} {
  const steps = plan ?? [];
  return {
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
  };
}

export function nextStep(plan: PlanStep[] | undefined): PlanStep | null {
  return (plan ?? []).find((s) => s.status === "open") ?? null;
}

export default function PlanBar({ plan }: { plan: PlanStep[] | undefined }) {
  const steps = plan ?? [];
  if (steps.length === 0) return null;
  return (
    <span className="inline-flex gap-[2px]">
      {steps.map((s, i) => {
        const cls =
          s.status === "done"
            ? s.actor === "tom"
              ? "bg-accent"
              : "bg-success/70"
            : s.actor === "tom"
              ? "bg-accent/25"
              : "bg-surface-alt";
        return <span key={i} className={`h-1.5 w-2.5 rounded-[2px] ${cls}`} />;
      })}
    </span>
  );
}
