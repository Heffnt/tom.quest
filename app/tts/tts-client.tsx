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
import CalendarTab from "./components/calendar-tab";
import EverythingTab from "./components/everything-tab";
import { selectNeedsMe, type LinkIntent } from "./lib";

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

  const awaitingCount = useMemo(() => {
    const { lifeRows, codeRows } = selectNeedsMe(
      todos ?? [],
      mirror ?? [],
      codeBriefs ?? [],
      rulings ?? [],
    );
    return lifeRows.length + codeRows.length;
  }, [todos, mirror, codeBriefs, rulings]);

  return (
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
          {tab === "calendar" && (
            <CalendarTab
              onOpenItem={(id) => {
                setLink({ item: id, intent: null });
                setTab("everything");
              }}
            />
          )}
          {tab === "everything" && (
            <EverythingTab link={link} onLinkCleared={clearLink} />
          )}
        </div>
      </div>
    </TomGate>
  );
}
