"use client";

// TTS (tts) — the one todo page: two tabs (calendar · everything), the active
// tab below. Batches are gone (Tom, 2026-09-24): the runners, the todos
// awaiting his ruling and the rulings still applying open the everything tab,
// which is the default. Tab state rides ?tab=; ?item= (produced by
// ttsItemLink) forces the everything tab and is handed to it as the link
// prop. Each tab fetches its own data with useQuery — Convex dedupes
// subscriptions, so the shell's badge-count queries are free.
//
// The page has no capture control (ruling 2026-09-05, "no capture bar"):
// todos are captured from Slack through the events route, and this page is
// where they are read and ruled on.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Frame from "@/app/components/frame/frame";
import type { RailSignal } from "@/app/components/frame/rail-signals";
import type { Id } from "@/convex/_generated/dataModel";
import CalendarTab from "./components/calendar-tab";
import EventStream from "./components/event-stream";
import EverythingTab from "./components/everything-tab";
import TodoDetail from "./components/todo-detail";
import TodoLists, { type ListRow } from "./components/todo-lists";
import { codeSubjectKey, selectNeedsMe, selectToday, type LinkIntent, type Todo } from "./lib";

// The two tabs, in the page's own vocabulary. A Slack link may still name a
// third (convex/ttsShared.ts TtsTab); the read-once effect below maps it.
type Tab = "calendar" | "everything";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "calendar", label: "calendar" },
  { value: "everything", label: "everything" },
];

