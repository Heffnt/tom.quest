"use client";

// ONE COMPONENT DRAWS A RUN, AND DRAWS ITS CHILDREN WITH ITSELF.
//
// Tom, 2026-09-10: "there should be one way of viewing agent transcripts that
// is used by the primary agent or infinitely recursive sub agents." So a
// session, a nightly job's run and a Codex child four levels down are the same
// component, the same rows and the same three levels of expansion. What changes
// between them is one prop (`depth`) and two facts on the run row (`kind`,
// `sessionId`) — never a second widget.
//
//   depth === 0  the one header line, the outcome block, the rows, and the
//                composer when and only when the run is a session.
//   depth  >  0  a <details> whose summary is the child's compact line and
//                whose body is the child's rows. No header, no composer, no
//                controls: Tom does not talk to child runs ("no I don't want to
//                talk to sub-agents").
//
// The recursion is Run → RunRows → a `child-run` row → Run at depth + 1. There
// is no second component for a subagent and no single-level fold.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import Info from "@/app/tts/components/info";
import type { SessionModel, TranscriptMessage } from "../lib";
import { useRunRows } from "../use-run-rows";
import {
  MODEL_CHIP_CLASS,
  ageText,
  childRunOf,
  costText,
  isLive,
  modelFamily,
  previewLine,
  runStatusChipClass,
  sessionModel,
  statusChipClass,
} from "../lib";
import RunRows from "./run-rows";
import Composer from "./composer";
import ModelSelect from "./model-select";
import ForkDialog from "./fork-dialog";

/**
 * How deep the page mounts before it stops and offers a link instead. Convex
 * refuses parent cycles at ingest (convex/runs.ts parentCycleLength), but a
 * stub chain arriving out of order can still be long, and an unbounded
 * recursive mount is a hung browser. Past the cap a child still renders its
 * line and an `open` control, so every run in the tree is reachable.
 */
export const MAX_NESTING_DEPTH = 6;

type RunDoc = Doc<"runs">;
/** The parent's `child-run` row, absent on a run opened as the page itself. */
type ChildFacts = ReturnType<typeof childRunOf> | undefined;

/** The compact line of a child run — the same facts §23.6 gives a child-run
 *  row, read off the child's own run row once it is loaded and off the parent's
 *  row until then. */
function childLine(facts: ChildFacts, run: RunDoc | null | undefined): string[] {
  return [
    facts?.agentType ?? run?.kind,
    run?.model ?? facts?.model,
    run?.status ?? facts?.status,
    run === null || run === undefined ? undefined : `depth ${run.depth}`,
    (run?.outcome?.totals.totalTokens ?? facts?.totalTokens) === undefined
      ? undefined
      : `${run?.outcome?.totals.totalTokens ?? facts?.totalTokens} tok`,
    costText(run?.outcome?.costUsd) || undefined,
  ].filter((fact): fact is string => typeof fact === "string" && fact !== "");
}

