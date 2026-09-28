"use client";

// THE /agents WINDOW VIEW (the observation page until 2026-09-26; /observe
// redirects here as ?view=window). Everything that ran, in one window of
// time: the map of the components with what each one did in that window, the
// timeline of every run and every point, the rulings and the changes. The
// agents list is the page's other view: what is running now and each agent's
// chat; this one is what ran, by window.
//
// THIS VIEW ONLY OBSERVES. The one thing it writes is a ruling — Approve on a
// change, object on a ruling — so no panel that starts work belongs on it, and
// no text the record did not write is rendered here.
//
// THE MAP IS NOT FILTERED. Its numbers are what the window holds, so they stay
// put while the controls below narrow what the timeline draws — a count that
// moved with the filters would be a different number every time a filter was
// touched, and the map's whole job is to be the place where nothing is hidden.
//
// NOTHING HERE LEAVES THE SITE. Every press either opens more of what the
// record holds, in place, or goes to another page of tom.quest.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import ChangesList from "./components/changes-list";
import DefinitionDrawer from "./components/definition-drawer";
import Map from "./components/map";
import RulingsList from "./components/rulings-list";
import { TermsProvider } from "./components/terms";
import Timeline from "./components/timeline";
import type { Lane } from "./map-data";
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

/**
 * The window view's state: the window chosen, its rows, the filters, the
 * focused lane and the word being defined. WindowView lays it out as one
 * column; the frame page (app/frame) spreads the same parts over its drawers.
 */
export function useWindowView() {
  const { isTom } = useAuth();

  const [kind, setKind] = useState<WindowKind>("day");
  const [offset, setOffset] = useState(0);
  const [children, setChildren] = useState(false);
  const [repo, setRepo] = useState<string>("all");
  const [environment, setEnvironment] = useState<Environment>("all");
  const [focus, setFocus] = useState<Lane | null>(null);
  const [defining, setDefining] = useState<string | null>(null);

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
    () => ({ runs: rows.runs, events: rows.events, rulings: rows.rulings }),
    [rows.runs, rows.events, rows.rulings],
  );

  const shown = useMemo(
    () =>
      rows.runs.filter(
        (run) =>
          (children || run.depth === 0) &&
          (environment === "all" || run.environment === environment) &&
          (repo === "all" || repoOfRun(run) === repo),
      ),
    [rows.runs, children, environment, repo],
  );

  return {
    kind, setKind, offset, setOffset, children, setChildren, repo, setRepo,
    environment, setEnvironment, focus, setFocus, defining, setDefining,
    now, win, rows, data, shown,
  };
}

type WindowViewState = ReturnType<typeof useWindowView>;

/** The window's span, and whether its rows are all in. */
export function WindowLabel({ view }: { view: WindowViewState }) {
  const { win, rows } = view;
  return (
    <span className="text-[11px] font-mono text-text-faint">
      {windowLabel(win)}
      {rows.capped ? " · capped" : rows.complete ? "" : " · loading"}
    </span>
  );
}

/** The controls that choose the window and narrow what the timeline draws. */
export function WindowControls({ view }: { view: WindowViewState }) {
  const {
    kind, setKind, setOffset, children, setChildren, repo, setRepo,
    environment, setEnvironment, focus, setFocus,
  } = view;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
          child agents
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
  );
}

export default function WindowView() {
  const view = useWindowView();
  const { now, win, rows, data, shown, focus, setFocus, defining, setDefining } = view;

  return (
      <TermsProvider onDefine={setDefining}>
        <div className="w-full">
          <div className="flex flex-wrap items-baseline justify-end gap-2">
            <WindowLabel view={view} />
          </div>

          <div className="mt-3">
            <Map data={data} now={now} focus={focus} onFocus={setFocus} waiting={rows.waiting} />
          </div>

          <div className="mt-3">
            <WindowControls view={view} />
          </div>

          <div className="mt-2">
            <Timeline
              win={win}
              now={now}
              runs={shown}
              events={rows.events}
              rulings={rows.rulings}
              onlyLane={focus}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RulingsList rulings={rows.rulings} events={rows.events} />
            <ChangesList events={rows.events} runs={rows.runs} now={now} />
          </div>
        </div>
        <DefinitionDrawer term={defining} onClose={() => setDefining(null)} />
      </TermsProvider>
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
        on ? "bg-accent-dim text-accent" : "text-text-muted hover:bg-surface-alt hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
