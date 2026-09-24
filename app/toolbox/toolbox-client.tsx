"use client";

// /toolbox — every toolbox component once, with live data. A composition, not
// a construction (vqc/pages.md, principle 9): this file imports the toolbox,
// its queries and the TTS selectors, and scripts/check-toolbox-pages.mjs
// holds it to that.

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import TomGate from "@/app/components/tom-gate";
import {
  ActionRow,
  AreaFigure,
  Columns,
  FactTable,
  FigureStrip,
  GroupDrawer,
  ItemPanel,
  Num,
  Page,
  PageHead,
  Prose,
  Term,
  TimeFigure,
  useNow,
  useSurfaceQuery,
} from "@/app/components/toolbox";
import {
  VERDICTS,
  agentFigures,
  eventLanes,
  fmtDate,
  frontier,
  isRulable,
  nextForTom,
  shapeCells,
  shapeCounts,
  sourceRows,
  sourceWords,
  type RulingVerdict,
} from "@/app/tts/lib";

const HOUR = 3_600_000;

const EFFECT: Record<RulingVerdict, string> = {
  approve: "Records your approve on this todo and stamps it as touched by you.",
  revise: "Sends this todo back to be prepared again, with your sentence as the redirection.",
  session: "Records that this todo needs a session; the ruling is used when a session opens on it.",
  archive: "Sets this todo aside as archived, with your sentence as the condition to propose it back.",
};

const ASK: Partial<Record<RulingVerdict, { placeholder: string; required?: boolean }>> = {
  revise: { placeholder: "the sentence that redirects the agent", required: true },
  archive: { placeholder: "propose it back when…" },
};

const COLUMNS = [
  { key: "source", name: "source" },
  { key: "waitingOnYou", name: "waiting on you", align: "num" as const },
  { key: "notYetPrepared", name: "not yet prepared", align: "num" as const },
  { key: "done", name: "done", align: "num" as const },
  { key: "total", name: "todos", align: "num" as const },
];

export default function ToolboxClient() {
  const now = useNow();
  const todos = useSurfaceQuery("TTS", api.tts.listTodos, {});
  const rulings = useSurfaceQuery("TTS", api.ttsRulings.listRulings, {});
  const events = useSurfaceQuery("TTS", api.tts.listRecentEvents, { limit: 1000 });
  const sessions = useSurfaceQuery("Runs", api.claudeSessions.listSessions, {});
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [pickedId, setPickedId] = useState<string>();

  const cells = useMemo(() => shapeCells(todos ?? [], now), [todos, now]);
  const counts = shapeCounts(cells);
  const selected =
    cells.find((c) => c.key === selectedKey) ??
    cells.find((c) => c.group === "waiting on you") ??
    cells[0];
  const rows = sourceRows(cells);
  const item =
    todos?.find((t) => t._id === pickedId) ?? nextForTom(todos ?? [], rulings ?? [], now);
  const time = eventLanes(events ?? [], now, 12, 2 * HOUR, 4);
  const figures = agentFigures(sessions ?? []).map((f) =>
    sessions === undefined ? { ...f, value: "…" } : f,
  );
  const ready = frontier(todos ?? [], now).length;

  return (
    <TomGate label="TTS">
      <Page>
        <PageHead
          name="toolbox"
          sentence={
            todos === undefined ? (
              "…"
            ) : (
              <>
                <Num>{todos.length}</Num> todos: <Num>{counts["waiting on you"]}</Num> waiting on
                you, <Num>{counts.overdue}</Num> overdue,{" "}
                <Num>{counts["waiting on another todo"]}</Num> waiting on another todo,{" "}
                <Num>{counts["not yet prepared"]}</Num> not yet prepared.
              </>
            )
          }
          caption="tts.listTodos → counts by waiting reason"
        />
        <Columns
          main={
            <>
              <AreaFigure
                title="todos"
                cells={cells}
                selectedKey={selected?.key}
                onSelect={setSelectedKey}
                caption="tts.listTodos → counts by waiting reason × source"
              />
              {item && (
                <ItemPanel
                  statement={item.statement}
                  provenance={`From ${sourceWords(item.source)}${item.provenance ? `: ${item.provenance}` : ""}.`}
                  brief={item.brief}
                  firstStep={item.entryAction}
                >
                  {isRulable(item) && (
                    <ActionRow
                      actions={VERDICTS.map((verdict) => ({
                        label: verdict,
                        call: `ttsRulings.recordRuling({ todoId, verdict: "${verdict}", sentence })`,
                        effect: EFFECT[verdict],
                        ask: ASK[verdict],
                        onClick: (sentence: string) =>
                          recordRuling({ todoId: item._id, verdict, sentence: sentence || undefined }),
                      }))}
                    />
                  )}
                </ItemPanel>
              )}
              <TimeFigure
                title="events, the last 24 hours"
                lanes={time.lanes}
                binLabels={time.binLabels}
                caption="tts.listRecentEvents({ limit: 1000 }) → events per 2 hours by kind"
              />
              <FactTable
                columns={COLUMNS}
                rows={rows}
                total={{
                  source: "all",
                  waitingOnYou: counts["waiting on you"],
                  notYetPrepared: counts["not yet prepared"],
                  done: counts.done,
                  total: todos?.length ?? 0,
                }}
                caption="tts.listTodos → counts by source"
              />
              <Prose caption="tts.listTodos → todos that are ready">
                <Num>{ready}</Num> todos are <Term word="ready" />.
              </Prose>
            </>
          }
          side={
            <>
              {selected && (
                <GroupDrawer
                  title={`${selected.label}, ${selected.group}`}
                  count={selected.count}
                  members={selected.todos.map((t) => ({
                    id: t._id,
                    primary: t.statement,
                    secondary: t.dueAt === undefined ? undefined : `due ${fmtDate(t.dueAt)}`,
                  }))}
                  onPick={setPickedId}
                  caption="tts.listTodos → the todos of one waiting reason and source"
                />
              )}
              <FigureStrip
                figures={figures}
                caption="claudeSessions.listSessions → the newest 100 agents by status"
              />
            </>
          }
        />
      </Page>
    </TomGate>
  );
}
