// Which questions the properties admit, and which one comes next. Every rule
// the page has lives here, as pure functions over plain values, so each one can
// be asserted in pick.test.ts without mounting React.
//
// The page is a filter and a shuffle: `matches` is what the chips select, and
// `next` draws one question from it.

import type { Depth, Frame, Question } from "../data/types";

// No filter is null throughout, never a reserved string: a topic is whatever
// the bank calls it, so a sentinel drawn from the same alphabet would collide
// with a topic named after it. The chip for null is labelled "any" on screen,
// and that label exists only there.

/**
 * null admits everything, release questions included; a number admits the
 * questions at that depth that are not release; "lighter" admits exactly the
 * release ones. A release question therefore has no depth to be selected by,
 * which is what makes "lighter" a kind rather than a fourth depth.
 */
type KindFilter = Depth | "lighter" | null;
/** null admits every frame; anything else pins it to that frame. */
type FrameFilter = Frame | null;
/** null admits every topic; anything else pins it to that topic. */
export type TopicFilter = string | null;

export type Filters = { kind: KindFilter; frame: FrameFilter; topic: TopicFilter };

/** Injectable Math.random, so a test can pin every choice this module makes. */
export type Rng = () => number;

export const KINDS: readonly KindFilter[] = [null, 1, 2, 3, "lighter"];

export const FRAMES: readonly FrameFilter[] = [null, "hypothetical", "observation", "appraisal", "value"];

export const INITIAL_FILTERS: Filters = { kind: null, frame: null, topic: null };

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
  if (filters.frame !== null && question.frame !== filters.frame) return false;
  if (filters.topic !== null && question.topic !== filters.topic) return false;
  return true;
}

/** Every question all three filters admit, in bank order — the list, and the pool `next` draws from. */
export function matches(bank: readonly Question[], filters: Filters): Question[] {
  return bank.filter((question) => admits(question, filters));
}

/**
 * The filters a patch produces, or the very object passed in when the patch
 * selects what is already selected. The page leans on that identity: a tap on
 * the chip that is already lit changes nothing, so it must not spend a draw
 * and swap the question out from under the reader.
 */
export function refined(filters: Filters, patch: Partial<Filters>): Filters {
  const updated = { ...filters, ...patch };
  const unchanged =
    updated.kind === filters.kind && updated.frame === filters.frame && updated.topic === filters.topic;
  return unchanged ? filters : updated;
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

  const others = pool.filter((question) => question.id !== currentId);
  const fresh = others.filter((question) => !seen.has(question.id));
  if (fresh.length > 0) return choose(fresh, random);
  if (others.length > 0) return choose(others, random);

  // One match, and it is the question already on screen: hold it there rather
  // than blank a page that does have something to show.
  return pool[0];
}

/** Every distinct topic in the bank, in bank order — the topic chips' row. */
export function topicsOf(bank: readonly Question[]): string[] {
  return unique(bank.map((question) => question.topic));
}
