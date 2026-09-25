"use client";

// THE ROWS OF ONE RUN. Carried forward from the transcript pane rather than
// rewritten: the paging states, the scroll anchoring and its guards, the unread
// divider, the turn clocks, the live tail, the pending-inbound
// echo and the jump-to-latest button are all proven code and they stay.
//
// A session's rows are its agent file's (one transcript path, 2026-09-25):
// they land when the sweep reads the file at the end of a turn, so during a
// turn the page shows the live tail, Tom's delivered turn (getPendingInbound
// returns it until its row lands) and nothing else. The daemon's notes about a
// session — a model change, a rebuilt workspace — are not rows; they come
// from sessionRows.notes and are drawn between the rows by time.
//
// Three things changed, and only three:
//   1. The rows arrive as a prop from useAgentRows (../use-agent-rows), so one memo
//      in <Agent/> can match child runs against the same loaded window this file
//      pairs tool calls over.
//   2. A `child-run` row mounts the child run itself (renderChildRun), because
//      one component draws a run at every depth. That is where a subagent's
//      rows are: in its own run, not folded into its parent's. parentToolUseId
//      on a row names the tool call it answers (worker/agents/ingest.mjs), and
//      nothing here groups on it.
//   3. A run that is not a session has no live tail and shows none: work with
//      what the CLIs give, and never hold a spinner open for output that is not
//      coming (§23.3).

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { BoxChangeRow, TranscriptMessage } from "../lib";
import {
  boxChangeLabel,
  boxChangeText,
  childRunOf,
  compactInput,
  formatClock,
  isLive,
  placeBoxChanges,
  previewLine,
  toolInputOf,
  toolNameOf,
  toolUseIdOf,
} from "../lib";
import AgentRow from "./agent-row";
import type { PairedResult, RowSource } from "./agent-row";

const NEAR_BOTTOM_PX = 150;

/**
 * Where the reader got to last visit, per AGENT. The prefix changed with the
 * page's name, and a mark kept under the old prefix is not read: each agent
 * shows no unread divider until the next visit writes a mark, as after commit
 * 58b13a9c.
 */
const lastReadKey = (runKey: string) =>
  `tts.agents.lastReadSeq.${runKey}`;

// toolUseId → toolName over the loaded window, so a tool-result row can name
// the call it answers. A result whose call has not been paged in shows no name.
function toolNameIndex(messages: TranscriptMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.kind !== "tool-call") continue;
    const id = toolUseIdOf(message.content);
    if (id !== undefined) names.set(id, toolNameOf(message.content));
  }
  return names;
}

/**
 * A tool-call consumes its tool-result when both are in the same loaded window;
 * a result whose call is paged out keeps rendering on its own.
 */
function pairRows(messages: TranscriptMessage[]): {
  forCall: Map<string, PairedResult>;
  consumed: Set<string>;
} {
  const results = new Map<string, TranscriptMessage>();
  for (const message of messages) {
    if (message.kind !== "tool-result") continue;
    const id = toolUseIdOf(message.content);
    if (id !== undefined && !results.has(id)) results.set(id, message);
  }
  const forCall = new Map<string, PairedResult>();
  const consumed = new Set<string>();
  for (const call of messages) {
    if (call.kind !== "tool-call") continue;
    const id = toolUseIdOf(call.content);
    if (id === undefined) continue;
    const result = results.get(id);
    if (result === undefined) continue;
    // createdAt is the file line's own timestamp, so this is a measurement.
    const elapsed = result.createdAt - call.createdAt;
    forCall.set(call._id, {
      row: result,
      durationMs:
        call.createdAt > 0 && result.createdAt > 0 && elapsed >= 0
          ? elapsed
          : undefined,
    });
    consumed.add(result._id);
  }
  return { forCall, consumed };
}

// The turn separator's clock: the user line's own timestamp, a turn marker. Static text: no ticking, so the memo below holds.
function TurnDivider({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-3 pt-3 pb-1" aria-hidden>
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-[10px] text-text-faint">
        {formatClock(at)}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// The last tool-call in the loaded window with no tool-result answering it — the call the agent is still inside. Null when there is none.
function openToolCall(
  messages: TranscriptMessage[],
): { name: string; preview: string } | null {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.kind !== "tool-result") continue;
    const id = toolUseIdOf(m.content);
    if (id !== undefined) answered.add(id);
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind !== "tool-call") continue;
    const id = toolUseIdOf(m.content);
    if (id === undefined || answered.has(id)) continue;
    const name = toolNameOf(m.content);
    return {
      name,
      preview: previewLine(compactInput(name, toolInputOf(m.content)), 64),
    };
  }
  return null;
}

