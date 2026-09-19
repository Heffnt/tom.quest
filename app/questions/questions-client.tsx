"use client";

import { useEffect, useMemo, useState } from "react";
import TomGate from "@/app/components/tom-gate";
import { BANK, type Question } from "./data/types";
import {
  FRAMES,
  INITIAL_FILTERS,
  KINDS,
  matches,
  next,
  topicsOf,
  type Filters,
  type KindFilter,
} from "./lib/pick";

const SEEN_KEY = "questions.seen";
/** Keys the depth walk wrote, cleared on arrival so no stale walk survives it. */
const RETIRED_KEYS = ["questions.used", "questions.depth"];

/**
 * What survives a reload: the ids already asked. Read after mount so the
 * server's render and the first client render agree, and wrapped because
 * storage throws outright in a locked-down browser.
 */
function restored(): Set<string> {
  try {
    for (const key of RETIRED_KEYS) window.localStorage.removeItem(key);
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    // No storage, or storage holding something this page did not write.
    return new Set<string>();
  }
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

function ChipRow({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly (string | number)[];
  selected: string | number;
  onSelect: (option: string | number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-sm text-text-faint">{label}</span>
      {options.map((option) => (
        <Chip
          key={String(option)}
          label={String(option)}
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
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [current, setCurrent] = useState<Question | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [showAll, setShowAll] = useState(false);
  const [ready, setReady] = useState(false);
  // Collapsed on every load, deliberately: one question is the page, and the
  // panel is the exception you go looking for.
  const [propertiesOpen, setPropertiesOpen] = useState(false);

  const topics = useMemo(() => topicsOf(BANK), []);
  const matched = useMemo(() => matches(BANK, filters), [filters]);
  const seenHere = matched.filter((question) => seen.has(question.id)).length;

  useEffect(() => {
    const stored = restored();
    setSeen(stored);
    setCurrent(next(BANK, INITIAL_FILTERS, stored, null));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
    } catch {
      // Storage is a convenience here; the session works without it.
    }
  }, [ready, seen]);

  // Next spends the question on screen; a chip does not, which is what lets you
  // browse the properties without burning through the bank.
  const advance = () => {
    const spent = new Set(seen);
    if (current !== null) spent.add(current.id);
    setSeen(spent);
    setCurrent(next(BANK, filters, spent, current?.id ?? null));
  };

  const refine = (patch: Partial<Filters>) => {
    const updated = { ...filters, ...patch };
    setFilters(updated);
    setCurrent(next(BANK, updated, seen, current?.id ?? null));
  };

  return (
    <div className="mx-auto w-full max-w-[40rem] px-6 pt-6 pb-16">
      {/* Tall enough to hold the longest question in the bank at either type
          size, so the button below sits at the same place from one question to
          the next. */}
      <div className="flex min-h-56 items-start sm:min-h-48">
        <p className="font-display text-2xl leading-snug text-text sm:text-3xl">{ready ? (current?.text ?? "") : ""}</p>
      </div>

      <p className="mt-2 h-5 text-sm text-text-muted">
        {!ready ? "" : current === null ? "Nothing matches." : `${current.depth} · ${current.frame} · ${current.topic}`}
      </p>

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

      {propertiesOpen && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface/40 p-4">
          <ChipRow
            label="kind"
            options={KINDS as readonly (string | number)[]}
            selected={filters.kind}
            onSelect={(option) => refine({ kind: option as KindFilter })}
          />
          <ChipRow
            label="frame"
            options={FRAMES}
            selected={filters.frame}
            onSelect={(option) => refine({ frame: option as Filters["frame"] })}
          />
          <ChipRow
            label="topic"
            options={["any", ...topics]}
            selected={filters.topic}
            onSelect={(option) => refine({ topic: String(option) })}
          />
        </div>
      )}

      {showAll && (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {matched.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => setCurrent(question)}
                className={`block w-full px-3 py-2 text-left text-base transition-colors hover:bg-surface-alt ${
                  seen.has(question.id) ? "text-text-muted" : "text-text"
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

      <div className="mt-10 flex items-center gap-3 text-sm text-text-faint">
        <span className="tabular-nums">
          seen {seenHere} of {matched.length}
        </span>
        <TextLink label="reset seen" onClick={() => setSeen(new Set<string>())} />
      </div>
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
