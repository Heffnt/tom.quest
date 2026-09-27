"use client";

// /frame — the page every page's frame is designed on (Tom, 2026-09-27: "a
// dummy tom.quest page that has all the components that are included in the
// jarvis pages somewhere in the 5 panels"). It holds every component /jarvis
// and /agents render, the real ones with their own queries and live data, and
// writes no copy of any. Its actions are the real actions.
//
// Where each goes follows what each panel is for:
//   center  the whole: the system map and the timeline of what ran
//   top     scope: the window and its filters, the calendar with its repeats
//   left    index: the todo lists (everything, awaiting, to sign) and the agents
//   right   one thing whole: the todo, code item, agent or word last opened
//   bottom  the raw record: the rulings and the changes in the window
//
// The window view's state (app/agents/window/window-view.tsx useWindowView)
// is held here once and its parts spread over the center, top and bottom.

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Frame from "@/app/components/frame/frame";
import { openDrawer } from "@/app/components/frame/frame-store";
import type { RailSignal } from "@/app/components/frame/rail-signals";
import CalendarTab from "@/app/jarvis/components/calendar-tab";
import CodeTodoRow from "@/app/jarvis/components/code-todo-row";
import EverythingTab, { type OpenedRow } from "@/app/jarvis/components/everything-tab";
import TodoRow from "@/app/jarvis/components/todo-row";
import { groupTimeNotes, NO_NOTES } from "@/app/jarvis/components/time-note-field";
import { buildDoneSet, codeSubjectKey, liveRulingsByKey, selectNeedsMe } from "@/app/jarvis/lib";
import { waitingReason } from "@/convex/ttsShared";
import Agent from "@/app/agents/components/agent";
import AgentList from "@/app/agents/components/agent-list";
import { DAEMON_STALE_MS } from "@/app/agents/lib";
import ChangesList from "@/app/agents/window/components/changes-list";
import { Definition } from "@/app/agents/window/components/definition-drawer";
import SystemMap from "@/app/agents/window/components/map";
import RulingsList from "@/app/agents/window/components/rulings-list";
import { TermsProvider } from "@/app/agents/window/components/terms";
import Timeline from "@/app/agents/window/components/timeline";
import { useWindowView, WindowControls, WindowLabel } from "@/app/agents/window/window-view";

const PAGE = "frame";

/** What the right drawer shows: the thing last opened anywhere on the page. */
type Selected =
  | OpenedRow
  | { kind: "session"; sessionId: Id<"claudeSessions"> }
  | { kind: "run"; runId: string }
  | { kind: "term"; term: string };

/** A column layout that puts as many columns side by side as the drawer is wide enough for. */
function Columns({ min, children }: { min: string; children: ReactNode }) {
  return (
    <div className="grid items-start gap-6 p-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}), 1fr))` }}>
      {children}
    </div>
  );
}

/** One todo or code item, whole, with its verdicts, time notes and facts. */
function TodoDetail({ selected, onClose }: { selected: OpenedRow; onClose: () => void }) {
  const todos = useQuery(api.tts.listTodos, {});
  const timeNotes = useQuery(api.tts.listTimeNotes, {});
  const mirror = useQuery(api.tts.listMirror, {});
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, {});
  const rulings = useQuery(api.ttsRulings.listRulings, {});
  const notes = useMemo(() => groupTimeNotes(timeNotes ?? []), [timeNotes]);
  const now = Date.now();

  if (selected.kind === "life") {
    const todo = todos?.find((t) => t._id === selected.todoId);
    if (!todo) return null;
    const doneSet = buildDoneSet(todos ?? []);
    const statementById = new Map((todos ?? []).map((t) => [t._id as string, t.statement]));
    return (
      <TodoRow
        todo={todo}
        now={now}
        expanded
        onToggle={onClose}
        intent={null}
        onIntentCleared={() => {}}
        timeNotes={notes.get(todo._id) ?? NO_NOTES}
        waiting={waitingReason(todo, { now, doneSet, statementOf: (id) => statementById.get(id) })}
        waitingOn={(todo.needs ?? []).filter((n) => !doneSet.has(n)).map((n) => statementById.get(n) ?? n)}
      />
    );
  }
  const key = codeSubjectKey(selected.repo, selected.externalId);
  const row = mirror?.find((r) => codeSubjectKey(r.repo, r.externalId) === key);
  if (!row) return null;
  return (
    <CodeTodoRow
      row={row}
      brief={codeBriefs?.find((b) => codeSubjectKey(b.repo, b.externalId) === key)}
      ruling={liveRulingsByKey(rulings ?? []).get(key)}
      now={now}
      expanded
      onToggle={onClose}
    />
  );
}