/** A note the daemon wrote about the session, where it happened among the rows. */
function NoteLine({ note }: { note: SessionNote }) {
  return (
    <div className="flex items-baseline gap-2 px-1 text-xs text-text-faint">
      <span className="font-mono text-[10px] shrink-0">{formatClock(note.at)}</span>
      <span className="whitespace-pre-wrap break-words min-w-0">{note.text}</span>
    </div>
  );
}

type SessionNote = { _id: string; at: number; text: string };

/**
 * A change this agent made to the Jarvis Box as root (convex/boxChanges.ts),
 * marked so it cannot be read as the agent's own words: the time, what kind
 * of change, and the command or what changed. It sits right after the tool
 * call that ran it, whose row carries the outcome, or among the rows by time.
 */
function BoxChangeLine({ change }: { change: BoxChangeRow }) {
  return (
    <div
      data-box-change={change.id}
      className="flex items-baseline gap-2 border-l-2 border-warning/70 bg-warning/5 rounded-r px-2 py-1 text-xs"
    >
      <span className="font-mono text-[10px] text-text-faint shrink-0">{formatClock(change.at)}</span>
      <span className="shrink-0 rounded border border-warning/50 px-1 text-[10px] uppercase tracking-wide text-warning">
        {boxChangeLabel(change)}
      </span>
      <span className="font-mono text-text-muted whitespace-pre-wrap break-all min-w-0">{boxChangeText(change)}</span>
    </div>
  );
}

/**
 * Which timed lines go before each row, and which after the last one. A
 * line sits before the first row later than it. A line
 * older than every loaded row is drawn only once the window reaches the
 * session's start (`startLoaded`): until then an earlier row may still belong
 * in front of it. The daemon's notes and the box changes no call ran are both
 * placed this way.
 */
function placeNotes<T extends { at: number }>(
  rows: TranscriptMessage[],
  notes: T[],
  startLoaded: boolean,
): { before: Map<string, T[]>; after: T[] } {
  const before = new Map<string, T[]>();
  let next = 0;
  rows.forEach((anchor, index) => {
    const here: T[] = [];
    while (next < notes.length && notes[next].at < anchor.createdAt) {
      if (index > 0 || startLoaded) here.push(notes[next]);
      next += 1;
    }
    if (here.length > 0) before.set(anchor._id, here);
  });
  return { before, after: notes.slice(next) };
}

/** A turn Tom sent that no row records yet, and where it stands. */
function TurnEcho({ text, state }: { text: string; state: string }) {
  return (
    <div className="border-l-2 border-accent/50 bg-surface-alt/30 rounded-r px-3 py-2 ml-6 sm:ml-16">
      <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text-muted">
        {text}
      </pre>
      <div className="text-xs text-text-faint mt-1">{state}</div>
    </div>
  );
}

function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-accent/40" />
      <span className="text-[10px] text-accent/80">
        — new since your last visit —
      </span>
      <div className="h-px flex-1 bg-accent/40" />
    </div>
  );
}

