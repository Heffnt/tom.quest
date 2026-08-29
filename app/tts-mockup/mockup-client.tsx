"use client";

// MOCKUP page: the redesigned batches tab rendered by the real components
// (app/tts/components/{paths-bar,batch-card,plan-bar,ruling-dialog,
// detail-dialog}) over live prod data via the real authed query. Quick by
// design: ruling confirms are no-ops. The real build swaps this page's shell
// for the batches tab proper and deletes this route.
//
// MOCKUP-ONLY derivation: paths come from a keyword bucketing below until the
// batcher emits real path assignments.
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import PathsBar from "../tts/components/paths-bar";
import BatchCard, { type BatchData } from "../tts/components/batch-card";
import RulingDialog, {
  type RulingVerdict,
} from "../tts/components/ruling-dialog";
import DetailDialog, {
  type DetailItem,
} from "../tts/components/detail-dialog";

const PATH_ORDER = [
  "cmt paper",
  "cmt code",
  "tts",
  "tom.quest",
  "research",
  "personal",
];

function derivePath(statement: string): string {
  const s = statement.toLowerCase();
  if (/\btts\b|rename|ruling/.test(s)) return "tts";
  if (/paper|thesis|lit-review|readers|prose|pin|ratification|harvest|credit/.test(s))
    return "cmt paper";
  if (/cmt|plant|trigger|detection|method|install|guards|superseded|recover/.test(s))
    return "cmt code";
  if (/tom\.quest|boolback|turing|jarvis|roles|publisher/.test(s))
    return "tom.quest";
  if (/personal|answer/.test(s)) return "personal";
  return "research";
}

// Dev-only sample so the mockup renders without auth on a local dev server
// (agents iterating on the design can see it; prod always uses the live query).
const DEV_SAMPLE: BatchData[] = [
  {
    _id: "sample-a",
    statement: "Sample batch: wire the widget to the frobnicator",
    brief:
      "Two sample todos share one setup cost. One session lands both; this sample exists only on dev servers without a Tom login.",
    status: "active",
    members: [{ todoId: "sample-b" }, { repo: "demo", externalId: "d1" }],
    plan: [
      { text: "Survey the widget call sites", actor: "agent", status: "done" },
      { text: "Pick a frobnicator: keep or replace?", actor: "tom", status: "open" },
      { text: "Apply the pick and push a session branch", actor: "agent", status: "open" },
      { text: "Walk Tom through the result in a session", actor: "tom", status: "open" },
    ],
  },
  {
    _id: "sample-b",
    statement: "Sample member todo",
    brief: "A member of the sample batch.",
    status: "active",
  },
];

export default function MockupClient() {
  const { isTom } = useAuth();
  const live = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const fetched = (live ?? null) as unknown as BatchData[] | null;
  const rows =
    fetched ??
    (process.env.NODE_ENV === "development" && !isTom ? DEV_SAMPLE : null);
  const [selectedPath, setSelectedPath] = useState<string>("cmt paper");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ruling, setRuling] = useState<{
    batch: BatchData;
    verdict: RulingVerdict;
  } | null>(null);
  const [detail, setDetail] = useState<DetailItem | null>(null);

  const { byId, byPath, chips } = useMemo(() => {
    const all = rows ?? [];
    const byId = new Map(all.map((t) => [t._id, t]));
    const batches = all.filter(
      (t) => t.members !== undefined && t.status === "active",
    );
    const byPath = new Map<string, BatchData[]>();
    for (const b of batches) {
      const p = derivePath(b.statement);
      byPath.set(p, [...(byPath.get(p) ?? []), b]);
    }
    const chips = PATH_ORDER.filter((p) => byPath.has(p)).map((p) => ({
      name: p,
      count: (byPath.get(p) ?? []).length,
    }));
    return { byId, byPath, chips };
  }, [rows]);

  if (rows === null) {
    return <div className="p-6 text-sm text-text-faint">loading…</div>;
  }

  const shownPath = byPath.has(selectedPath)
    ? selectedPath
    : (chips[0]?.name ?? selectedPath);
  const list = byPath.get(shownPath) ?? [];
  const usingSample = rows === DEV_SAMPLE;

  const content = (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-6">
      <div className="mb-4 flex items-baseline gap-5 border-b border-border pb-2">
        <span className="font-semibold text-accent">tts</span>
        <span className="text-[13px] text-text-faint">calendar</span>
        <span className="border-b-2 border-accent pb-1.5 text-[13px] text-text">
          batches
        </span>
        <span className="text-[13px] text-text-faint">by individual</span>
      </div>

      <PathsBar paths={chips} selected={shownPath} onSelect={setSelectedPath} />

      <div className="mt-3 flex flex-col">
        {list.map((b, i) => (
          <div key={b._id}>
            {i > 0 && (
              <div className="flex justify-center py-0.5">
                <div className="h-3 w-px bg-[#2c3a52]" />
              </div>
            )}
            <BatchCard
              batch={b}
              resolveTodo={(id) => byId.get(id)}
              expanded={expanded.has(b._id)}
              onToggle={() =>
                setExpanded((prev) => {
                  const nextSet = new Set(prev);
                  if (nextSet.has(b._id)) nextSet.delete(b._id);
                  else nextSet.add(b._id);
                  return nextSet;
                })
              }
              onRule={(verdict) => setRuling({ batch: b, verdict })}
              onDetail={setDetail}
              onOpenSession={() => {}}
            />
          </div>
        ))}
      </div>

      {ruling && (
        <RulingDialog
          verdict={ruling.verdict}
          statement={ruling.batch.statement}
          brief={ruling.batch.brief}
          plan={ruling.batch.plan}
          onClose={() => setRuling(null)}
        />
      )}
      {detail && <DetailDialog item={detail} onClose={() => setDetail(null)} />}
    </main>
  );

  return usingSample ? (
    content
  ) : (
    <TomGate label="TTS mockup">{content}</TomGate>
  );
}
