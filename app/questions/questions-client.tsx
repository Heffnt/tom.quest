"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import TomGate from "@/app/components/tom-gate";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import Info from "@/app/tts/components/info";
import Drawer, { type DrawerContent } from "./components/drawer";
import { BANK } from "./data/types";
import {
  FRAMES,
  INITIAL_FILTERS,
  KINDS,
  canStep,
  kindOf,
  matches,
  refined,
  startIndex,
  stepped,
  topicsOf,
  type Filters,
  type FrameFilter,
  type KindFilter,
  type TopicFilter,
} from "./lib/pick";

/** The settings key this page owns, and the only shape it stores under it. */
const SETTINGS_KEY = "questions";
type QuestionsSettings = { seen: string[] };
const SETTINGS_DEFAULTS: QuestionsSettings = { seen: [] };

/** The options, seen ids and position always change together. */
type View = { filters: Filters; seen: ReadonlySet<string>; index: number };

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
      className={`rounded-full border px-3 py-2 text-sm transition-colors ${
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
  info,
}: {
  label: ReactNode;
  options: readonly Option[];
  selected: Option;
  onSelect: (option: Option) => void;
  info?: (option: Option) => ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label}
      {options.map((option) => (
        <span key={chipLabel(option)} className="inline-flex items-center gap-0.5">
          <Chip label={chipLabel(option)} selected={selected === option} onSelect={() => onSelect(option)} />
          {info?.(option)}
        </span>
      ))}
    </div>
  );
}

function TextLink({
  label,
  onClick,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center py-2 text-sm text-text-muted underline underline-offset-4 transition-colors hover:text-accent"
    >
      {label}
    </button>
  );
}

function kindInfo(kind: KindFilter) {
  const details: Record<Exclude<KindFilter, null>, string> = {
    1: "Admits only questions whose answer is a taste: a preference carried by a scenario. Lighter questions are left out.",
    2: "Admits only questions whose answer is an admission: something unresolved, wanted or loved, said directly. Lighter questions are left out.",
    3: "Admits only questions whose answer is a position: what she believes about love, family, humour, or what a close person should know. Lighter questions are left out.",
    lighter:
      "Admits only the lighter questions, the ones that end a run at the current depth; they carry no depth to be selected by.",
  };
  const callValue = kind === null ? "null" : kind === "lighter" ? '"lighter"' : String(kind);
  return (
    <Info side="below" call={`matches(BANK, { ...filters, kind: ${callValue} })`}>
      {kind === null
        ? "Admits every question, the lighter ones included; kind no longer narrows the list."
        : details[kind]}
    </Info>
  );
}

function frameInfo(frame: FrameFilter) {
  const details: Record<Exclude<FrameFilter, null>, string> = {
    hypothetical: "Admits only questions that put a scenario or a constrained choice.",
    observation: "Admits only questions that ask about a small personal habit.",
    appraisal: "Admits only questions that ask for a real positive feeling about a real thing in her life.",
    value: "Admits only questions that ask for a position or a belief.",
  };
  const callValue = frame === null ? "null" : `"${frame}"`;
  return (
    <Info side="below" call={`matches(BANK, { ...filters, frame: ${callValue} })`}>
      {frame === null ? "Admits every frame; frame no longer narrows the list." : details[frame]}
    </Info>
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
    index: 0,
  }));
  const [drawerContent, setDrawerContent] = useState<DrawerContent | null>(null);
  const drawerOpenerRef = useRef<HTMLButtonElement>(null);
  const seeded = useRef<ReadonlySet<string> | null>(null);
  const topicOptions = useMemo<readonly TopicFilter[]>(() => [null, ...topicsOf(BANK)], []);
  const list = useMemo(() => matches(BANK, view.filters), [view.filters]);
  const current = hydrated ? list[view.index] ?? null : null;
  const seenInList = list.filter((question) => view.seen.has(question.id)).length;

  // The seed's identity distinguishes hydration from an activation: it is
  // never mirrored back into settings.
  const seedFromSettings = useEffectEvent(() => {
    const seen = new Set(stored.seen);
    seeded.current = seen;
    setView((previous) => ({
      ...previous,
      seen,
      index: startIndex(matches(BANK, previous.filters), seen, null),
    }));
  });

  useEffect(() => {
    if (seeded.current === null || view.seen === seeded.current) {
      // A null seed covers pre-hydration; its identity then excludes the seeded view.
      return;
    }
    storeSettings({ seen: [...view.seen] });
  }, [storeSettings, view.seen]);

  useEffect(() => {
    if (!hydrated) return;
    seedFromSettings();
  }, [hydrated]);

  const step = (direction: 1 | -1) => {
    setView((previous) => {
      const result = stepped(list, previous.index, previous.seen, direction);
      return { ...previous, ...result };
    });
  };

  const refine = (patch: Partial<Filters>) => {
    setView((previous) => {
      const filters = refined(previous.filters, patch);
      if (filters === previous.filters) return previous;
      const nextList = matches(BANK, filters);
      const currentId = list[previous.index]?.id ?? null;
      return { ...previous, filters, index: startIndex(nextList, previous.seen, currentId) };
    });
  };

  const resetSeen = () => setView((previous) => ({ ...previous, seen: new Set<string>() }));

  const selectListIndex = (index: number) => {
    setView((previous) => {
      return { ...previous, index };
    });
    setDrawerContent(null);
  };

  const openDrawer = (content: DrawerContent, event: MouseEvent<HTMLButtonElement>) => {
    drawerOpenerRef.current = event.currentTarget;
    setDrawerContent(content);
  };

  const meta =
    current === null
      ? hydrated && list.length === 0
        ? "Nothing matches."
        : ""
      : `${view.index + 1} of ${list.length} · ${kindOf(current)} · ${current.frame} · ${current.topic}${
          view.seen.has(current.id) ? " · seen" : ""
        }`;

  const drawer = drawerContent && (
    <Drawer
      content={drawerContent}
      listLength={list.length}
      onContentChange={setDrawerContent}
      onClose={() => setDrawerContent(null)}
      returnFocusRef={drawerOpenerRef}
    >
      {drawerContent === "options" ? (
        <div className="space-y-3 px-4 pb-2 pt-2">
          <ChipRow
            label={<span className="w-14 shrink-0 text-sm text-text-faint">kind</span>}
            options={KINDS}
            selected={view.filters.kind}
            onSelect={(kind) => refine({ kind })}
            info={(kind) => kindInfo(kind)}
          />
          <ChipRow
            label={<span className="w-14 shrink-0 text-sm text-text-faint">frame</span>}
            options={FRAMES}
            selected={view.filters.frame}
            onSelect={(frame) => refine({ frame })}
            info={(frame) => frameInfo(frame)}
          />
          <ChipRow
            label={
              <span className="inline-flex w-14 shrink-0 items-center gap-0.5 text-sm text-text-faint">
                topic
                <Info side="below" call="matches(BANK, { ...filters, topic })">
                  Pins the list to the questions tagged with one topic; a topic is the plain word the bank files a
                  question under. any lifts the pin.
                </Info>
              </span>
            }
            options={topicOptions}
            selected={view.filters.topic}
            onSelect={(topic) => refine({ topic })}
          />
          <div className="flex items-center gap-3 text-sm text-text-faint tabular-nums">
            <span>
              seen {seenInList} of {list.length}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <button
                type="button"
                onClick={resetSeen}
                className="inline-flex min-h-11 items-center py-2 underline underline-offset-4 transition-colors hover:text-accent"
              >
                reset seen
              </button>
              <Info side="below" call="storeSettings({ seen: [] })">
                Empties the seen set stored under the questions settings key, so every question reads as unseen again;
                the question on screen stays.
              </Info>
            </span>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="px-4 py-3 text-sm text-text-muted">Nothing matches.</p>
      ) : (
        <div>
          <ul className="divide-y divide-border">
            {list.map((question, index) => (
              <li key={question.id}>
                <button
                  type="button"
                  onClick={() => selectListIndex(index)}
                  aria-current={index === view.index ? "true" : undefined}
                  className={`block w-full border-l-2 px-4 py-3 text-left text-base transition-colors hover:bg-surface-alt ${
                    index === view.index ? "border-accent bg-accent-dim" : "border-transparent"
                  } ${view.seen.has(question.id) ? "text-text-muted" : "text-text"}`}
                >
                  {question.text} <span className="text-sm text-text-faint">{kindOf(question)} · {question.frame}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );

  return (
    <>
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[40rem] flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
        <div className="flex min-h-[15rem] items-start sm:min-h-48">
          <p className="font-display text-2xl leading-snug text-text sm:text-3xl">{current?.text ?? ""}</p>
        </div>

        <p className="mt-2 h-5 text-sm text-text-muted tabular-nums">{meta}</p>

        <div className="mt-auto flex min-h-11 items-center gap-4">
          <TextLink label="options" onClick={(event) => openDrawer("options", event)} />
          <TextLink label={`list ${list.length}`} onClick={(event) => openDrawer("list", event)} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={!hydrated || !canStep(list, view.index, -1)}
            onClick={() => step(-1)}
            className={`h-16 rounded-xl font-display text-xl transition-[filter,background-color,color] ${
              !hydrated || !canStep(list, view.index, -1)
                ? "cursor-not-allowed border border-border bg-surface-alt text-text-faint"
                : "bg-accent text-bg hover:brightness-110 active:brightness-95"
            }`}
          >
            prev
          </button>
          <button
            type="button"
            disabled={!hydrated || !canStep(list, view.index, 1)}
            onClick={() => step(1)}
            className={`h-16 rounded-xl font-display text-xl transition-[filter,background-color,color] ${
              !hydrated || !canStep(list, view.index, 1)
                ? "cursor-not-allowed border border-border bg-surface-alt text-text-faint"
                : "bg-accent text-bg hover:brightness-110 active:brightness-95"
            }`}
          >
            next
          </button>
        </div>
      </div>
      {drawer}
    </>
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
