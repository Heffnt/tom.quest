"use client";

// EVERYTHING tab — the todos page, composed from the toolbox (vqc/pages.md;
// Tom, 2026-09-24: the Jarvis pages are rebuilt from the toolbox, starting
// with /tts). A composition, not a construction: this file imports the
// toolbox, its queries, the TTS selectors (app/tts/lib.ts, where every number
// here is derived and tested) and two siblings, and
// scripts/check-toolbox-pages.mjs holds it to that.
//
// Top to bottom: the sentence of state; the active todos as area by waiting
// reason and source, beside the drawer of the cell picked in it; the one todo
// in front of Tom, whole, with its verdicts and its time note; four figures;
// the dated todos; the done todos, folded; the week's agent work; the runners.
//
// THE DAILY FUNCTIONS THE OLD TAB CARRIED, KEPT: the four verdicts on a life
// todo and on a code todo (ttsRulings.recordRuling), done and archive as status
// writes (tts.setStatus), the session verdict opening its session in a tab
// reserved inside the press, the time note (tts.createTimeNote), the engaged
// events, and a Slack item link (?item=&intent=) landing its todo in the panel
// with the action it proposed marked. Nothing fires on a link's arrival but
// the engaged event, and that only for Tom: a GET must change nothing, and the
// headless browser's refused write would read as a page failure.
//
// THE ONE EXCEPTION: the runners are the sibling RunnersBlock, styled on its
// own, inside a toolbox Fold, until the toolbox has a piece for a runner.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import { reserveSessionTab, useOpenTodoSession } from "@/app/lib/use-open-todo-session";
import {
  ActionRow,
  AreaFigure,
  Columns,
  FactTable,
  FigureStrip,
  Fold,
  GroupDrawer,
  ItemPanel,
  NoteField,
  Num,
  Page,
  PageHead,
  Prose,
  useNow,
  useSurfaceQuery,
} from "@/app/components/toolbox";
import {
  VERDICTS,
  activeCells,
  ageText,
  codeSubjectKey,
  datedRows,
  fmtDate,
  isRulable,
  nextForTom,
  reasonGroup,
  recentDone,
  selectNeedsMe,
  sessionFacts,
  sourceWords,
  todoCounts,
  weekActivity,
  type LinkIntent,
  type MirrorRow,
  type RulingVerdict,
  type Todo,
} from "@/app/tts/lib";
import RunnersBlock from "./runners-block";
import { VERDICT_EFFECT, verdictCall } from "./verdict-buttons";

/** The verdicts that take a sentence, and what their dialog asks for. */
const ASK: Partial<Record<RulingVerdict, { placeholder: string; required?: boolean }>> = {
  revise: { placeholder: "the sentence that redirects the agent", required: true },
  archive: { placeholder: "propose it back when… (optional)" },
};

const DONE = {
  label: "done",
  call: 'tts.setStatus({ status: "done", note })',
  effect:
    "Closes it as finished, with your note as the record of how. It stays visible as done; nothing in TTS is ever deleted.",
  ask: { placeholder: "note (optional)" },
};

const ARCHIVE_STATUS = {
  label: "archive",
  call: 'tts.setStatus({ status: "archived", unarchiveCondition })',
  effect:
    "Sets it aside without ruling on it. Your sentence is the condition that should bring it back.",
  ask: { placeholder: "propose it back when… (optional)" },
};

const TIME_NOTE_EFFECT =
  "Files one sentence about timing against this todo. A job reads pending notes every couple of minutes, works out the date you meant and applies it.";

const NOTE_STATE: Record<string, string> = {
  pending: "pending",
  applied: "applied",
  "needs-session": "needs a session",
};

const DATED_COLUMNS = [
  { key: "statement", name: "todo" },
  { key: "date", name: "date" },
  { key: "state", name: "state" },
  { key: "source", name: "source" },
];

const DONE_COLUMNS = [
  { key: "statement", name: "todo" },
  { key: "date", name: "done" },
];

const NOTE_COLUMNS = [
  { key: "text", name: "time note" },
  { key: "state", name: "state" },
];

/** What Tom picked: a todo, or a code todo waiting on him. */
type Pick = { kind: "life"; id: string } | { kind: "code"; key: string };

