"use client";

import { useEffect, useMemo, useState } from "react";
import TomGate from "@/app/components/tom-gate";
import { BANK, type Depth } from "./data/types";
import {
  advance,
  effectiveDepth,
  INITIAL_STATE,
  MAX_DEPTH,
  topicsOf,
  type DepthFilter,
  type Mode,
  type QuestionsState,
} from "./lib/pick";

const USED_KEY = "questions.used";
const DEPTH_KEY = "questions.depth";

const WALK: ReadonlyArray<{ mode: Mode; label: string }> = [
  { mode: "stay", label: "stay" },
  { mode: "deeper", label: "deeper" },
  { mode: "lighten", label: "lighten" },
];

const DEPTH_CHIPS: readonly DepthFilter[] = ["auto", 1, 2, 3];

function isDepth(value: unknown): value is Depth {
  return value === 1 || value === 2 || value === 3;
}

/**
 * What survives a reload: the ids already asked, and how deep the walk had got.
 * Read after mount so the server's render and the first client render agree,
 * and wrapped because storage throws outright in a locked-down browser.
 */
function restored(): QuestionsState {
  try {
    const rawUsed = window.localStorage.getItem(USED_KEY);
    const rawDepth = Number(window.localStorage.getItem(DEPTH_KEY));
    const parsed: unknown = rawUsed === null ? [] : JSON.parse(rawUsed);
    const used = new Set<string>(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    return { ...INITIAL_STATE, used, depth: isDepth(rawDepth) ? rawDepth : 1 };
  } catch {
    // No storage, or storage holding something this page did not write.
    return INITIAL_STATE;
  }
}

function Chip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
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
  const [state, setState] = useState<QuestionsState>(INITIAL_STATE);
  const [ready, setReady] = useState(false);
  // Collapsed on every load, deliberately: the walk is the page, and the panel
  // is the exception you go looking for.
  const [propertiesOpen, setPropertiesOpen] = useState(false);

  const topics = useMemo(() => topicsOf(BANK), []);

  useEffect(() => {
    setState(advance(BANK, restored(), "stay"));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(USED_KEY, JSON.stringify([...state.used]));
      window.localStorage.setItem(DEPTH_KEY, String(state.depth));
    } catch {
      // Storage is a convenience here; the session works without it.
    }
  }, [ready, state.used, state.depth]);

  const move = (mode: Mode) => setState((previous) => advance(BANK, previous, mode));

  const filter = (filters: QuestionsState["filters"]) =>
    setState((previous) => advance(BANK, { ...previous, filters }, "filter"));

  const current = state.current;
  const atDepth = effectiveDepth(state.depth, state.filters);

  return (
    <div className="mx-auto w-full max-w-[40rem] px-6 pt-6 pb-16">
      {/* Tall enough to hold the longest question in the bank at either type
          size, so the buttons below sit at the same place from one question to
          the next. */}
      <div className="flex min-h-56 items-start sm:min-h-48">
        <p className="font-display text-2xl leading-snug text-text sm:text-3xl">
          {ready ? (current?.text ?? "Nothing left here.") : ""}
        </p>
      </div>

      <p className="mt-2 h-5 text-sm text-text-muted">
        {current === null ? "" : `${current.depth} · ${current.frame} · ${current.topic}`}
      </p>

      <div className="mt-6 grid grid-cols-3 gap-2">
        {WALK.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            onClick={() => move(mode)}
            disabled={mode === "deeper" && atDepth === MAX_DEPTH}
            className="rounded-lg border border-border bg-surface px-3 py-3 text-base text-text transition-colors hover:border-accent/50 hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <TextLink label="skip" onClick={() => move("skip")} />
      </div>

      <div className="mt-8">
        <TextLink label="properties" onClick={() => setPropertiesOpen((open) => !open)} />
        {propertiesOpen && (
          <div className="mt-4 rounded-lg border border-border bg-surface/40 p-4">
            <div className="flex flex-wrap gap-2">
              {DEPTH_CHIPS.map((chip) => (
                <Chip
                  key={String(chip)}
                  label={String(chip)}
                  selected={state.filters.depth === chip}
                  onSelect={() => filter({ ...state.filters, depth: chip })}
                />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {["any", ...topics].map((topic) => (
                <Chip
                  key={topic}
                  label={topic}
                  selected={state.filters.topic === topic}
                  onSelect={() => filter({ ...state.filters, topic })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-10 flex items-center gap-3 text-sm text-text-faint">
        <span className="tabular-nums">
          used {state.used.size} of {BANK.length}
        </span>
        <TextLink
          label="reset used"
          onClick={() => setState((previous) => ({ ...previous, used: new Set<string>() }))}
        />
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
