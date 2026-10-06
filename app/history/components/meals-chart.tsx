"use client";

import type { Meal } from "@/convex/historyRows";
import ChartCard from "./chart-frame";
import { labelDays, mealDays, shortDay } from "../lib";

const W = 1120;
const PAD = { left: 72, right: 14, top: 10 };
const MARK_GAP = 11;
/** Above this many days the per-day protein and calorie figures do not fit. */
const FIGURES_MAX_DAYS = 45;

function round(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Meals per day: one mark per meal, and the protein and calories he gave that day. */
export default function MealsChart({ meals, days }: { meals: Meal[]; days: string[] }) {
  const perDay = mealDays(meals, days);
  const most = Math.max(4, ...perDay.map((day) => day.meals.length));
  const marksHeight = most * MARK_GAP + 6;
  const figures = days.length <= FIGURES_MAX_DAYS && perDay.some((day) => day.proteinG !== null || day.calories !== null);
  const baseline = PAD.top + marksHeight;
  const rowProtein = baseline + 18;
  const rowCalories = baseline + 34;
  const axis = (figures ? rowCalories : baseline) + 20;
  const H = axis + 6;
  const band = (W - PAD.left - PAD.right) / Math.max(1, days.length);
  const x = (i: number) => PAD.left + (i + 0.5) * band;
  const index = new Map(days.map((day, i) => [day, i]));
  const radius = Math.max(1.5, Math.min(4, band / 3));
  const protein = perDay.reduce((sum, day) => sum + (day.proteinG ?? 0), 0);
  const total = meals.length;

  return (
    <ChartCard
      title="Meals"
      label="Meals per day"
      className="lg:col-span-2"
      figure={total === 0 ? null : `${total} ${total === 1 ? "meal" : "meals"}${protein > 0 ? ` · ${round(protein)} g protein` : ""}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Meals per day with protein and calories" className="block h-auto w-full">
        <line x1={PAD.left} x2={W - PAD.right} y1={baseline} y2={baseline} className="stroke-border" strokeWidth="1" />
        {figures && (
          <>
            <text x={PAD.left - 8} y={rowProtein + 4} textAnchor="end" className="fill-text-faint" fontSize="11">protein g</text>
            <text x={PAD.left - 8} y={rowCalories + 4} textAnchor="end" className="fill-text-faint" fontSize="11">kcal</text>
          </>
        )}
        {perDay.map((day, i) => (
          <g key={day.day} data-day={day.day} data-meals={day.meals.length}>
            {day.meals.map((meal, k) => (
              <circle
                key={meal.id}
                cx={x(i)}
                cy={baseline - 6 - k * MARK_GAP}
                r={radius}
                className={meal.proteinG !== undefined || meal.calories !== undefined ? "fill-accent" : "fill-none stroke-accent"}
                strokeWidth="1.5"
              />
            ))}
            {figures && day.proteinG !== null && (
              <text x={x(i)} y={rowProtein + 4} textAnchor="middle" className="fill-text-muted" fontSize="11">{round(day.proteinG)}</text>
            )}
            {figures && day.calories !== null && (
              <text x={x(i)} y={rowCalories + 4} textAnchor="middle" className="fill-text-muted" fontSize="11">{round(day.calories)}</text>
            )}
          </g>
        ))}
        {labelDays(days, 10).map((day) => (
          <text key={day} x={x(index.get(day)!)} y={axis} textAnchor="middle" className="fill-text-faint" fontSize="11">{shortDay(day)}</text>
        ))}
      </svg>
    </ChartCard>
  );
}