export default function EverythingTab({
  link,
  onLinkCleared,
}: {
  link: { item: string; intent: LinkIntent | null } | null;
  onLinkCleared: () => void;
}) {
  const { isTom } = useAuth();
  const now = useNow();
  const todos = useSurfaceQuery("TTS", api.tts.listTodos, {});
  const mirror = useSurfaceQuery("TTS", api.tts.listMirror, {});
  const briefs = useSurfaceQuery("TTS", api.ttsCode.listCodeBriefs, {});
  const rulings = useSurfaceQuery("TTS", api.ttsRulings.listRulings, {});
  const timeNotes = useSurfaceQuery("TTS", api.tts.listTimeNotes, {});
  const events = useSurfaceQuery("TTS", api.tts.listRecentEvents, { limit: 1000 });
  const runners = useSurfaceQuery("TTS", api.ttsRunners.listRunners, {});
  const sessions = useSurfaceQuery("Runs", api.claudeSessions.listSessions, {});
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const setStatus = useMutation(api.tts.setStatus);
  const createTimeNote = useMutation(api.tts.createTimeNote);
  const recordEvent = useMutation(api.tts.recordEvent);
  const { open: openTodoSession, error: sessionError } = useOpenTodoSession();

  const [selectedKey, setSelectedKey] = useState<string>();
  const [pick, setPick] = useState<Pick>();

  const all = useMemo(() => todos ?? [], [todos]);
  const cells = useMemo(() => activeCells(all, now), [all, now]);
  const counts = useMemo(() => todoCounts(all, now), [all, now]);
  const dated = useMemo(() => datedRows(all, now), [all, now]);
  const done = useMemo(() => recentDone(all), [all]);
  const codeWaiting = useMemo(
    () => selectNeedsMe([], mirror ?? [], briefs ?? [], rulings ?? [], now).codeRows,
    [mirror, briefs, rulings, now],
  );
  const week = weekActivity(events ?? [], now, (events ?? []).length >= 1000);
  const agents = sessionFacts(sessions ?? []);
  const liveRunners = (runners ?? []).filter((r) => r.endedAt === null).length;

  // The drawer: the cell picked in the figure, or the todos waiting on Tom.
  const selected = cells.find((c) => c.key === selectedKey);
  const drawer = selected
    ? { title: `${selected.label}, ${selected.group}`, count: selected.count, todos: selected.todos }
    : { title: "waiting on you", ...reasonGroup(cells, "waiting on you") };

  // The one item in front of Tom: what he picked, else what a link names,
  // else the next todo for him, else the first code todo waiting on him.
  const pickedCode =
    pick?.kind === "code"
      ? codeWaiting.find((c) => codeSubjectKey(c.row.repo, c.row.externalId) === pick.key)
      : undefined;
  const pickedTodo = pick?.kind === "life" ? all.find((t) => t._id === pick.id) : undefined;
  const linkedTodo = link ? all.find((t) => t._id === link.item) : undefined;
  const nextTodo = nextForTom(all, rulings ?? [], now);
  const todo = pickedCode ? undefined : (pickedTodo ?? linkedTodo ?? nextTodo);
  const code = pickedCode ?? (todo === undefined ? codeWaiting[0] : undefined);
  const chosen = pickedCode !== undefined || pickedTodo !== undefined || linkedTodo !== undefined;
  const intent = todo !== undefined && link?.item === todo._id ? link.intent : null;
  const notes = todo ? (timeNotes ?? []).filter((n) => n.todoId === todo._id) : [];

  // A link lands once: the engaged event, for Tom only (the header above).
  const landed = useRef(false);
  useEffect(() => {
    if (!link || landed.current || todos === undefined) return;
    landed.current = true;
    if (isTom && todos.some((t) => t._id === link.item)) {
      void recordEvent({
        kind: "engaged",
        todoId: link.item as Todo["_id"],
        data: { via: "everything-link", ...(link.intent ? { intent: link.intent } : {}) },
      }).catch(() => {});
    }
  }, [isTom, link, todos, recordEvent]);

  const pickTodo = (id: string) => {
    setPick({ kind: "life", id });
    void recordEvent({
      kind: "engaged",
      todoId: id as Todo["_id"],
      data: { via: "everything" },
    }).catch(() => {});
  };

  const pickCode = (key: string) => {
    setPick({ kind: "code", key });
    const row = codeWaiting.find((c) => codeSubjectKey(c.row.repo, c.row.externalId) === key)?.row;
    if (row) {
      void recordEvent({
        kind: "engaged",
        data: { via: "everything-code", repo: row.repo, externalId: row.externalId },
      }).catch(() => {});
    }
  };

  // After a ruling or a status write the panel moves on to the next todo, and
  // a link that proposed the action is spent.
  const moveOn = (id: string) => {
    setPick(undefined);
    if (link?.item === id) onLinkCleared();
  };

  const lifeActions = (t: Todo) => {
    const verdict = (v: RulingVerdict) => ({
      label: v,
      call: verdictCall("todo", v),
      effect: VERDICT_EFFECT.todo[v],
      ask: ASK[v],
      recommended: v === "archive" && intent === "archive",
      onClick:
        v === "session"
          ? (sentence: string) => {
              // Reserved inside the press, before any await: a browser opens
              // a tab only in the gesture that asked for it.
              const tab = reserveSessionTab();
              const ruling = { verdict: "session" as const, sentence: sentence || undefined };
              return (async () => {
                try {
                  await recordRuling({ todoId: t._id, ...ruling });
                } catch (e) {
                  tab.close();
                  throw e;
                }
                await openTodoSession(t, { tab, ruling });
                if (link?.item === t._id) onLinkCleared();
              })();
            }
          : async (sentence: string) => {
              await recordRuling({ todoId: t._id, verdict: v, sentence: sentence || undefined });
              moveOn(t._id);
            },
    });
    const doneAction = {
      ...DONE,
      recommended: intent === "done",
      onClick: async (note: string) => {
        await setStatus({ id: t._id, status: "done", note: note || undefined });
        moveOn(t._id);
      },
    };
    const archiveAction = {
      ...ARCHIVE_STATUS,
      recommended: intent === "archive",
      onClick: async (condition: string) => {
        await setStatus({ id: t._id, status: "archived", unarchiveCondition: condition || undefined });
        moveOn(t._id);
      },
    };
    if (isRulable(t)) return [...VERDICTS.map(verdict), doneAction];
    return [
      ...(t.status !== "done" ? [doneAction] : []),
      ...(t.status !== "archived" ? [archiveAction] : []),
    ];
  };

  const codeActions = (row: MirrorRow) =>
    VERDICTS.map((v) => ({
      label: v,
      call: verdictCall("code", v),
      effect: VERDICT_EFFECT.code[v],
      ask: ASK[v],
      onClick: async (sentence: string) => {
        await recordRuling({
          repo: row.repo,
          externalId: row.externalId,
          verdict: v,
          sentence: sentence || undefined,
        });
        setPick(undefined);
      },
    }));

  const dateWords = (t: Todo) =>
    t.dueAt === undefined
      ? `added ${ageText(t.createdAt, now)}`
      : `${t.dueAt < now ? "overdue since" : "due"} ${fmtDate(t.dueAt)}`;

  const loading = todos === undefined;
  const value = (n: number) => (loading ? "…" : n);

  return (
    <Page>
      <PageHead
        name="tts"
        sentence={
          loading ? (
            "…"
          ) : (
            <>
              <Num>{counts.active}</Num> active todos: <Num>{counts.waitingOnYou}</Num> waiting on
              you, <Num>{counts.waitingOnTodo}</Num> waiting on another todo,{" "}
              <Num>{counts.notPrepared}</Num> not yet prepared; <Num>{counts.dated}</Num> with a
              date, <Num>{counts.overdue}</Num> of them overdue.
            </>
          )
        }
        caption="tts.listTodos → active todos by waiting reason, and the dated ones"
      />
      <Columns
        main={
          <AreaFigure
            title="active todos"
            cells={cells}
            selectedKey={selected?.key}
            onSelect={setSelectedKey}
            caption="tts.listTodos → active todos by waiting reason × source"
          />
        }
        side={
          <>
            <GroupDrawer
              title={drawer.title}
              count={drawer.count}
              members={drawer.todos.map((t) => ({
                id: t._id,
                primary: t.statement,
                secondary: `${dateWords(t)} · ${sourceWords(t.source)}`,
              }))}
              onPick={pickTodo}
              caption="tts.listTodos → the active todos of one waiting reason, or of one reason and source"
            />
            {codeWaiting.length > 0 && (
              <GroupDrawer
                title="code waiting on you"
                count={codeWaiting.length}
                members={codeWaiting.map(({ row, brief }) => ({
                  id: codeSubjectKey(row.repo, row.externalId),
                  primary: row.statement,
                  secondary: `${row.repo} · prepared ${ageText(brief.preparedAt, now)}`,
                }))}
                onPick={pickCode}
                caption="tts.listMirror, ttsCode.listCodeBriefs → open code todos briefed and waiting on you"
              />
            )}
          </>
        }
      />
      {todo ? (
        <ItemPanel
          title={chosen ? "picked" : "next"}
          statement={todo.statement}
          provenance={`From ${sourceWords(todo.source)}${todo.provenance ? `: ${todo.provenance}` : ""}. Added ${ageText(todo.createdAt, now)}${todo.dueAt === undefined ? "" : `; ${dateWords(todo)}`}.`}
          brief={todo.brief}
          firstStep={todo.entryAction}
        >
          <ActionRow actions={lifeActions(todo)} error={sessionError} />
          <NoteField
            label="note"
            placeholder="when"
            call="tts.createTimeNote({ text, todoId })"
            effect={TIME_NOTE_EFFECT}
            onSubmit={(text) => createTimeNote({ text, todoId: todo._id })}
          />
          {notes.length > 0 && (
            <FactTable
              columns={NOTE_COLUMNS}
              rows={notes.map((n) => ({
                text: n.text,
                state: `${NOTE_STATE[n.status] ?? n.status}${n.result ? `: ${n.result}` : ""}`,
              }))}
              caption="tts.listTimeNotes → the time notes on this todo"
            />
          )}
        </ItemPanel>
      ) : code ? (
        <ItemPanel
          title={chosen ? "picked" : "next"}
          statement={code.row.statement}
          provenance={`From ${code.row.repo}, ${code.row.externalId}. Prepared ${ageText(code.brief.preparedAt, now)}.`}
          brief={code.brief.brief}
        >
          <ActionRow actions={codeActions(code.row)} />
        </ItemPanel>
      ) : (
        <Prose caption="tts.listTodos → the todos waiting on you">
          <Num>{value(0)}</Num> todos wait on you.
        </Prose>
      )}
      <FigureStrip
        figures={[
          { value: value(counts.overdue), name: "overdue" },
          { value: value(counts.dated), name: "with a date" },
          { value: value(counts.blocking), name: "blocking others" },
          { value: value(counts.doneLast30), name: "done in the last 30 days" },
        ]}
        caption="tts.listTodos → overdue, dated, waited on by an active todo, done since 30 days ago"
      />
      <FactTable
        title="with a date"
        columns={DATED_COLUMNS}
        rows={dated.map(({ todo: t, overdue }) => ({
          statement: t.statement,
          date: t.dueAt === undefined ? "" : fmtDate(t.dueAt),
          state: overdue ? "overdue" : "due",
          source: sourceWords(t.source),
        }))}
        caption="tts.listTodos → active todos with a date, soonest first"
      />
      <Fold summary="done" count={counts.done}>
        <FactTable
          columns={DONE_COLUMNS}
          rows={done.slice(0, 10).map(({ todo: t, at }) => ({
            statement: t.statement,
            date: fmtDate(at),
          }))}
          caption="tts.listTodos → the ten most recently done todos"
        />
      </Fold>
      <Prose
        title="agents this week"
        caption="tts.listRecentEvents({ limit: 1000 }) → events since the date by kind; claudeSessions.listSessions → idle agents and the newest"
      >
        {events === undefined ? (
          "…"
        ) : (
          <>
            Since {fmtDate(week.since)}: <Num>{week.captured}</Num> todos captured,{" "}
            <Num>{week.prepared}</Num> prepared, <Num>{week.merges}</Num> merges,{" "}
            <Num>{week.jobFailures}</Num> job failures, <Num>{week.delegateDecisions}</Num> delegate
            decisions.
          </>
        )}
        {sessions !== undefined && (
          <>
            {" "}
            <Num>{agents.idle}</Num> agents are idle
            {agents.latest && (
              <>
                ; the newest, {agents.latest.title}, started {ageText(agents.latest.at, now)}
              </>
            )}
            .
          </>
        )}
      </Prose>
      <FigureStrip
        figures={[{ value: runners === undefined ? "…" : liveRunners, name: "runners" }]}
        caption="ttsRunners.listRunners → runners not yet ended"
      />
      <Fold summary="runners" count={liveRunners}>
        <RunnersBlock now={now} />
      </Fold>
    </Page>
  );
}