export default function Run({
  runId,
  sessionId,
  childFacts,
  depth,
  now,
  daemonStale = false,
  daemonLastSeenAt,
  lastIngestError,
  onBack,
  onOpenRun,
  onOpenSession,
}: {
  /** The run record's id. Absent only for a session whose run has not landed. */
  runId?: string;
  /** The live session row's id, when this run is a session. */
  sessionId?: Id<"claudeSessions">;
  /** The parent's `child-run` row, so a stub still has a line to draw. */
  childFacts?: ChildFacts;
  /** 0 = this run is the page; > 0 = nested under its parent. */
  depth: number;
  now: number;
  daemonStale?: boolean;
  daemonLastSeenAt?: number;
  lastIngestError?: string;
  onBack?: () => void;
  /** Re-root the page on a run (?run=). */
  onOpenRun: (runId: string) => void;
  /** Re-root the page on a session (?session=). */
  onOpenSession: (sessionId: Id<"claudeSessions">) => void;
}) {
  const capped = depth > MAX_NESTING_DEPTH;
  const [open, setOpen] = useState(false);
  // A nested run reads nothing until it is opened: a run with three hundred
  // descendants must open as fast as one with none (§23.5).
  const active = !capped && (depth === 0 || open);

  const runFromId = useQuery(
    api.runs.get,
    active && runId !== undefined ? { runId } : "skip",
  );
  const sessionFromId = useQuery(
    api.claudeSessions.getSession,
    active && sessionId !== undefined ? { id: sessionId } : "skip",
  );
  // A session addressed by its own id finds its run row through session.runId;
  // a run addressed by its run id finds its session through run.sessionId. Both
  // directions exist because most sessions predate the record.
  const runFromSession = useQuery(
    api.runs.get,
    active && runId === undefined && sessionFromId?.runId !== undefined
      ? { runId: sessionFromId.runId }
      : "skip",
  );
  const sessionFromRun = useQuery(
    api.claudeSessions.getSession,
    active && sessionId === undefined && runFromId?.sessionId !== undefined
      ? { id: runFromId.sessionId }
      : "skip",
  );

  const run = runId !== undefined ? runFromId : runFromSession;
  const session = sessionId !== undefined ? sessionFromId : sessionFromRun;
  const resolvedRunId = runId ?? session?.runId ?? undefined;
  const subjectSessionId = sessionId ?? run?.sessionId;

  const { rows, status: pageStatus, loadMore, source } = useRunRows(
    active ? { runId: resolvedRunId, sessionId: subjectSessionId } : {},
  );

  const children = useQuery(
    api.runs.children,
    active && resolvedRunId !== undefined && pageStatus !== "LoadingFirstPage"
      ? { runId: resolvedRunId }
      : "skip",
  );

  // A child named by a loaded `child-run` row renders inline at that row and
  // nowhere else; the remainder renders as a list below the rows. Both sets
  // come out of ONE pass over the same loaded window, so a child is never drawn
  // twice and never invisible — which is how a Codex child (whose parent's file
  // names no spawning call) and a stub whose parent's result line has not
  // landed still appear.
  const unmatched = useMemo(() => {
    const named = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "child-run") continue;
      const facts = childRunOf(row.content);
      if (facts !== null) named.add(facts.childRunId);
    }
    return (children?.items ?? []).filter((child) => !named.has(child.runId));
  }, [rows, children]);

  const renameSession = useMutation(api.claudeSessions.renameSession);
  const setSessionModel = useMutation(api.claudeSessions.setSessionModel);
  const forkSessionAs = useMutation(api.claudeSessions.forkSessionAs);
  const [forkTo, setForkTo] = useState<SessionModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  // Rename: the title IS the control — tapping it swaps in an input that looks
  // the same. Enter blurs (the blur handler is the single save path); Escape
  // sets this flag first so the blur it causes discards instead of saving.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const cancelRename = useRef(false);

  // These three are referentially stable across the page's 15s age tick, so
  // RunRows' memo still holds and the tick does not re-render every row — the
  // reason the rows pane was memoized in the first place.
  const renderChildRun = useCallback(
    (row: TranscriptMessage, childRunId: string) => (
      <Run
        key={row._id}
        runId={childRunId}
        childFacts={childRunOf(row.content)}
        depth={depth + 1}
        now={now}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />
    ),
    // `now` is read only by the depth-0 header, so a child mounted with a stale
    // one shows nothing stale; keeping it out of the deps is what makes this
    // callback stable across the tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depth, onOpenRun, onOpenSession],
  );

  const live = session !== null && session !== undefined && isLive(session.status);
  const rowsEmpty =
    rows.length === 0 &&
    (pageStatus === "Exhausted" || pageStatus === "CanLoadMore");
  const hasRows = rows.length > 0;

  // ── OPENING AN OLD RUN FROM THE STORE ──────────────────────────────────
  // Convex holds the run index and a bounded window of rows; the store holds
  // every version (§23.4). So a run outside the window has a header, an
  // outcome and no transcript, and the way back is to ask for it: the press
  // queues a request, worker/runs/materialize.mjs reads the stored version,
  // parses it with the CURRENT parser and ingests the rows through the same
  // /runs/ingest door the sweep uses. Nothing here fetches anything — the
  // rows arrive on the subscription this page already holds, and this line
  // goes away when they do.
  const requestMaterialize = useMutation(api.runs.requestMaterialize);
  const markOpened = useMutation(api.runs.markOpened);
  const [storeError, setStoreError] = useState<string | null>(null);
  // Subscribed only while there is something for it to say: this run is the
  // page, its rows are missing, and there is a stored version to fetch them
  // from. When the rows land the query is skipped again with the line.
  const materializeStatus = useQuery(
    api.runs.materializeStatus,
    depth === 0 &&
      resolvedRunId !== undefined &&
      rowsEmpty &&
      run?.file.storeKey !== undefined
      ? { runId: resolvedRunId }
      : "skip",
  );
  const openFromStore = useCallback(() => {
    if (resolvedRunId === undefined) return;
    setStoreError(null);
    void requestMaterialize({ runId: resolvedRunId }).catch((e: unknown) => {
      // The mutation's refusals are fixed phrases ("run has no store key"),
      // so this is bounded text, not a payload echoed back.
      setStoreError(
        e instanceof Error ? previewLine(e.message, 80) : "the request was refused",
      );
    });
  }, [requestMaterialize, resolvedRunId]);

  // READING A RUN IS WHAT KEEPS IT. runs.markOpened moves the row window
  // forward 30 days, clamped so six reads in an afternoon are one write, and
  // it does nothing at all for a run whose rows are not in the record — an
  // index-only backlog run is not made evictable by being looked at. Fire and
  // forget, once per page load: there is nothing for the reader to see.
  //
  // It is a write that fires on arrival, which app/AGENTS.md gates on Tom.
  // TomGate mounts this component for nobody else and the mutation requires
  // Tom itself, so the gate holds on both sides.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (depth !== 0 || resolvedRunId === undefined || !hasRows) return;
    if (marked.current === resolvedRunId) return;
    marked.current = resolvedRunId;
    void markOpened({ runId: resolvedRunId }).catch(() => {});
  }, [depth, resolvedRunId, hasRows, markOpened]);

  const lead = useMemo(
    () => (
      <Lead
        run={run ?? null}
        session={session ?? null}
        live={live}
        rowsEmpty={rowsEmpty}
        request={materializeStatus}
        storeError={storeError}
        onOpenFromStore={openFromStore}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />
    ),
    [
      run,
      session,
      live,
      rowsEmpty,
      materializeStatus,
      storeError,
      openFromStore,
      onOpenRun,
      onOpenSession,
    ],
  );
  const tail = useMemo(
    () =>
      unmatched.length === 0 ? null : (
        <UnmatchedChildren children_={unmatched} onOpenRun={onOpenRun} />
      ),
    [unmatched, onOpenRun],
  );

  // ── Past the cap: the line, and the way to read it as a page of its own ──
  if (capped) {
    return (
      <div className="flex flex-wrap items-baseline gap-2 border-l border-border pl-3 py-0.5 text-xs text-text-faint">
        <span className="font-mono text-text-muted">child</span>
        {childLine(childFacts, undefined).map((fact) => (
          <span key={fact} className="font-mono">
            {fact}
          </span>
        ))}
        <span className="truncate min-w-0">
          {previewLine(childFacts?.description ?? childFacts?.childRunId ?? "", 80)}
        </span>
        {runId !== undefined && (
          <button
            type="button"
            onClick={() => onOpenRun(runId)}
            className="text-accent underline underline-offset-2 hover:text-text"
          >
            open this run as the page
          </button>
        )}
      </div>
    );
  }

  // ── Nested: the child's line, and its rows behind it ─────────────────────
  if (depth > 0) {
    return (
      <details
        className="text-sm"
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer list-none flex flex-wrap items-baseline gap-2 px-1 py-0.5 text-xs text-text-faint hover:text-text-muted">
          <span className="font-mono text-text-muted">child</span>
          {childLine(childFacts, run).map((fact) => (
            <span key={fact} className="font-mono">
              {fact}
            </span>
          ))}
          <span className="truncate min-w-0">
            {previewLine(
              childFacts?.description ?? childFacts?.childRunId ?? runId ?? "",
              80,
            )}
          </span>
        </summary>
        <div className="mt-1 border-l border-border pl-3">
          {open && run === null ? (
            // §23.5's honest state: the child is known, its file is not here.
            <div className="text-xs text-text-faint px-1">file not landed</div>
          ) : (
            <RunRows
              rows={rows}
              pageStatus={pageStatus}
              loadMore={loadMore}
              source={source}
              depth={depth}
              runKey={resolvedRunId ?? runId ?? "unknown"}
              renderChildRun={renderChildRun}
              tail={tail}
            />
          )}
        </div>
      </details>
    );
  }

  // ── depth 0: the page ────────────────────────────────────────────────────
  if (run === undefined && session === undefined) {
    return <div className="px-4 py-6 text-sm text-text-faint">loading run…</div>;
  }
  if (run === null && (session === null || session === undefined)) {
    return (
      <div className="px-4 py-6 space-y-3">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted break-words">
          this record does not hold {runId ?? String(sessionId)}
        </div>
        {onBack !== undefined && (
          <button
            type="button"
            onClick={onBack}
            className="rounded px-3 py-1.5 text-sm border border-border text-text-muted hover:bg-surface-alt"
          >
            back to the list
          </button>
        )}
      </div>
    );
  }

  const model = session ? sessionModel(session) : undefined;

  const commitRename = (value: string) => {
    setTitleDraft(null);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const next = value.trim();
    if (!session || next === "" || next === session.title) return;
    void renameSession({ sessionId: session._id, title: next });
  };

  // Inside one family the row is simply repointed and the next turn goes to the
  // new model. Across families the transcript cannot move — Claude Code and the
  // Codex CLI hold different conversations — so the change is a new session
  // seeded with this one's transcript, which is what the dialog collects a
  // first message for.
  const changeModel = (next: SessionModel) => {
    if (!session || model === undefined || next === model) return;
    setModelError(null);
    if (modelFamily(next) !== modelFamily(model)) {
      setForkTo(next);
      return;
    }
    void (async () => {
      try {
        await setSessionModel({ sessionId: session._id, model: next });
      } catch (e) {
        setModelError(e instanceof Error ? e.message : "model change failed");
      }
    })();
  };

  const title = session
    ? session.title
    : run
      ? `${run.kind} · ${run.origin}`
      : (runId ?? "");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ONE LINE (Tom's open goal ph7bahm3hmk96xnctpbztt2bn18dfmxe: "remove
          the clutter at the top of the session screen so that the chat window
          goes all the way up to the top"). Everything the three stacked lines
          and the daemon banner used to hold is still on the page: repo and cwd
          on the context row, age and outcome in the outcome block below, the
          linked item and the run it continues with them, and the two daemon
          facts appended here while they are true. */}
      <header className="border-b border-border px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 min-w-0">
        {onBack !== undefined && (
          <button
            type="button"
            onClick={onBack}
            aria-label="back to the list"
            className="shrink-0 rounded px-2 py-1 text-sm border border-border text-text-muted hover:bg-surface-alt"
          >
            &larr;
          </button>
        )}
        {session && titleDraft !== null ? (
          <input
            type="text"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
            className="text-sm sm:text-base text-text min-w-0 flex-1 bg-transparent border-b border-accent/60 focus:outline-none"
          />
        ) : (
          <h1
            onClick={
              session
                ? () => {
                    cancelRename.current = false;
                    setTitleDraft(session.title);
                  }
                : undefined
            }
            className={`text-sm sm:text-base text-text truncate min-w-0 flex-1 ${session ? "cursor-text" : ""}`}
          >
            {title}
          </h1>
        )}
        {session && (
          // Nothing renames a run row, so this control exists for a session and
          // for nothing else.
          <Info call="claudeSessions.renameSession({ sessionId, title })">
            The title is the control: tap it and type. Leaving the box saves the
            new title on the session row — nothing else about the session
            changes, and the running session is not told.
          </Info>
        )}
        {session ? (
          <span
            className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${statusChipClass(session.status)}`}
          >
            {session.status}
          </span>
        ) : (
          run && (
            <span
              className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${runStatusChipClass(run.status)}`}
            >
              {run.status}
            </span>
          )
        )}
        {session && model !== undefined ? (
          <>
            {/* The model is a control on a session: Tom picks it mid-run. An
                ended session has no runner to repoint, so the select is
                disabled rather than hidden — the fact stays readable. */}
            <ModelSelect
              ariaLabel="session model"
              compact
              value={model}
              disabled={!live}
              onChange={changeModel}
            />
            <Info call="claudeSessions.setSessionModel({ sessionId, model })">
              Which model answers the next turn. Inside one family the running
              session is simply repointed and keeps these rows. Across families
              — Claude Code to the Codex CLI or back — it cannot be, so picking
              one opens a dialog that starts a new session from this
              one&rsquo;s transcript instead.
            </Info>
          </>
        ) : (
          run?.model !== undefined && (
            // A finished run's model is a fact, not a control.
            <span className={`shrink-0 ${MODEL_CHIP_CLASS}`}>{run.model}</span>
          )
        )}
        {costText(run?.outcome?.costUsd) !== "" && (
          <span className="shrink-0 font-mono text-xs text-text-faint">
            {costText(run?.outcome?.costUsd)}
          </span>
        )}
        {/* The daemon banner was a band of its own above the rows; while it is
            true and the session is live, it is these two suffixes. */}
        {daemonStale && live && (
          <span className="text-xs text-text-faint">
            ·{" "}
            {daemonLastSeenAt !== undefined
              ? `worker last heard from ${ageText(daemonLastSeenAt, now)}`
              : "worker has not reported yet"}
          </span>
        )}
        {lastIngestError !== undefined && live && (
          <span className="text-xs text-text-faint truncate min-w-0">
            · last rejected write: {previewLine(lastIngestError, 80)}
          </span>
        )}
        {modelError && <span className="text-xs text-error">{modelError}</span>}
      </header>

      <RunRows
        rows={rows}
        pageStatus={pageStatus}
        loadMore={loadMore}
        source={source}
        depth={0}
        runKey={resolvedRunId ?? String(sessionId)}
        sessionId={subjectSessionId}
        sessionStatus={session?.status}
        renderChildRun={renderChildRun}
        lead={lead}
        tail={tail}
      />

      {/* The composer is for a session and for nothing else — never on a
          background run, never on a child, at any depth. Slack is how Tom
          interacts with a background run (§20.4), and a disabled composer on a
          run would be a control over nothing. */}
      {session && <Composer session={session} daemonStale={daemonStale} />}

      {forkTo !== null && session && (
        <ForkDialog
          fromModel={model ?? forkTo}
          toModel={forkTo}
          onClose={() => setForkTo(null)}
          onConfirm={async (text) => {
            const newId = await forkSessionAs({
              sessionId: session._id,
              model: forkTo,
              text,
            });
            setForkTo(null);
            onOpenSession(newId);
          }}
        />
      )}
    </div>
  );
}

