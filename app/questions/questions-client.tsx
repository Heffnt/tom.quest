"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TomGate from "@/app/components/tom-gate";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { BANK, type Question } from "./data/types";
import {
  FRAMES,
  INITIAL_FILTERS,
  KINDS,
  matches,
  next,
  refined,
  topicsOf,
  type Filters,
  type TopicFilter,
} from "./lib/pick";

/** The settings key this page owns, and the only shape it stores under it. */
const SETTINGS_KEY = "questions";
type QuestionsSettings = { seen: string[] };
const SETTINGS_DEFAULTS: QuestionsSettings = { seen: [] };

/**
 * Everything one activation moves at once. Held together rather than in three
 * states because a draw reads all three: two taps before a commit have to
 * compose, and they only can if each one starts from what the last one left.
 */
type View = { filters: Filters; seen: ReadonlySet<string>; current: Question | null };

/**
 * The view after a draw. `spend` says whether the question on screen is used up
 * by the move: next spends it, a chip does not, which is what lets you browse
 * the properties without burning through the bank.
 */
function drawn(view: View, filters: Filters, spend: boolean): View {
  const shownId = view.current?.id ?? null;
  const seen = spend && shownId !== null ? new Set(view.seen).add(shownId) : view.seen;
  return { filters, seen, current: next(BANK, filters, seen, shownId) };
}

/** The no-filter sentinel is null everywhere but here, where it reads "any". */
function chipLabel(option: unknown): string {
  return option === null ? "any" : String(option);
}

function Chip({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        selected
          ? "border-accent bg-accent-dim text-accent"
          : "border-border bg-surface text-text-muted hover:border-accent/50 hover:bg-surface-alt hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

function ChipRow<Option>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly Option[];
  selected: Option;
  onSelect: (option: Option) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-sm text-text-faint">{label}</span>
      {options.map((option) => (
        <Chip
          key={chipLabel(option)}
          label={chipLabel(option)}
          selected={selected === option}
          onSelect={() => onSelect(option)}
        />
      ))}
    </div>
  );
}

function TextLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-text-muted underline underline-offset-4 transition-colors hover:text-accent"
    >
      {label}
    </button>
  );
}

function Questions() {
  const [stored, storeSettings, hydrated] = usePersistedSettings<QuestionsSettings>(
    SETTINGS_KEY,
    SETTINGS_DEFAULTS,
  );
  const [view, setView] = useState<View>(() => ({
    filters: INITIAL_FILTERS,
    seen: new Set<string>(),
    current: null,
  }));
  const [showAll, setShowAll] = useState(false);
  // Collapsed on every load, deliberately: one question is the page, and the
  // panel is the exception you go looking for.
  const [propertiesOpen, setPropertiesOpen] = useState(false);

  const topicOptions = useMemo<readonly TopicFilter[]>(() => [null, ...topicsOf(BANK)], []);
  const matched = useMemo(() => matches(BANK, view.filters), [view.filters]);
  const seenHere = matched.filter((question) => view.seen.has(question.id)).length;

  // The set the store handed over, kept so the mirror below can tell it apart
  // from a set this page made. Seeding waits for the store: the first question
  // has to be drawn around the ids already spent, not before them.
  const seeded = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (!hydrated || seeded.current !== null) return;
    const seen = new Set(stored.seen);
    seeded.current = seen;
    setView((prev) => ({ ...prev, seen, current: next(BANK, prev.filters, seen, null) }));
  }, [hydrated, stored.seen]);

  // Every set an activation makes goes back to the store; the seeded one does
  // not, so hydration never writes its own value back over a newer one.
  useEffect(() => {
    if (seeded.current === null || view.seen === seeded.current) return;
    storeSettings({ seen: [...view.seen] });
  }, [view.seen, storeSettings]);

  const advance = () => setView((prev) => drawn(prev, prev.filters, true));

  const refine = (patch: Partial<Filters>) =>
    setView((prev) => {
      const filters = refined(prev.filters, patch);
      return filters === prev.filters ? prev : drawn(prev, filters, false);
    });

  const shown = view.current;
  const meta =
    shown !== null
      ? `${shown.depth} · ${shown.frame} · ${shown.topic}${view.seen.has(shown.id) ? " · seen" : ""}`
      : matched.length === 0
        ? "Nothing matches."
        : "";

  return (
    <div className="mx-auto w-full max-w-[40rem] px-6 pt-6 pb-16">
      {/* Tall enough to hold the longest question in the bank at either type
          size, so the button below sits at the same place from one question to
          the next. */}
      <div className="flex min-h-56 items-start sm:min-h-48">
        <p className="font-display text-2xl leading-snug text-text sm:text-3xl">{shown?.text ?? ""}</p>
      </div>

      <p className="mt-2 h-5 text-sm text-text-muted">{meta}</p>

      <button
        type="button"
        onClick={advance}
        className="mt-6 w-full rounded-lg border border-border bg-surface px-3 py-3 text-base text-text transition-colors hover:border-accent/50 hover:bg-surface-alt"
      >
        next
      </button>

      <div className="mt-4 flex items-center gap-4">
        <TextLink label="properties" onClick={() => setPropertiesOpen((open) => !open)} />
        <TextLink label={`view all ${matched.length}`} onClick={() => setShowAll((open) => !open)} />
      </div>

      <div className="mt-10 flex items-center gap-3 text-sm text-text-faint">
        <span className="tabular-nums">
          seen {seenHere} of {matched.length}
        </span>
        <TextLink
          label="reset seen"
          onClick={() => setView((prev) => ({ ...prev, seen: new Set<string>() }))}
        />
      </div>

      {/* The panel and the list come last on the page, so opening either one
          moves nothing that was already on screen. */}
      {propertiesOpen && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface/40 p-4">
          <ChipRow label="kind" options={KINDS} selected={view.filters.kind} onSelect={(kind) => refine({ kind })} />
          <ChipRow
            label="frame"
            options={FRAMES}
            selected={view.filters.frame}
            onSelect={(frame) => refine({ frame })}
          />
          <ChipRow
            label="topic"
            options={topicOptions}
            selected={view.filters.topic}
            onSelect={(topic) => refine({ topic })}
          />
        </div>
      )}

      {showAll && (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {matched.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => setView((prev) => ({ ...prev, current: question }))}
                className={`block w-full px-3 py-2 text-left text-base transition-colors hover:bg-surface-alt ${
                  view.seen.has(question.id) ? "text-text-muted" : "text-text"
                }`}
              >
                {question.text}{" "}
                <span className="text-sm text-text-faint">
                  {question.depth} · {question.frame}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function QuestionsClient() {
  // TomGate owns both gate states' JSX, so this surface cannot drift from the
  // other Tom-only ones. "Questions" is absent from convex/agentSurfaces.ts,
  // which makes canReadSurface here exactly isTom.
  return (
    <TomGate label="Questions">
      <Questions />
    </TomGate>
  );
}