// Memoized: the parent tree re-renders on a 15s age tick, and the rows show no
// ages, so the tick must not re-render every row.
const AgentRows = memo(function AgentRows({
  rows,
  pageStatus,
  loadMore,
  source,
  depth,
  runKey,
  sessionId,
  sessionStatus,
  agentId,
  lead,
  tail,
  renderChildRun,
}: {
  /** Ascending, oldest first, from useAgentRows. */
  rows: TranscriptMessage[];
  pageStatus: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
  source: RowSource;
  /** 0 = this run is the page and owns the scrolling region. */
  depth: number;
  /** Identity for the unread mark. */
  runKey: string;
  /** The live tail's subject; absent on a run that is not a session. */
  sessionId?: Id<"claudeSessions">;
  sessionStatus?: string;
  /** The run's id in the record, whose box changes are drawn among its rows. */
  agentId?: string;
  /** The outcome block — first thing inside the scrolling region (§20.3). */
  lead?: React.ReactNode;
  /** The unmatched children list, after the last row. */
  tail?: React.ReactNode;
  /** Mounts the child run a `child-run` row names. */
  renderChildRun?: (
    row: TranscriptMessage,
    childRunId: string,
  ) => React.ReactNode;
}) {
  const nested = depth > 0;
  const streamBuf = useQuery(
    api.claudeSessions.getStreamBuf,
    sessionId !== undefined ? { sessionId } : "skip",
  );
  const pendingInbound = useQuery(
    api.claudeSessions.getPendingInbound,
    sessionId !== undefined ? { sessionId } : "skip",
  );
  const notes = useQuery(
    api.sessionRows.notes,
    sessionId !== undefined ? { sessionId } : "skip",
  );
  const boxChanges = useQuery(
    api.boxChanges.forAgent,
    agentId !== undefined ? { agentId } : "skip",
  );

  const toolNames = useMemo(() => toolNameIndex(rows), [rows]);
  const pairing = useMemo(() => pairRows(rows), [rows]);
  // Session pages load newest first, so the window holds the session's start
  // only once paging is exhausted; a run's pages start there.
  const placed = useMemo(
    () =>
      placeNotes(
        rows,
        notes ?? [],
        source !== "session" || pageStatus === "Exhausted",
      ),
    [rows, notes, source, pageStatus],
  );
  // Box changes: after the call that ran each one, or by time among the rows.
  const boxPlaced = useMemo(() => {
    const { afterCall, byTime } = placeBoxChanges(rows, boxChanges ?? []);
    return {
      afterCall,
      timed: placeNotes(rows, byTime, source !== "session" || pageStatus === "Exhausted"),
    };
  }, [rows, boxChanges, source, pageStatus]);
  const boxAfter = (row: TranscriptMessage) =>
    boxPlaced.afterCall.get(row._id)?.map((change) => (
      <BoxChangeLine key={change.id} change={change} />
    ));
  const pendingTurns = (pendingInbound ?? []).filter(
    (row) => row.kind === "user-turn",
  );
  const deliveredTurns = pendingTurns.filter((row) => row.status !== "pending");
  const queuedTurns = pendingTurns.filter((row) => row.status === "pending");
  const pendingControls = (pendingInbound ?? []).filter(
    (row) => row.kind !== "user-turn",
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  // Set when "load earlier" is pressed; consumed only once the older rows
  // actually land (the first row's seq drops), NOT on the pageStatus flip —
  // that fires before the rows exist and would apply a ~0px correction, then
  // none when the page arrives.
  const earlierAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const prevFirstSeqRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  // Unread mark. The stored seq is read ONCE, on mount, into state — so the
  // divider is frozen where the reader left off and does not creep down as new
  // rows land during the visit. localStorage throws in some privacy modes;
  // every touch is guarded and a failure simply means no divider.
  const [lastReadSeq, setLastReadSeq] = useState<number | null>(null);
  const didReadStorageRef = useRef(false);
  const storageKey = lastReadKey(runKey);
  useEffect(() => {
    if (nested) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const seq = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(seq)) setLastReadSeq(seq);
    } catch {
      // storage unavailable — no divider, nothing else changes
    }
    didReadStorageRef.current = true;
  }, [storageKey, nested]);

  // The row the divider sits above: the first one after the stored seq.
  const unreadRowKey = useMemo(() => {
    if (lastReadSeq === null) return null;
    return rows.find((row) => row.seq > lastReadSeq)?._id ?? null;
  }, [rows, lastReadSeq]);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottomRef.current = true;
    setShowJump(false);
  };

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = fromBottom < NEAR_BOTTOM_PX;
    if (nearBottomRef.current) setShowJump(false);
  };

  const contentSignature = `${rows.length}:${streamBuf?.text.length ?? 0}:${
    pendingTurns.length
  }:${pendingControls.length}:${notes?.length ?? 0}:${boxChanges?.length ?? 0}`;

  const firstSeq = rows.length > 0 ? rows[0].seq : null;
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : null;

  useLayoutEffect(() => {
    // THE SESSION BRANCH PAGES NEWEST FIRST, so "load earlier" grows the list
    // at the TOP and the reader's position has to be compensated. The run
    // branch pages oldest first: "load more" appends at the bottom and needs
    // none of this.
    //
    // AUTO-SCROLL IS FOR A TAIL THAT IS STILL ARRIVING, and nothing else.
    // app/AGENTS.md's first UI rule is that nothing moves the reader
    // unexpectedly, so it fires only while the session is live. A finished run
    // — session or not — opens where its lead is: the outcome block, then the
    // rows, read forwards (§20.3).
    if (nested || source !== "session") return;
    if (didReadStorageRef.current && lastSeq !== null) {
      try {
        window.localStorage.setItem(storageKey, String(lastSeq));
      } catch {
        // storage unavailable — the mark just doesn't move
      }
    }
    const el = containerRef.current;
    if (!el) return;
    const prevFirstSeq = prevFirstSeqRef.current;
    prevFirstSeqRef.current = firstSeq;
    if (earlierAnchorRef.current !== null) {
      if (
        firstSeq !== null &&
        prevFirstSeq !== null &&
        firstSeq < prevFirstSeq
      ) {
        const anchor = earlierAnchorRef.current;
        el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
        earlierAnchorRef.current = null;
      } else if (pageStatus !== "LoadingMore") {
        earlierAnchorRef.current = null;
      }
      return;
    }
    if (!isLive(sessionStatus ?? "")) return;
    if (!didInitialScrollRef.current) {
      if (pageStatus === "LoadingFirstPage") return;
      didInitialScrollRef.current = true;
      scrollToBottom();
      return;
    }
    if (nearBottomRef.current) {
      scrollToBottom();
    } else {
      setShowJump(true);
    }
  }, [
    contentSignature,
    pageStatus,
    firstSeq,
    lastSeq,
    storageKey,
    nested,
    source,
    sessionStatus,
  ]);

  const loadPage = () => {
    const el = containerRef.current;
    earlierAnchorRef.current =
      source === "session" && el
        ? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
        : null;
    loadMore(60);
  };

  // What the agent is doing right now — derived, never asserted.
  const runningTool = useMemo(
    () => (sessionStatus === "running" ? openToolCall(rows) : null),
    [rows, sessionStatus],
  );

  // The buf row survives a turn as an empty string, so "is text streaming" is a
  // text check, not a row check.
  const streaming = (streamBuf?.text ?? "") !== "";

  const empty =
    pageStatus !== "LoadingFirstPage" &&
    rows.length === 0 &&
    !streamBuf &&
    pendingTurns.length === 0 &&
    pendingControls.length === 0 &&
    (notes ?? []).length === 0 &&
    (boxChanges ?? []).length === 0;

  const body = (
    <>
      {lead}
      {pageStatus === "CanLoadMore" && (
        <div className="text-center">
          <button
            type="button"
            onClick={loadPage}
            className="rounded px-3 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt"
          >
            {source === "session" ? "load earlier rows" : "load later rows"}
          </button>
        </div>
      )}
      {pageStatus === "LoadingMore" && (
        <div className="text-center text-xs text-text-faint">loading…</div>
      )}
      {pageStatus === "LoadingFirstPage" && (
        <div className="text-center text-xs text-text-faint py-6">
          loading rows…
        </div>
      )}
      {empty && (
        <div className="text-center text-xs text-text-faint py-6">no rows</div>
      )}

      {rows.map((message) => {
        // A result its call already drew is not drawn twice.
        if (
          message.kind === "tool-result" &&
          pairing.consumed.has(message._id)
        ) {
          return null;
        }
        const child =
          message.kind === "child-run" ? childRunOf(message.content) : null;
        return (
          <Fragment key={message._id}>
            {placed.before.get(message._id)?.map((note) => (
              <NoteLine key={note._id} note={note} />
            ))}
            {boxPlaced.timed.before.get(message._id)?.map((change) => (
              <BoxChangeLine key={change.id} change={change} />
            ))}
            {message._id === unreadRowKey && <UnreadDivider />}
            {/* A user row starts a turn — mark it with the clock. */}
            {message.kind === "user" && <TurnDivider at={message.createdAt} />}
            {child !== null && renderChildRun !== undefined ? (
              renderChildRun(message, child.childRunId)
            ) : (
              <AgentRow
                row={message}
                result={pairing.forCall.get(message._id)}
                toolNames={toolNames}
                source={source}
              />
            )}
            {boxAfter(message)}
          </Fragment>
        );
      })}

      {placed.after.map((note) => (
        <NoteLine key={note._id} note={note} />
      ))}
      {boxPlaced.timed.after.map((change) => (
        <BoxChangeLine key={change.id} change={change} />
      ))}

      {/* The turn the agent is working on, until its row lands: the reply
          being typed below answers it. */}
      {deliveredTurns.map((row) => (
        <TurnEcho key={row._id} text={row.text ?? ""} state="delivered" />
      ))}

      {streamBuf && (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text px-1">
          {streamBuf.text}
          {/* The cursor is a claim that text is still coming. It only pulses
              while the session is actually running — otherwise it blinked
              forever over a dead buffer. */}
          {sessionStatus === "running" && (
            <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom bg-accent animate-pulse" />
          )}
        </pre>
      )}

      {!streaming && runningTool !== null && (
        <div className="flex items-baseline gap-2 px-2 text-xs text-text-faint">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
          <span className="font-mono text-text-muted shrink-0">
            {runningTool.name} running
          </span>
          <span className="truncate min-w-0">{runningTool.preview}</span>
        </div>
      )}

      {queuedTurns.map((row) => (
        <TurnEcho
          key={row._id}
          text={row.text ?? ""}
          state={
            sessionStatus === "running"
              ? "queued — delivers when the current turn ends"
              : "sending"
          }
        />
      ))}

      {pendingControls.map((row) => (
        <div key={row._id} className="text-center text-xs text-text-faint">
          {row.kind} requested — sending
        </div>
      ))}

      {tail}
    </>
  );

  // A nested run is inside its parent's scrolling region: it never opens a
  // second one, and nothing about it moves the reader.
  if (nested) return <div className="space-y-2">{body}</div>;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-3 sm:px-4 py-3 space-y-2"
      >
        {body}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 right-4 rounded-full px-3 py-1.5 text-xs border border-border bg-surface text-text-muted shadow hover:bg-surface-alt"
        >
          jump to latest
        </button>
      )}
    </div>
  );
});

export default AgentRows;
