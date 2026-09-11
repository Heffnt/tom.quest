"use client";

// THE ROWS OF ONE RUN. Carried forward from the transcript pane rather than
// rewritten: the paging states, the scroll anchoring and its guards, the unread
// divider, the turn clocks, the agent fold, the live tail, the pending-inbound
// echo and the jump-to-latest button are all proven code and they stay.
//
// Four things changed, and only four:
//   1. The rows arrive as a prop from useRunRows (../use-run-rows), so one memo
//      in <Run/> can match child runs against the same loaded window this file
//      pairs tool calls over.
//   2. THE AGENT FOLD APPLIES TO A ROW WITH NO `provenance`. On a daemon row
//      parentToolUseId means "this row belongs to that subagent's output"; on a
//      file-derived row it means "this row answers that tool call"
//      (worker/runs/ingest.mjs sets it on tool-result and child-run rows), and
//      folding on it would put every tool result in a one-row fold of its own.
//      `provenance === undefined` is exactly the daemon's rows, which is
//      exactly the set the fold was written for, and it stays correct in a
//      window holding both.
//   3. A `child-run` row mounts the child run itself (renderChildRun), because
//      one component draws a run at every depth.
//   4. A run that is not a session has no live tail and shows none: work with
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
import type { TranscriptMessage } from "../lib";
import {
  childRunOf,
  compactInput,
  formatClock,
  isLive,
  previewLine,
  shortAge,
  subagentTypeOf,
  taskDescriptionOf,
  toolInputOf,
  toolNameOf,
  toolUseIdOf,
} from "../lib";
import RunRow from "./run-row";
import type { PairedResult, RowSource } from "./run-row";

const NEAR_BOTTOM_PX = 150;

/**
 * Where the reader got to last visit, per RUN. A new key prefix on purpose:
 * the old one was keyed by session id, and reusing it would silently
 * reinterpret one reader's mark under a different identity.
 */
export const lastReadKey = (runKey: string) =>
  `tts.runs.lastReadSeq.${runKey}`;

// A subagent's rows arrive interleaved in the one seq stream — several parallel
// agents take turns, row by row. EVERY row carrying a given parentToolUseId
// goes into ONE group, anchored where that parent's first row sits. So display
// deviates from strict seq order across groups: one agent is one fold, and its
// later rows are pulled up to it. Within a group the rows stay in seq order.
// The honest per-row alternative (only consecutive rows fold) shattered
// parallel agents into dozens of one-row folds, which buries the main thread
// far worse than the reordering does.
type AgentGroup = {
  kind: "agent";
  parentToolUseId: string;
  messages: TranscriptMessage[];
};
type Group = { kind: "row"; message: TranscriptMessage } | AgentGroup;

/** The fold key of one row, or undefined when it does not fold (see note 2). */
function foldKeyOf(message: TranscriptMessage): string | undefined {
  return message.provenance === undefined ? message.parentToolUseId : undefined;
}

export function groupRows(messages: TranscriptMessage[]): Group[] {
  const groups: Group[] = [];
  const byParent = new Map<string, AgentGroup>();
  for (const message of messages) {
    const parent = foldKeyOf(message);
    if (parent === undefined) {
      groups.push({ kind: "row", message });
      continue;
    }
    const open = byParent.get(parent);
    if (open !== undefined) {
      open.messages.push(message);
      continue;
    }
    const group: AgentGroup = {
      kind: "agent",
      parentToolUseId: parent,
      messages: [message],
    };
    byParent.set(parent, group);
    groups.push(group);
  }
  return groups;
}

// toolUseId → what its Task tool-call said the subagent is: its type, and the
// description the call gave it. Read off the Task rows in the loaded window; a
// group whose Task row has not been paged in yet falls back to the open-work
// query below, and keeps the bare id only when neither knows it — an invented
// name would be worse than the literal one.
type TaskLabel = { type?: string; description?: string };

function subagentIndex(messages: TranscriptMessage[]): Map<string, TaskLabel> {
  const labels = new Map<string, TaskLabel>();
  for (const message of messages) {
    if (message.kind !== "tool-call") continue;
    const id = toolUseIdOf(message.content);
    if (id === undefined) continue;
    const type = subagentTypeOf(message.content);
    const description = taskDescriptionOf(message.content);
    if (type !== undefined || description !== undefined) {
      labels.set(id, { type, description });
    }
  }
  return labels;
}

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
 * A tool-call consumes its tool-result when both are in the same loaded window
 * AND in the same fold — a result paged out, or sitting inside a subagent's
 * fold while its call is in the main thread, keeps rendering on its own rather
 * than being pulled out of the group it belongs to.
 */
export function pairRows(messages: TranscriptMessage[]): {
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
    if (result === undefined || foldKeyOf(result) !== foldKeyOf(call)) continue;
    // createdAt is the file line's own timestamp on a file-derived row, so this
    // is a measurement; on a daemon row it is the ingest time, which the daemon
    // batches per ~400ms, so the number is coarse there.
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

// The turn separator's clock. createdAt is stamped at ingest on a daemon row
// and is the line's own timestamp on a file row — a turn marker either way, not
// a timing measurement. Static text: no ticking, so the memo below holds.
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

// The last top-level tool-call in the loaded window with no tool-result
// answering it — the call the agent is still inside. Null when there is none.
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
    if (m.kind !== "tool-call" || foldKeyOf(m) !== undefined) continue;
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

/**
 * How long a running subagent has been going, ticking on its own 15s interval.
 * The interval is HERE and not in the parent on purpose: the rows show no ages,
 * and a tick hoisted up would re-render every row in the pane once a minute.
 */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <>{shortAge(startedAt, now)}</>;
}

