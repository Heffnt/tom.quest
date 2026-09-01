"use client";

// MOCKUP page: the graph-model batches tab rendered by the real components
// (paths-bar, batch-card, plan-bar, ruling-dialog, detail-dialog) over live
// prod data via the real authed query. Quick by design: ruling confirms are
// no-ops. The real build swaps this shell for the batches tab and deletes
// this route.
//
// MOCKUP-ONLY derivations until schema v2 + planner land: paths come from a
// keyword bucketing; each batch's GRAPH is derived from today's linear plan
// (steps become tasks chained by needs edges, members become goals).
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import PathsBar from "../tts/components/paths-bar";
import BatchCard, { type BatchGraph } from "../tts/components/batch-card";
import RulingDialog, { type RulingOption } from "../tts/components/ruling-dialog";
import DetailDialog, { type DetailItem } from "../tts/components/detail-dialog";
import GroundUpView from "../tts/components/ground-up-view";

type Row = {
  _id: string;
  statement: string;
  brief?: string;
  status: string;
  members?: Array<{ todoId?: string; repo?: string; externalId?: string }>;
  plan?: Array<{
    text: string;
    actor: "tom" | "agent";
    status: "open" | "done";
    evidence?: string;
  }>;
};

const PATH_ORDER = ["cmt paper", "cmt code", "tts", "tom.quest", "research", "personal"];

function derivePath(statement: string): string {
  const s = statement.toLowerCase();
  if (/\btts\b|rename|ruling/.test(s)) return "tts";
  if (/paper|thesis|lit-review|readers|prose|pin|ratification|harvest|credit/.test(s))
    return "cmt paper";
  if (/cmt|plant|trigger|detection|method|install|guards|superseded|recover/.test(s))
    return "cmt code";
  if (/tom\.quest|boolback|turing|jarvis|roles|publisher/.test(s)) return "tom.quest";
  if (/personal|answer/.test(s)) return "personal";
  return "research";
}

function toGraph(b: Row, byId: Map<string, Row>): BatchGraph {
  const steps = b.plan ?? [];
  // Linear plan → chain graph; parallel branches where consecutive steps
  // share an actor boundary stay chained (the planner will parallelize for
  // real once it emits graphs).
  const tasks = steps.map((s, i) => ({
    id: `${b._id}#${i}`,
    statement: s.text,
    actor: s.actor,
    status: s.status === "done" ? ("done" as const) : ("active" as const),
    needs: i > 0 ? [`${b._id}#${i - 1}`] : [],
    evidence: s.evidence,
  }));
  const goals = (b.members ?? []).map((m, i) => {
    if (m.todoId !== undefined) {
      const t = byId.get(m.todoId);
      return {
        id: `${b._id}!g${i}`,
        statement: t?.statement ?? m.todoId,
        condition: t ? `"${t.statement}" is done` : undefined,
        met: t?.status === "done" || t?.status === "archived",
        groundUp: t?.brief,
      };
    }
    return {
      id: `${b._id}!g${i}`,
      statement: `${m.repo} · ${m.externalId} closed upstream`,
      condition: `${m.repo} todo ${m.externalId} is closed in its repo`,
      met: false,
      code: { repo: m.repo ?? "?", externalId: m.externalId ?? "?" },
    };
  });
  return { id: b._id, statement: b.statement, groundUp: b.brief, tasks, goals };
}

const DEV_SAMPLE: Row[] = [
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
  { _id: "sample-b", statement: "Sample member todo", brief: "A member of the sample batch.", status: "active" },
];

export default function MockupClient() {
  const { isTom } = useAuth();
  const live = useQuery(api.tts.listTodos, isTom ? {} : "skip");
  const fetched = (live ?? null) as unknown as Row[] | null;
  const rows =
    fetched ?? (process.env.NODE_ENV === "development" && !isTom ? DEV_SAMPLE : null);
  const [selectedPath, setSelectedPath] = useState<string>("cmt paper");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ruling, setRuling] = useState<{ graph: BatchGraph; option: RulingOption } | null>(null);
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const [groundUp, setGroundUp] = useState<{ title: string; content: string } | null>(null);

  const { byPath, chips } = useMemo(() => {
    const all = rows ?? [];
    const byId = new Map(all.map((t) => [t._id, t]));
    const graphs = all
      .filter((t) => t.members !== undefined && t.status === "active")
      .map((b) => ({ path: derivePath(b.statement), graph: toGraph(b, byId) }));
    const byPath = new Map<string, BatchGraph[]>();
    for (const { path, graph } of graphs)
      byPath.set(path, [...(byPath.get(path) ?? []), graph]);
    const chips = PATH_ORDER.filter((p) => byPath.has(p)).map((p) => ({
      name: p,
      count: (byPath.get(p) ?? []).length,
    }));
    return { byPath, chips };
  }, [rows]);

  if (rows === null) {
    return <div className="p-6 text-sm text-text-faint">loading…</div>;
  }

  const shownPath = byPath.has(selectedPath) ? selectedPath : (chips[0]?.name ?? selectedPath);
  const list = byPath.get(shownPath) ?? [];
  const usingSample = rows === DEV_SAMPLE;

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const content = (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-6">
      <div className="mb-4 flex items-baseline gap-5 border-b border-border pb-2">
        <span className="font-semibold text-accent">tts</span>
        <span className="text-[13px] text-text-faint">calendar</span>
        <span className="border-b-2 border-accent pb-1.5 text-[13px] text-text">batches</span>
        <span className="text-[13px] text-text-faint">by individual</span>
      </div>

      <PathsBar paths={chips} selected={shownPath} onSelect={setSelectedPath} />

      <div className="mt-3 flex flex-col">
        {list.map((g, i) => (
          <div key={g.id}>
            {i > 0 && (
              <div className="flex justify-center py-0.5">
                <div className="h-3 w-px bg-[#2c3a52]" />
              </div>
            )}
            <BatchCard
              graph={g}
              expanded={expanded.has(g.id)}
              onToggle={() => setExpanded((prev) => toggle(prev, g.id))}
              onRule={(option) => setRuling({ graph: g, option })}
              onDetail={setDetail}
              onGroundUp={(title, content) => setGroundUp({ title, content })}
              onOpenSession={() => {}}
            />
          </div>
        ))}
      </div>

      {ruling && (
        <RulingDialog
          option={ruling.option}
          statement={ruling.graph.statement}
          brief={ruling.graph.groundUp}
          plan={ruling.graph.tasks.map((t) => ({
            text: t.statement,
            actor: t.actor,
            status: t.status === "done" ? ("done" as const) : ("open" as const),
          }))}
          onClose={() => setRuling(null)}
        />
      )}
      {detail && (
        <DetailDialog
          item={detail}
          onClose={() => setDetail(null)}
          onGroundUp={(title, content) => setGroundUp({ title, content })}
        />
      )}
      {groundUp && (
        <GroundUpView title={groundUp.title} content={groundUp.content} onClose={() => setGroundUp(null)} />
      )}
    </main>
  );

  return usingSample ? content : <TomGate label="TTS mockup">{content}</TomGate>;
}
