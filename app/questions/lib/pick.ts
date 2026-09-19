// Which questions the properties admit, and which one comes next. Every rule
// the page has lives here, as pure functions over plain values, so each one can
// be asserted in pick.test.ts without mounting React.
//
// The page is a filter and a shuffle: `matches` is what the chips select, and
// `next` draws one question from it.

import type { Depth, Frame, Question } from "../data/types";

/**
 * "any" admits everything, release questions included; a number admits the
 * questions at that depth that are not release; "lighter" admits exactly the
 * release ones. A release question therefore has no depth to be selected by,
 * which is what makes "lighter" a kind rather than a fourth depth.
 */
export type KindFilter = "any" | Depth | "lighter";
/** "any" admits every frame; anything else pins it to that frame. */
export type FrameFilter = "any" | Frame;
/** "any" admits every topic; anything else pins it to that topic. */
export type TopicFilter = "any" | string;

export type Filters = { kind: KindFilter; frame: FrameFilter; topic: TopicFilter };

/** Injectable Math.random, so a test can pin every choice this module makes. */
export type Rng = () => number;

export const KINDS: readonly KindFilter[] = ["any", 1, 2, 3, "lighter"];

export const FRAMES: readonly FrameFilter[] = ["any", "hypothetical", "observation", "appraisal", "value"];

export const INITIAL_FILTERS: Filters = { kind: "any", frame: "any", topic: "any" };

function choose<T>(items: readonly T[], random: Rng): T {
  const index = Math.floor(random() * items.length);
  // Clamped rather than trusted: an injected rng that returns 1 would index off
  // the end, and this module must never hand the page an undefined question.
  return items[Math.min(Math.max(index, 0), items.length - 1)];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function admits(question: Question, filters: Filters): boolean {
  if (filters.kind === "lighter" && !question.release) return false;
  if (typeof filters.kind === "number" && (question.release || question.depth !== filters.kind)) return false;
  if (filters.frame !== "any" && question.frame !== filters.frame) return false;
  if (filters.topic !== "any" && question.topic !== filters.topic) return false;
  return true;
}

/** Every question all three filters admit, in bank order — the list, and the pool `next` draws from. */
export function matches(bank: readonly Question[], filters: Filters): Question[] {
  return bank.filter((question) => admits(question, filters));
}

/**
 * A question from the match set that is neither on screen nor already seen.
 *
 * Once everything matching has been seen it draws from the match set anyway:
 * running out should repeat a question, never empty the page. Only a match set
 * that is empty returns null.
 */
export function next(
  bank: readonly Question[],
  filters: Filters,
  seen: ReadonlySet<string>,
  currentId: string | null,
  random: Rng = Math.random,
): Question | null {
  const pool = matches(bank, filters);
  if (pool.length === 0) return null;

  const fresh = pool.filter((question) => question.id !== currentId && !seen.has(question.id));
  if (fresh.length > 0) return choose(fresh, random);

  const others = pool.filter((question) => question.id !== currentId);
  if (others.length > 0) return choose(others, random);

  // One match, and it is the question already on screen: hold it there rather
  // than blank a page that does have something to show.
  return pool[0];
}

/** Every distinct topic in the bank, in bank order — the topic chips' row. */
export function topicsOf(bank: readonly Question[]): string[] {
  return unique(bank.map((question) => question.topic));
}