/** One running subagent, as claudeSessions.getOpenToolWork names it. */
type OpenAgent = {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: number;
  current?: { toolName: string; inputPreview: string };
};

/** The first of these that says something. The open-work query spells an
 * absent field as "", so a plain ?? chain would take the empty one. */
function firstText(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined && v.trim() !== "");
}

/** The line on the closed fold: who, what it was sent to do, how many rows —
 * and, while it is still going, that it is running, for how long, and the call
 * it is inside. */
function AgentSummary({
  label,
  description,
  rows,
  open,
}: {
  label: string;
  description?: string;
  rows: number;
  /** Absent = the subagent has returned (or the session is over). */
  open?: OpenAgent;
}) {
  return (
    <summary className="cursor-pointer list-none text-xs text-text-faint px-1 hover:text-text-muted">
      agent <span className="text-text-muted">{label}</span> — {rows} rows
      {description !== undefined && (
        <span>
          {" · "}
          {previewLine(description, 80)}
        </span>
      )}
      {open !== undefined && (
        <span className="text-accent">
          {" · running "}
          <Elapsed startedAt={open.startedAt} />
        </span>
      )}
      {open?.current !== undefined && (
        <span className="block font-mono text-[10px] text-text-faint break-words">
          now: {open.current.toolName} {previewLine(open.current.inputPreview, 80)}
        </span>
      )}
    </summary>
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
const RunRows = memo(function RunRows({
  rows,
  pageStatus,
  loadMore,
  source,
  depth,
  runKey,
  sessionId,
  sessionStatus,
  lead,
  tail,
  renderChildRun,
}: {
  /** Ascending, oldest first, from useRunRows. */
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
  // The open subagents, for the fold summaries. A terminal session has none by
  // definition, so it is not asked; neither is a run with no session.
  const openWork = useQuery(
    api.claudeSessions.getOpenToolWork,
    sessionId !== undefined && isLive(sessionStatus ?? "") ? { sessionId } : "skip",
  );

  const groups = useMemo(() => groupRows(rows), [rows]);
  const subagents = useMemo(() => subagentIndex(rows), [rows]);
  const toolNames = useMemo(() => toolNameIndex(rows), [rows]);
  const pairing = useMemo(() => pairRows(rows), [rows]);
  const running = useMemo(
    () => new Map((openWork?.agents ?? []).map((a) => [a.toolUseId, a])),
    [openWork],
  );
  const pendingTurns = (pendingInbound ?? []).filter(
    (row) => row.kind === "user-turn",
  );
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

  // The group the divider sits above: the first one ANCHORED after the stored
  // seq. Anchor, not rows.some — an agent group absorbs later rows out of seq
  // order, so `some` would re-anchor the divider above already-read rows
  // whenever a long-running Task emitted one more since the last visit.
  const unreadGroupKey = useMemo(() => {
    if (lastReadSeq === null) return null;
    for (const g of groups) {
      const groupRowsOf = g.kind === "row" ? [g.message] : g.messages;
      if (groupRowsOf[0].seq > lastReadSeq) return groupRowsOf[0]._id;
    }
    return null;
  }, [groups, lastReadSeq]);

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
  }:${pendingControls.length}`;

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
    pendingControls.length === 0;

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

      {groups.map((g) => {
        const anchor = g.kind === "row" ? g.message : g.messages[0];
        if (g.kind === "row") {
          const message = g.message;
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
            <Fragment key={anchor._id}>
              {anchor._id === unreadGroupKey && <UnreadDivider />}
              {/* A top-level user row starts a turn — mark it with the clock. */}
              {message.kind === "user" && foldKeyOf(message) === undefined && (
                <TurnDivider at={message.createdAt} />
              )}
              {child !== null && renderChildRun !== undefined ? (
                renderChildRun(message, child.childRunId)
              ) : (
                <RunRow
                  row={message}
                  result={pairing.forCall.get(message._id)}
                  toolNames={toolNames}
                  source={source}
                />
              )}
            </Fragment>
          );
        }
        return (
          <Fragment key={anchor._id}>
            {anchor._id === unreadGroupKey && <UnreadDivider />}
            <details className="text-sm">
              {/* The fold IS the agent panel now: who it is, what it was sent
                  to do, how much it has done — and, while it is still going,
                  that it is running, for how long, and the call it is inside.
                  Then every row it produced, one press away. */}
              <AgentSummary
                label={
                  firstText(
                    subagents.get(g.parentToolUseId)?.type,
                    running.get(g.parentToolUseId)?.subagentType,
                  ) ?? g.parentToolUseId
                }
                description={firstText(
                  subagents.get(g.parentToolUseId)?.description,
                  running.get(g.parentToolUseId)?.description,
                )}
                rows={g.messages.length}
                open={running.get(g.parentToolUseId)}
              />
              <div className="mt-1 space-y-2 border-l border-border pl-3">
                {g.messages.map((m) =>
                  m.kind === "tool-result" && pairing.consumed.has(m._id) ? null : (
                    <RunRow
                      key={m._id}
                      row={m}
                      result={pairing.forCall.get(m._id)}
                      toolNames={toolNames}
                      source={source}
                    />
                  ),
                )}
              </div>
            </details>
          </Fragment>
        );
      })}

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

      {pendingTurns.map((row) => (
        <div
          key={row._id}
          className="border-l-2 border-accent/50 bg-surface-alt/30 rounded-r px-3 py-2 ml-6 sm:ml-16"
        >
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text-muted">
            {row.text ?? ""}
          </pre>
          <div className="text-xs text-text-faint mt-1">
            {sessionStatus === "running"
              ? "queued — delivers when the current turn ends"
              : "sending"}
          </div>
        </div>
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

export default RunRows;