/** A 15 s tick: ages and staleness are derived at render and must move while nothing else changes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const noop = () => {};

// Each drawer's heavy content is its own memoized component with stable
// props, so a query update or a tick elsewhere on the page never re-renders
// a thousand rows it did not change.

const TodoLists = memo(function TodoLists({ onSelect }: { onSelect: (s: Selected) => void }) {
  return <EverythingTab link={null} onLinkCleared={noop} onOpenRow={onSelect} />;
});

const Agents = memo(function Agents({ onSelect }: { onSelect: (s: Selected) => void }) {
  const sessions = useQuery(api.claudeSessions.listSessions, {});
  const now = useNow();
  const openSession = useCallback((sessionId: Id<"claudeSessions">) => onSelect({ kind: "session", sessionId }), [onSelect]);
  const openRun = useCallback((runId: string) => onSelect({ kind: "run", runId }), [onSelect]);
  return <AgentList sessions={sessions} now={now} onOpenSession={openSession} onOpenRun={openRun} />;
});

const Calendar = memo(function Calendar({ onSelect }: { onSelect: (s: Selected) => void }) {
  const open = useCallback((todoId: string) => onSelect({ kind: "life", todoId }), [onSelect]);
  return <CalendarTab onOpenItem={open} />;
});

/** One agent whole: its chat, composer, model and record. */
function AgentDetail({ selected, onSelect, onClose }: {
  selected: { kind: "session"; sessionId: Id<"claudeSessions"> } | { kind: "run"; runId: string };
  onSelect: (s: Selected) => void;
  onClose: () => void;
}) {
  const health = useQuery(api.claudeSessions.getDaemonHealth, {});
  const now = useNow();
  const daemonStale = health !== undefined && (health === null || now - health.lastSeenAt > DAEMON_STALE_MS);
  return (
    <Agent
      key={selected.kind === "run" ? selected.runId : selected.sessionId}
      runId={selected.kind === "run" ? selected.runId : undefined}
      sessionId={selected.kind === "session" ? selected.sessionId : undefined}
      depth={0}
      now={now}
      daemonStale={daemonStale}
      daemonLastSeenAt={health?.lastSeenAt}
      lastIngestError={health?.lastIngestError}
      onBack={onClose}
      onOpenRun={(runId) => onSelect({ kind: "run", runId })}
      onOpenSession={(sessionId) => onSelect({ kind: "session", sessionId })}
    />
  );
}

export default function FrameClient() {
  const { isTom } = useAuth();
  const view = useWindowView();
  const [selected, setSelected] = useState<Selected | null>(null);
  const select = useCallback((next: Selected) => {
    setSelected(next);
    openDrawer(PAGE, "right");
  }, []);
  const close = useCallback(() => setSelected(null), []);
  const define = useCallback((term: string) => select({ kind: "term", term }), [select]);

  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const mirror = useQuery(api.tts.listMirror, isTom ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, isTom ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, isTom ? {} : "skip");

  const awaiting = useMemo(() => {
    if (!todos || !mirror || !codeBriefs || !rulings) return undefined;
    const { lifeRows, codeRows } = selectNeedsMe(todos, mirror, codeBriefs, rulings);
    return lifeRows.length + codeRows.length;
  }, [todos, mirror, codeBriefs, rulings]);

  const leftSignals: RailSignal[] =
    awaiting === undefined ? [] : [{ kind: "count", value: awaiting, tone: awaiting > 0 ? "accent" : "faint", label: "awaiting" }];
  const bottomSignals: RailSignal[] = [
    { kind: "count", value: view.rows.rulings.length, tone: "faint", label: "rulings in the window" },
  ];

  const rightLabel =
    selected === null
      ? "detail"
      : selected.kind === "life"
        ? (todos?.find((t) => t._id === selected.todoId)?.statement ?? "todo")
        : selected.kind === "code"
          ? `${selected.repo} ${selected.externalId}`
          : selected.kind === "term"
            ? selected.term
            : "agent";

  const right =
    selected === null ? null : selected.kind === "life" || selected.kind === "code" ? (
      <div className="p-3">
        <TodoDetail key={JSON.stringify(selected)} selected={selected} onClose={close} />
      </div>
    ) : selected.kind === "term" ? (
      <div className="flex h-full flex-col">
        <Definition term={selected.term} onClose={close} />
      </div>
    ) : (
      <div className="flex h-full flex-col">
        <AgentDetail selected={selected} onSelect={select} onClose={close} />
      </div>
    );

  return (
    <TermsProvider onDefine={define}>
      <Frame
        page={PAGE}
        title="Frame"
        explainer="frame"
        center={
          <TomGate label="Frame">
            <div className="space-y-3 p-3">
              <SystemMap
                data={view.data}
                now={view.now}
                focus={view.focus}
                onFocus={view.setFocus}
                waiting={view.rows.waiting}
              />
              <Timeline
                win={view.win}
                now={view.now}
                runs={view.shown}
                events={view.rows.events}
                rulings={view.rows.rulings}
                onlyLane={view.focus}
              />
            </div>
          </TomGate>
        }
        top={{
          handle: { label: "calendar" },
          defaultSize: 360,
          body: isTom && (
            <div className="space-y-3 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <WindowControls view={view} />
                <WindowLabel view={view} />
              </div>
              <Calendar onSelect={select} />
            </div>
          ),
        }}
        left={{
          handle: { label: "lists", signals: leftSignals },
          defaultSize: 420,
          body: isTom && (
            <Columns min="22rem">
              <TodoLists onSelect={select} />
              <Agents onSelect={select} />
            </Columns>
          ),
        }}
        right={{
          handle: { label: rightLabel },
          defaultSize: 480,
          body: isTom && right,
        }}
        bottom={{
          handle: { label: "record", signals: bottomSignals },
          defaultSize: 280,
          body: isTom && (
            <Columns min="26rem">
              <RulingsList rulings={view.rows.rulings} events={view.rows.events} />
              <ChangesList events={view.rows.events} runs={view.rows.runs} now={view.now} />
            </Columns>
          ),
        }}
      />
    </TermsProvider>
  );
}