/**
 * THE OUTCOME, ARRIVAL-FIRST AND INSIDE THE SCROLL REGION. §20.3 wants what an
 * ended run came to ahead of the rows it came to it in; Tom's goal wants the
 * rows to reach the top. A block that scrolls away satisfies both — it is the
 * first thing on arrival and costs nothing once he is reading.
 */
function Lead({
  run,
  session,
  live,
  rowsEmpty,
  request,
  storeError,
  onOpenFromStore,
  onOpenRun,
  onOpenSession,
}: {
  run: RunDoc | null;
  session: Doc<"claudeSessions"> | null;
  live: boolean;
  rowsEmpty: boolean;
  /** The newest materialize request for this run: runs.materializeStatus. */
  request?: Doc<"runMaterializeRequests"> | null;
  /** A refusal from the press itself, as opposed to one from the box. */
  storeError?: string | null;
  onOpenFromStore?: () => void;
  onOpenRun: (runId: string) => void;
  onOpenSession: (sessionId: Id<"claudeSessions">) => void;
}) {
  const outcome = run?.outcome;
  const errored = session?.outcome === "errored" || run?.status === "failed";
  const totals = outcome?.totals;
  const facts = [
    outcome === undefined ? undefined : `${outcome.turns} turns`,
    outcome === undefined ? undefined : `${outcome.toolCalls} tool calls`,
    totals === undefined ? undefined : `${totals.totalTokens} tokens`,
    costText(outcome?.costUsd) || undefined,
  ].filter((fact): fact is string => typeof fact === "string");

  const summary = session
    ? session.outcome === undefined
      ? undefined
      : `${session.outcome}${session.outcomeSummary ? ` — ${session.outcomeSummary}` : ""}`
    : outcome?.endedReason;

  const nothing =
    live || (summary === undefined && facts.length === 0 && !rowsEmpty);
  if (nothing) return null;

  const continues = run?.continuesRunId ?? undefined;
  const forkedFrom = session?.forkedFrom;

  return (
    <div className="border border-border rounded-lg bg-surface/40 px-3 py-2 space-y-1 text-xs">
      {summary !== undefined && (
        <div className={`break-words ${errored ? "text-error" : "text-text-muted"}`}>
          {summary}
        </div>
      )}
      {facts.length > 0 && (
        <div className="flex flex-wrap gap-x-3 text-text-faint font-mono">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 text-text-faint">
        {run?.todoId !== undefined && (
          <Link
            href={`/tts?item=${run.todoId}`}
            className="text-accent underline underline-offset-2 hover:text-text"
          >
            linked item
          </Link>
        )}
        {session?.todoId !== undefined && run?.todoId === undefined && (
          <Link
            href={`/tts?item=${session.todoId}`}
            className="text-accent underline underline-offset-2 hover:text-text"
          >
            linked item
          </Link>
        )}
        {run?.batchId !== undefined && (
          <Link
            href={`/tts?batch=${run.batchId}`}
            className="text-accent underline underline-offset-2 hover:text-text"
          >
            linked batch
          </Link>
        )}
        {continues !== undefined && (
          <button
            type="button"
            onClick={() => onOpenRun(continues)}
            className="text-accent underline underline-offset-2 hover:text-text break-all"
          >
            continues {continues}
          </button>
        )}
        {forkedFrom !== undefined && (
          <button
            type="button"
            onClick={() => onOpenSession(forkedFrom)}
            className="text-accent underline underline-offset-2 hover:text-text"
          >
            continues {forkedFrom.slice(0, 6)}
          </button>
        )}
      </div>
      {rowsEmpty && run !== null && (
        // The 30-day row window has passed this run by, or it was never
        // ingested at all (§23.4). The store still holds the version, so the
        // line carries the one control that brings it back.
        <div className="font-mono text-[10px] text-text-faint break-words flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>
            rows not in the record · {run.file.path.split(/[\\/]/).pop() || "no file"} ·
            version {run.file.storedHash.slice(0, 12)}
          </span>
          {request?.status === "pending" ? (
            // One true sentence and no spinner: nothing is streaming here.
            // The box takes the oldest request on its next minute.
            <span>opening from the store · slice {request.slice}</span>
          ) : (
            run.file.storeKey !== undefined &&
            onOpenFromStore !== undefined && (
              <>
                {request?.status === "failed" && (
                  // A fixed phrase from the job's closed vocabulary, so a
                  // transient store failure is one more press, not a dead end.
                  <span className="text-error">
                    could not open · {request.reason ?? "no reason given"}
                  </span>
                )}
                {storeError !== null && storeError !== undefined && (
                  <span className="text-error">could not open · {storeError}</span>
                )}
                <button
                  type="button"
                  onClick={onOpenFromStore}
                  className="text-accent underline underline-offset-2 hover:text-text"
                >
                  open this run from the store
                </button>
                <Info call="runs.requestMaterialize({ runId })">
                  Queues this run for the box. It reads the stored version of
                  the file back, parses it with the current parser and writes
                  the rows into the record — within a minute, and the rows
                  appear here on their own. Nothing on the host is touched.
                </Info>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The children this run's loaded rows did not name — a Codex child, whose
 * parent's file names no spawning call, and a stub whose parent's result line
 * has not landed yet. Each opens as a page of its own.
 */
function UnmatchedChildren({
  children_,
  onOpenRun,
}: {
  children_: RunDoc[];
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div className="border-t border-border pt-2 space-y-1">
      <div className="text-xs text-text-faint">
        {children_.length} child runs no row in this window names
      </div>
      <ul className="space-y-0.5">
        {children_.map((child) => (
          <li key={child.runId}>
            <button
              type="button"
              onClick={() => onOpenRun(child.runId)}
              className="w-full text-left flex flex-wrap items-baseline gap-2 px-1 py-0.5 rounded text-xs text-text-faint hover:bg-surface-alt/50"
            >
              <span className="font-mono text-text-muted">{child.kind}</span>
              <span className="font-mono">{child.status}</span>
              {child.model !== undefined && (
                <span className="font-mono">{child.model}</span>
              )}
              <span className="font-mono">depth {child.depth}</span>
              <span className="truncate min-w-0 break-all">{child.runId}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
