"use client";

// TTS (tts) — the one todo page: three tabs (calendar · batches · by
// individual), the active tab below. Tab state rides ?tab=; ?item= (produced
// by ttsItemLink) forces the by-individual tab and is handed to it as the link
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
import BatchesTab from "./components/batches-tab";
import EverythingTab from "./components/everything-tab";
import { selectBatches, type LinkIntent } from "./lib";

type Tab = "calendar" | "batches" | "by-individual";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "calendar", label: "calendar" },
  { value: "batches", label: "batches" },
  { value: "by-individual", label: "by individual" },
];

export default function TtsClient() {
  // canRead gates the queries ("skip" idiom); TomGate owns the gate JSX.
  // isTom stays separate and gates the WRITES below — the read-only `agent`
  // role a TTS session browses as passes canRead and fails isTom.
  const { isTom, canReadSurface } = useAuth();
  const canRead = canReadSurface("TTS");
  const router = useRouter();
  const recordEvent = useMutation(api.tts.recordEvent);

  const [tab, setTab] = useState<Tab>("batches");
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
      setTab("by-individual"); // an item link always lands on the by-individual tab
      return;
    }
    // Legacy names still map (old Slack links must land somewhere sensible):
    // needs-me → batches, everything → by-individual.
    const t = sp.get("tab");
    if (t === "calendar") setTab("calendar");
    else if (t === "batches" || t === "needs-me") setTab("batches");
    else if (t === "by-individual" || t === "everything") setTab("by-individual");
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

  // Batches badge: the SAME selector the tab renders (app/tts/lib.ts
  // selectBatches) so the count and the rows cannot drift. Same subscriptions
  // the tabs hold — Convex dedupes.
  const mirror = useQuery(api.tts.listMirror, canRead ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, canRead ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, canRead ? {} : "skip");

  const batchesCount = useMemo(() => {
    const { batches, unbatchedLife, unbatchedCode } = selectBatches(
      todos ?? [],
      mirror ?? [],
      codeBriefs ?? [],
      rulings ?? [],
    );
    return (
      batches.filter((b) => b.awaitingRuling).length +
      unbatchedLife.length +
      unbatchedCode.length
    );
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
              {value === "batches" && batchesCount > 0 && (
                <span className="ml-1.5 text-xs text-text-faint border border-border rounded px-1 py-px">
                  {batchesCount}
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
                setTab("by-individual");
              }}
            />
          )}
          {tab === "batches" && <BatchesTab />}
          {tab === "by-individual" && (
            <EverythingTab link={link} onLinkCleared={clearLink} />
          )}
        </div>
      </div>
    </TomGate>
  );
}
