"use client";

// TTS (tts) — the one todo page: QuickAdd capture bar, three tabs
// (calendar · batches · by individual), the active tab below. Tab state rides
// ?tab=; ?item= (produced by ttsItemLink) forces the by-individual tab and is
// handed to it as the link prop. Each tab fetches its own data with useQuery —
// Convex dedupes subscriptions, so the shell's badge-count queries are free.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import CalendarTab from "./components/calendar-tab";
import BatchesTab from "./components/batches-tab";
import EverythingTab from "./components/everything-tab";
import Info from "./components/info";
import { selectBatches, type LinkIntent } from "./lib";

const inputCls =
  "bg-surface border border-border rounded-md px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";

type Tab = "calendar" | "batches" | "by-individual";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "calendar", label: "calendar" },
  { value: "batches", label: "batches" },
  { value: "by-individual", label: "by individual" },
];

function QuickAdd() {
  const createTodo = useMutation(api.tts.createTodo);
  const [statement, setStatement] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = statement.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTodo({
        statement: trimmed,
        category: category.trim() || undefined,
      });
      setStatement("");
      setCategory("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-bg/95 backdrop-blur border-b border-border">
      <form onSubmit={submit} className="flex flex-wrap gap-2 items-center">
        <input
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="Add a todo…"
          className={`${inputCls} flex-1 min-w-48`}
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
          className={`${inputCls} w-32`}
        />
        <button
          type="submit"
          disabled={!statement.trim() || busy}
          className="bg-accent text-bg rounded-md px-4 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
        <Info label="tts.createTodo" />
      </form>
      {error && <div className="text-xs text-error mt-1">{error}</div>}
    </div>
  );
}

export default function TtsClient() {
  // isTom still gates the queries ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
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
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || todos === undefined) return;
    openedRef.current = true;
    void recordEvent({ kind: "tts-opened" }).catch(() => {});
  }, [todos, recordEvent]);

  // Batches badge: the SAME selector the tab renders (app/tts/lib.ts
  // selectBatches) so the count and the rows cannot drift. Same subscriptions
  // the tabs hold — Convex dedupes.
  const mirror = useQuery(api.tts.listMirror, isTom ? {} : "skip");
  const codeBriefs = useQuery(api.ttsCode.listCodeBriefs, isTom ? {} : "skip");
  const rulings = useQuery(api.ttsRulings.listRulings, isTom ? {} : "skip");

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
        <QuickAdd />

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
