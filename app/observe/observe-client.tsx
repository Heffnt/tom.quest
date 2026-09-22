"use client";

// THE OBSERVATION PAGE. Everything happening in Jarvis and everything that
// happened, in one window of time: the map of the components with what each one
// did in that window, the timeline of every run and every point, the rulings
// and the changes, and the runners.
//
// THE MAP IS NOT FILTERED. Its numbers are what the window holds, so they stay
// put while the controls below narrow what the timeline draws — a count that
// moved with the filters would be a different number every time a filter was
// touched, and the map's whole job is to be the place where nothing is hidden.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import RunnersBlock from "@/app/tts/components/runners-block";
import ChangesList from "./components/changes-list";
import Map from "./components/map";
import RulingsList from "./components/rulings-list";
import Timeline from "./components/timeline";
import type { Lane } from "./map-data";
import { OBSERVE_SLUG } from "./slug";
import {
  REPO_NAMES,
  WINDOW_KINDS,
  repoOfRun,
  windowBounds,
  windowLabel,
  type WindowKind,
} from "./lib";
import { useWindowRows } from "./use-window-rows";

type Environment = "all" | "session" | "worker" | "runner";

const ENVIRONMENTS: Environment[] = ["all", "session", "worker", "runner"];

export default function ObserveClient() {
  const { isTom } = useAuth();

  const [kind, setKind] = useState<WindowKind>("day");
  const [offset, setOffset] = useState(0);
  const [children, setChildren] = useState(false);
  const [repo, setRepo] = useState<string>("all");
  const [environment, setEnvironment] = useState<Environment>("all");
  const [focus, setFocus] = useState<Lane | "box" | null>(null);

  // A fifteen-second tick keeps the ages and the live bars honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, []);

  // The window is pinned the moment it is chosen. It must not slide with the
  // tick, or every fifteen seconds the paginated walk would start over on a
  // window that had moved.
  const [anchor, setAnchor] = useState(() => Date.now());
  useEffect(() => {
    setAnchor(Date.now());
  }, [kind, offset]);

  const win = useMemo(() => windowBounds(kind, offset, anchor), [kind, offset, anchor]);
  const rows = useWindowRows(win, isTom);

  const data = useMemo(
    () => ({
      runs: rows.runs,
      events: rows.events,
      rulings: rows.rulings,
      runners: rows.runners.map((runner) => ({
        experimentHost: runner.experimentHost,
        endedAt: runner.endedAt,
        lastCheckInAt: runner.lastCheckInAt,
      })),
    }),
    [rows.runs, rows.events, rows.rulings, rows.runners],
  );

  const shown = useMemo(
    () =>
      rows.runs.filter(
        (run) =>
          (children || run.depth === 0) &&
          (environment === "all" || run.environment === environment) &&
          (repo === "all" || repoOfRun(run) === repo) &&
          (focus !== "box" || run.host === "box"),
      ),
    [rows.runs, children, environment, repo, focus],
  );

  const onlyLane = focus === null || focus === "box" ? null : focus;

  return (
    <TomGate label="Observe">
      <div className="w-full px-3 py-5 sm:px-5">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{OBSERVE_SLUG}</h1>
          <span className="text-[11px] font-mono text-text-faint">
            {windowLabel(win)}
            {rows.capped ? " · capped" : rows.complete ? "" : " · loading"}
          </span>
        </header>

        <div className="mt-3">
          <Map
            data={data}
            now={now}
            focus={focus}
            onFocus={setFocus}
            waiting={rows.waiting}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Group>
            {WINDOW_KINDS.map((option) => (
              <Pick
                key={option}
                on={kind === option}
                onClick={() => {
                  setKind(option);
                  setOffset(0);
                }}
              >
                {option}
              </Pick>
            ))}
          </Group>
          <Group>
            <Pick on={false} onClick={() => setOffset((value) => value + 1)}>
              previous
            </Pick>
            <Pick on={false} onClick={() => setOffset((value) => Math.max(0, value - 1))}>
              next
            </Pick>
          </Group>
          <Group>
            <Pick on={children} onClick={() => setChildren((value) => !value)}>
              child runs
            </Pick>
          </Group>
          <Group>
            <Pick on={repo === "all"} onClick={() => setRepo("all")}>
              every repo
            </Pick>
            {REPO_NAMES.map((name) => (
              <Pick key={name} on={repo === name} onClick={() => setRepo(name)}>
                {name}
              </Pick>
            ))}
          </Group>
          <Group>
            {ENVIRONMENTS.map((option) => (
              <Pick
                key={option}
                on={environment === option}
                onClick={() => setEnvironment(option)}
              >
                {option === "all" ? "every environment" : option}
              </Pick>
            ))}
          </Group>
          {focus !== null && (
            <Group>
              <Pick on onClick={() => setFocus(null)}>
                {focus}
              </Pick>
            </Group>
          )}
        </div>

        <div className="mt-2">
          <Timeline
            win={win}
            now={now}
            runs={shown}
            events={rows.events}
            rulings={rows.rulings}
            onlyLane={onlyLane}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RulingsList rulings={rows.rulings} events={rows.events} isTom={isTom} />
          <ChangesList events={rows.events} />
        </div>

        <div className="mt-4">
          <RunnersBlock now={now} />
        </div>
      </div>
    </TomGate>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-surface/40 p-0.5">
      {children}
    </div>
  );
}

function Pick({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] ${
        on
          ? "bg-accent-dim text-accent"
          : "text-text-muted hover:bg-surface-alt hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