export default function TtsClient() {
  // canRead gates the queries ("skip" idiom); TomGate owns the gate JSX.
  // isTom stays separate and gates the WRITES below — the read-only `agent`
  // role a TTS session browses as passes canRead and fails isTom.
  const { isTom, canReadSurface } = useAuth();
  const canRead = canReadSurface("TTS");
  const router = useRouter();
  const recordEvent = useMutation(api.tts.recordEvent);

  const [tab, setTab] = useState<Tab>("everything");
  const [link, setLink] = useState<{
    item: string;
    intent: LinkIntent | null;
  } | null>(null);

  // Read ?tab=…&item=…&intent=… ONCE on mount. No mutation fires here —
  // only the highlighted confirm button in the linked row does (GETs must not
  // change state; Slack's link-preview crawler fetches these URLs).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const item = sp.get("item");
    if (item) {
      const raw = sp.get("intent");
      const intent =
        raw === "done" || raw === "archive" || raw === "engage" ? raw : null;
      setLink({ item, intent });
      setTab("everything"); // an item link always lands on the everything tab
      return;
    }
    // Only calendar is not the default. Every other name — everything, and
    // the retired batches, needs-me and by-individual that old Slack posts
    // carry — lands on the everything tab.
    if (sp.get("tab") === "calendar") setTab("calendar");
  }, []);

  // Tab state stays local: user-facing quest URLs avoid query params
  // (AGENTS.md routing). Incoming ?tab= links (e.g. the /focus redirect) are
  // honored by the read-once effect above; clicks do not write the URL.
  const selectTab = (next: Tab) => setTab(next);

  const clearLink = () => {
    setLink(null);
    router.replace("/tts", { scroll: false });
  };

  // Instrumentation: one tts-opened per load, once data is here.
  // Fire-and-forget — never blocks the UI.
  //
  // isTom, NOT canRead, and that is a claim about meaning as much as about
  // permission: this event records that TOM OPENED HIS TODOS. A headless
  // screenshot taken by a TTS session is not that, and counting it would put
  // noise into the very signal the daily digest reads. Permission agrees —
  // recordEvent is a mutation and Convex refuses it for `agent` — and a
  // refused mutation prints a console error, which tts-browse reports under
  // its `console` line as a page failure. Left ungated this would be a false
  // positive on every screenshot of /tts.
  const todos = useQuery(api.tts.listTodos, canRead ? {} : "skip");
  const openedRef = useRef(false);
  useEffect(() => {
    if (!isTom || openedRef.current || todos === undefined) return;
    openedRef.current = true;
    void recordEvent({ kind: "tts-opened" }).catch(() => {});
  }, [isTom, todos, recordEvent]);

  // The everything tab's badge: the awaiting count, from the SAME selector
  // its awaiting section renders (app/tts/lib.ts selectNeedsMe) so the count
  // and the rows cannot drift. Same subscriptions the tab holds — Convex
  // dedupes.
  const mirror = useQuery(api.tts.listMirror, canRead ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, canRead ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, canRead ? {} : "skip");

  const needsMe = useMemo(
    () => selectNeedsMe(todos ?? [], mirror ?? [], codeBriefs ?? [], rulings ?? []),
    [todos, mirror, codeBriefs, rulings],
  );
  const awaitingCount = needsMe.lifeRows.length + needsMe.codeRows.length;

  // Today, by the calendar's own selector: what is overdue (dated before the
  // day began) and what falls due inside it. The day is the reader's local
  // one; it is read again whenever the todos change.
  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return selectToday(todos ?? [], [], { start: start.getTime(), end: end.getTime() });
  }, [todos]);

  // The left drawer's rows, from the same selectors as its handle's counts.
  const lists = useMemo(() => {
    const todoRow = (t: Todo): ListRow => ({ key: t._id, statement: t.statement, todoId: t._id });
    return {
      awaiting: [
        ...needsMe.lifeRows.map(todoRow),
        ...needsMe.codeRows.map(({ row }) => ({ key: codeSubjectKey(row.repo, row.externalId), statement: row.statement })),
      ],
      overdue: today.overdue.map(todoRow),
    };
  }, [needsMe, today]);

  // The selected todo, shown whole in the right drawer and named on its handle.
  // Until a row is pressed, an ?item= link's todo is the selected one.
  const [pickedId, setPickedId] = useState<Id<"dtsTodos"> | null>(null);
  const selectedId = pickedId ?? ((link?.item as Id<"dtsTodos"> | undefined) ?? null);
  const selected = useMemo(() => (todos ?? []).find((t) => t._id === selectedId) ?? null, [todos, selectedId]);
  const [now] = useState(() => Date.now());

  const listSignals = useMemo<RailSignal[]>(() => {
    if (todos === undefined) return [];
    return [
      { kind: "count", value: awaitingCount, tone: "accent", label: "awaiting you" },
      { kind: "count", value: today.overdue.length, tone: today.overdue.length > 0 ? "error" : "faint", label: "overdue" },
    ];
  }, [todos, awaitingCount, today]);

  const calendarSignals = useMemo<RailSignal[]>(() => {
    if (todos === undefined) return [];
    return [{ kind: "count", value: today.due.length, tone: today.due.length > 0 ? "warn" : "faint", label: "due today" }];
  }, [todos, today]);

  const detailSignals = useMemo<RailSignal[]>(() => {
    if (!selected) return [];
    const overdue = today.overdue.some((t) => t._id === selected._id);
    const awaiting = needsMe.lifeRows.some((t) => t._id === selected._id);
    const tone = overdue ? "error" : awaiting ? "accent" : selected.status === "active" ? "ok" : "faint";
    return [
      { kind: "dot", value: 1, tone, label: overdue ? "overdue" : awaiting ? "awaiting you" : selected.status },
      { kind: "age", value: selected.updatedAt, tone: "faint", label: "last updated", staleAfterMs: 7 * 24 * 60 * 60 * 1000 },
    ];
  }, [selected, today, needsMe]);

  // The bottom drawer: the event stream, and its handle's signals from the same
  // subscription — how many rows are loaded and how old the newest is.
  const events = useQuery(api.tts.listRecentEvents, canRead ? {} : "skip");
  const statements = useMemo(
    () => new Map<Id<"dtsTodos">, string>((todos ?? []).map((t) => [t._id, t.statement])),
    [todos],
  );
  const streamSignals = useMemo<RailSignal[]>(() => {
    if (!events) return [];
    const signals: RailSignal[] = [{ kind: "count", value: events.length, tone: "faint", label: "events loaded" }];
    if (events[0]) {
      signals.push({ kind: "age", value: events[0].at, tone: "ok", label: "newest event", staleAfterMs: 6 * 60 * 60 * 1000 });
    }
    return signals;
  }, [events]);

  const openFromCalendar = (id: string) => {
    setLink({ item: id, intent: null });
    setTab("everything");
  };

  const center = (
    <TomGate label="TTS">
      <div className="max-w-5xl mx-auto px-6 pb-16">
        <div className="flex items-end gap-1 border-b border-border mt-4">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => selectTab(value)}
              className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${
                tab === value
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text"
              }`}
            >
              {label}
              {value === "everything" && awaitingCount > 0 && (
                <span className="ml-1.5 text-xs text-text-faint border border-border rounded px-1 py-px">
                  {awaitingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "calendar" && <CalendarTab onOpenItem={openFromCalendar} />}
          {tab === "everything" && (
            <EverythingTab link={link} onLinkCleared={clearLink} />
          )}
        </div>
      </div>
    </TomGate>
  );

  // The frame: the centre is the page as it was; the left drawer lists what
  // awaits Tom and what is overdue, the right shows the selected todo, the
  // bottom is the event stream, and the top holds the calendar (where the
  // calendar goes). Every handle's signals come from the same subscriptions.
  return (
    <Frame
      page="tts"
      title="TTS"
      explainer="frame"
      state={canRead && todos !== undefined ? `${awaitingCount} awaiting` : undefined}
      center={center}
      top={{
        handle: { label: "calendar", signals: calendarSignals },
        body: canRead ? <div className="p-3"><CalendarTab onOpenItem={openFromCalendar} /></div> : null,
        defaultSize: 360,
      }}
      left={{
        handle: { label: "lists", signals: listSignals },
        body: canRead ? (
          <TodoLists awaiting={lists.awaiting} overdue={lists.overdue} selected={selectedId} onSelect={setPickedId} />
        ) : null,
        defaultSize: 360,
      }}
      right={{
        handle: { label: selected?.statement ?? "detail", signals: detailSignals },
        body: canRead ? <TodoDetail todo={selected} now={now} /> : null,
        defaultSize: 440,
      }}
      bottom={{
        handle: { label: "events", signals: streamSignals },
        body: canRead ? <EventStream rows={events} statements={statements} /> : null,
        defaultSize: 320,
      }}
    />
  );
}
