// lib.ts — the arithmetic behind the /history charts: weeks, per-day totals,
// axis ticks. Pure, so the render tests and the charts share it.
import { addDays, displayDayKey } from "@/shared/clock.mjs";
import type { Meal, Training, Weight } from "@/convex/historyRows";

/** The body parts in the order the day log names them; any other sorts after. */
export const BODY_PART_ORDER = [
  "fingers", "forearms", "biceps", "back", "shoulders", "chest", "triceps",
  "core", "hips", "quads", "hamstrings", "calves", "ankles", "full-body",
] as const;

/** One colour per body part, fixed, so a part keeps its colour across ranges. */
const PART_COLORS = [
  "#e8a040", "#5fa8d3", "#9b7fd4", "#4fbf8f", "#d46a6a", "#d4c25f", "#6ad4cf",
  "#c27fd4", "#7f9bd4", "#d48f5f", "#8fd45f", "#d45fa0", "#a3a3a3", "#e2e8f0",
];

export function partColor(part: string): string {
  const index = (BODY_PART_ORDER as readonly string[]).indexOf(part);
  if (index >= 0) return PART_COLORS[index]!;
  let hash = 0;
  for (const char of part) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PART_COLORS[hash % PART_COLORS.length]!;
}

export function partLabel(part: string): string {
  return part.replaceAll("_", " ");
}

/** The Monday on or before a calendar day. */
export function weekOf(day: string): string {
  const weekday = new Date(Date.parse(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** "Oct 4" for a calendar day. */
export function shortDay(day: string): string {
  return displayDayKey(day).slice(4);
}

/** A training session's parts for the weekly bars: its body parts, else its activity. */
export function partsOf(training: Training): string[] {
  if (training.bodyParts.length > 0) return training.bodyParts;
  return [training.activity ?? "unspecified"];
}

export type TrainingWeek = { week: string; parts: Array<{ part: string; sessions: number }>; total: number };

/** Every week the days touch, oldest first, with sessions per body part. */
export function trainingWeeks(trainings: Training[], days: string[]): TrainingWeek[] {
  const weeks = [...new Set(days.map(weekOf))];
  const counts = new Map(weeks.map((week) => [week, new Map<string, number>()]));
  for (const training of trainings) {
    const parts = counts.get(weekOf(training.day));
    if (parts === undefined) continue;
    for (const part of new Set(partsOf(training))) parts.set(part, (parts.get(part) ?? 0) + 1);
  }
  return weeks.map((week) => {
    const parts = [...counts.get(week)!.entries()]
      .sort(([a], [b]) => partRank(a) - partRank(b) || a.localeCompare(b))
      .map(([part, sessions]) => ({ part, sessions }));
    return { week, parts, total: parts.reduce((sum, part) => sum + part.sessions, 0) };
  });
}

function partRank(part: string): number {
  const index = (BODY_PART_ORDER as readonly string[]).indexOf(part);
  return index < 0 ? BODY_PART_ORDER.length : index;
}

/** The parts present in a set of weeks, in their fixed order. */
export function partsPresent(weeks: TrainingWeek[]): string[] {
  const seen = new Set(weeks.flatMap((week) => week.parts.map((part) => part.part)));
  return [...seen].sort((a, b) => partRank(a) - partRank(b) || a.localeCompare(b));
}

export type MealDay = { day: string; meals: Meal[]; proteinG: number | null; calories: number | null };

/** Each day's meals, and the protein and calories he gave that day (null when he gave none). */
export function mealDays(meals: Meal[], days: string[]): MealDay[] {
  const byDay = new Map(days.map((day) => [day, [] as Meal[]]));
  for (const meal of meals) byDay.get(meal.day)?.push(meal);
  return days.map((day) => {
    const list = byDay.get(day)!;
    const protein = list.filter((meal) => meal.proteinG !== undefined);
    const calories = list.filter((meal) => meal.calories !== undefined);
    return {
      day,
      meals: list,
      proteinG: protein.length === 0 ? null : protein.reduce((sum, meal) => sum + meal.proteinG!, 0),
      calories: calories.length === 0 ? null : calories.reduce((sum, meal) => sum + meal.calories!, 0),
    };
  });
}

export type WeightDay = { day: string; lb: number; readings: number };

/** One point per day he weighed in: that day's mean. A day with none has no point. */
export function weightDays(weights: Weight[]): WeightDay[] {
  const byDay = new Map<string, number[]>();
  for (const weight of weights) byDay.set(weight.day, [...(byDay.get(weight.day) ?? []), weight.lb]);
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({ day, lb: values.reduce((sum, value) => sum + value, 0) / values.length, readings: values.length }));
}

/** Round axis ticks covering [low, high], about `count` of them. */
export function niceTicks(low: number, high: number, count = 4): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [];
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= raw) ?? 10 * magnitude;
  const first = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= high + step * 0.5; tick += step) ticks.push(Number(tick.toFixed(6)));
  if (ticks.at(-1)! < high) ticks.push(Number((ticks.at(-1)! + step).toFixed(6)));
  return ticks;
}

/** At most `count` evenly spaced labels from a list of days, always the first and last. */
export function labelDays(days: string[], count = 6): string[] {
  if (days.length <= count) return days;
  const step = (days.length - 1) / (count - 1);
  return [...new Set(Array.from({ length: count }, (_, i) => days[Math.round(i * step)]!))];
}

export type RangePreset = { label: string; days: number };

export const RANGE_PRESETS: RangePreset[] = [
  { label: "7 days", days: 7 },
  { label: "4 weeks", days: 28 },
  { label: "13 weeks", days: 91 },
  { label: "1 year", days: 365 },
];

export function presetRange(today: string, days: number): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}
