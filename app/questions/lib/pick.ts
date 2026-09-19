// Which questions the filters admit, and where the reader is in that list.
// Every transition on the page is an index transition here, so the page never
// has to choose or shuffle a question of its own.

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
export type KindFilter = Depth | "lighter" | null;
/** null admits every frame; anything else pins it to that frame. */
export type FrameFilter = Frame | null;
/** null admits every topic; anything else pins it to that topic. */
export type TopicFilter = string | null;

export type Filters = { kind: KindFilter; frame: FrameFilter; topic: TopicFilter };

export const KINDS: readonly KindFilter[] = [null, 1, 2, 3, "lighter"];

export const FRAMES: readonly FrameFilter[] = [null, "hypothetical", "observation", "appraisal", "value"];

export const INITIAL_FILTERS: Filters = { kind: null, frame: null, topic: null };

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

/** Every question all three filters admit, in bank order â€” the list. */
export function matches(bank: readonly Question[], filters: Filters): Question[] {
  return bank.filter((question) => admits(question, filters));
}

/**
 * The filters a patch produces, or the very object passed in when the patch
 * selects what is already selected. The page leans on that identity: a tap on
 * the chip that is already lit changes nothing, so the question stays put.
 */
export function refined(filters: Filters, patch: Partial<Filters>): Filters {
  const updated = { ...filters, ...patch };
  const unchanged =
    updated.kind === filters.kind && updated.frame === filters.frame && updated.topic === filters.topic;
  return unchanged ? filters : updated;
}

/** Every distinct topic in the bank, in bank order â€” the topic chips' row. */
export function topicsOf(bank: readonly Question[]): string[] {
  return unique(bank.map((question) => question.topic));
}

/** The kind label a question carries in the interface. */
export function kindOf(question: Question): Exclude<KindFilter, null> {
  return question.release ? "lighter" : question.depth;
}

/**
 * The index to show when a list first appears or its filters change. Keeping a
 * current id wins over unseen status; otherwise the first unseen entry starts
 * a new walk, and an exhausted list begins again from its first entry.
 */
export function startIndex(list: readonly Question[], seen: ReadonlySet<string>, currentId: string | null): number {
  if (list.length === 0) return 0;
  const currentIndex = currentId === null ? -1 : list.findIndex((question) => question.id === currentId);
  if (currentIndex >= 0) return currentIndex;
  const unseenIndex = list.findIndex((question) => !seen.has(question.id));
  return unseenIndex >= 0 ? unseenIndex : 0;
}

/**
 * One step through the list spends the question being left, in either
 * direction. A one-question list never leaves its only question, so it never
 * marks it seen; that is accepted because there is nowhere to walk to.
 */
export function stepped(
  list: readonly Question[],
  index: number,
  seen: ReadonlySet<string>,
  direction: 1 | -1,
): { index: number; seen: ReadonlySet<string> } {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= list.length) return { index, seen };
  return { index: nextIndex, seen: new Set(seen).add(list[index].id) };
}

/** Whether a step in this direction remains inside the list. */
export function canStep(list: readonly Question[], index: number, direction: 1 | -1): boolean {
  return index + direction >= 0 && index + direction < list.length;
}
