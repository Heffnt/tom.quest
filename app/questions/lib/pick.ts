// Which question comes next. Every rule the page has lives here, as plain
// functions over plain state, so each one can be asserted in pick.test.ts
// without mounting React.
//
// The page is a walk: each answer moves you along by staying at this depth,
// going deeper, or lightening. `pick` chooses the question that move lands on;
// `advance` is the whole move — it marks what a walk used up, then picks.

import type { Depth, Question } from "../data/types";

/** "auto" lets the walk decide the depth; a number pins it. */
export type DepthFilter = Depth | "auto";
/** "any" leaves the topic to rotation; anything else pins it to that topic. */
export type TopicFilter = string;

export type Filters = { depth: DepthFilter; topic: TopicFilter };

export type QuestionsState = {
  current: Question | null;
  depth: Depth;
  /** Ids already asked. Cheap to rebuild, so it is cleared without a confirm. */
  used: ReadonlySet<string>;
  /** Ids served this session, oldest first. Only rotation reads it. */
  history: readonly string[];
  filters: Filters;
};

export type Mode = "stay" | "deeper" | "lighten" | "skip" | "filter";

/** Injectable Math.random, so a test can pin every choice this module makes. */
export type Rng = () => number;

export type Pick = { question: Question | null; depth: Depth };

export const MAX_DEPTH: Depth = 3;

export const INITIAL_STATE: QuestionsState = {
  current: null,
  depth: 1,
  used: new Set<string>(),
  history: [],
  filters: { depth: "auto", topic: "any" },
};

/** The three moves that spend the question on screen. "skip" and "filter" do not. */
const MARKS_USED: ReadonlySet<Mode> = new Set<Mode>(["stay", "deeper", "lighten"]);

function choose<T>(items: readonly T[], random: Rng): T {
  const index = Math.floor(random() * items.length);
  // Clamped rather than trusted: an injected rng that returns 1 would index off
  // the end, and this module must never hand the page an undefined question.
  return items[Math.min(Math.max(index, 0), items.length - 1)];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The depth the move itself asks for, before any filter has its say. */
function walkedDepth(state: QuestionsState, mode: Mode): Depth {
  if (mode !== "deeper") return state.depth;
  return Math.min(state.depth + 1, MAX_DEPTH) as Depth;
}

/** The depth actually picked at: a pinned filter overrides the walk. */
export function effectiveDepth(depth: Depth, filters: Filters): Depth {
  return filters.depth === "auto" ? depth : filters.depth;
}

/**
 * The latest position in `history` holding a question that `matches`, or -1 for
 * one never served — which is what makes a never-served topic rank first, since
 * -1 is lower than every real position.
 */
function lastServed(
  history: readonly string[],
  byId: ReadonlyMap<string, Question>,
  matches: (question: Question) => boolean,
): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const served = byId.get(history[i]);
    if (served !== undefined && matches(served)) return i;
  }
  return -1;
}

/**
 * The value served longest ago. Ties go to the rng — which in practice only
 * happens among values never served at all, since two different values cannot
 * share one position in history.
 */
function leastRecent<T>(values: readonly T[], position: (value: T) => number, random: Rng): T {
  let earliest = Infinity;
  let tied: T[] = [];
  for (const value of values) {
    const at = position(value);
    if (at < earliest) {
      earliest = at;
      tied = [value];
    } else if (at === earliest) {
      tied.push(value);
    }
  }
  return choose(tied, random);
}

/**
 * The next question for `mode`, plus the depth the move leaves you at.
 *
 * The pool is everything the move admits, minus what is used and minus the
 * question on screen. Exhausting it falls back to ignoring `used` — running out
 * should repeat a question, never end the page — and only a pool that is empty
 * even then returns null.
 */
export function pick(
  bank: readonly Question[],
  state: QuestionsState,
  mode: Mode,
  random: Rng = Math.random,
): Pick {
  const depth = walkedDepth(state, mode);
  const wanted = effectiveDepth(depth, state.filters);
  const byId = new Map(bank.map((question) => [question.id, question] as const));

  const eligible = (question: Question, ignoreUsed: boolean): boolean => {
    if (question.id === state.current?.id) return false;
    if (!ignoreUsed && state.used.has(question.id)) return false;
    // "lighten" is the release valve: it reads neither depth nor topic, which
    // is the point of it — it exists to leave wherever the walk has got to.
    if (mode === "lighten") return question.release;
    if (question.release) return false;
    if (question.depth !== wanted) return false;
    return state.filters.topic === "any" || question.topic === state.filters.topic;
  };

  let pool = bank.filter((question) => eligible(question, false));
  if (pool.length === 0) pool = bank.filter((question) => eligible(question, true));
  if (pool.length === 0) return { question: null, depth };
  if (mode === "lighten") return { question: choose(pool, random), depth };

  // Topic first, then frame: two questions in a row about the same thing, or
  // asked the same way, read as an interrogation rather than a conversation.
  // Frame recency is measured across the whole history, not only within the
  // chosen topic, because a repeated frame is audible whatever it is about.
  const topic = leastRecent(
    unique(pool.map((question) => question.topic)),
    (candidate) => lastServed(state.history, byId, (question) => question.topic === candidate),
    random,
  );
  const inTopic = pool.filter((question) => question.topic === topic);
  const frame = leastRecent(
    unique(inTopic.map((question) => question.frame)),
    (candidate) => lastServed(state.history, byId, (question) => question.frame === candidate),
    random,
  );
  return { question: choose(inTopic.filter((question) => question.frame === frame), random), depth };
}

/**
 * One whole move: a walk spends the question on screen before picking, a skip
 * or a filter change does not, and whatever is served joins the history that
 * rotation reads.
 */
export function advance(
  bank: readonly Question[],
  state: QuestionsState,
  mode: Mode,
  random: Rng = Math.random,
): QuestionsState {
  const used =
    MARKS_USED.has(mode) && state.current !== null
      ? new Set(state.used).add(state.current.id)
      : state.used;
  const spent: QuestionsState = { ...state, used };
  const { question, depth } = pick(bank, spent, mode, random);
  return {
    ...spent,
    depth,
    current: question,
    history: question === null ? state.history : [...state.history, question.id],
  };
}

/** Every distinct topic in the bank, in bank order — the topic chips' row. */
export function topicsOf(bank: readonly Question[]): string[] {
  return unique(bank.map((question) => question.topic));
}
