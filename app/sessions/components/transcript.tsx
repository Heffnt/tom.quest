"use client";

// Transcript pane: finalized messages (paginated, newest page first —
// reversed for display), the live stream-buf tail, and pending-inbound echo.
// Auto-scrolls only when the reader is already near the bottom; preserves
// position when earlier pages load.

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Message } from "../lib";
import {
  compactInput,
  formatClock,
  previewLine,
  subagentTypeOf,
  toolInputOf,
  toolNameOf,
  toolUseIdOf,
} from "../lib";
import MessageRow from "./message-row";

const NEAR_BOTTOM_PX = 150;

// Where the reader got to last visit, per session. Written continuously while
// the transcript is open; read ONCE on mount so the divider stays put.
const lastReadKey = (sessionId: string) => `tts.sessions.lastReadSeq.${sessionId}`;

// A subagent's rows arrive interleaved in the one seq stream — several
// parallel agents take turns, row by row. EVERY row carrying a given
// parentToolUseId goes into ONE group, anchored where that parent's first row
// sits. So display deviates from strict seq order across groups: one agent is
// one fold, and its later rows are pulled up to it. Within a group the rows
// stay in seq order. The honest per-row alternative (only consecutive rows
// fold) shattered parallel agents into dozens of one-row folds, which buries
// the main thread far worse than the reordering does.
type AgentGroup = {
  kind: "agent";
  parentToolUseId: string;
  messages: Message[];
};
type Group = { kind: "row"; message: Message } | AgentGroup;

function groupRows(messages: Message[]): Group[] {
  const groups: Group[] = [];
  const byParent = new Map<string, AgentGroup>();
  for (const message of messages) {
    const parent = message.parentToolUseId;
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

// toolUseId → subagent_type, read off the Task tool-calls in the loaded
// window. A group whose Task row has not been paged in yet keeps the bare id
// as its label — an invented name would be worse than the literal one.
function subagentTypeIndex(messages: Message[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const message of messages) {
    if (message.kind !== "tool-call") continue;
    const id = toolUseIdOf(message.content);
    if (id === undefined) continue;
    const type = subagentTypeOf(message.content);
    if (type !== undefined) types.set(id, type);
  }
  return types;
}

// toolUseId → toolName over the loaded window, so a tool-result row can name
// the call it answers. A result whose call has not been paged in yet shows no
// name — never an invented one.
function toolNameIndex(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.kind !== "tool-call") continue;
    const id = toolUseIdOf(message.content);
    if (id !== undefined) names.set(id, toolNameOf(message.content));
  }
  return names;
}

// The turn separator's clock. createdAt is stamped at INGEST (the daemon
// batches a flush per ~400ms), so it is coarse by design — a turn marker, not
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
// answering it — i.e. the call the agent is still inside. Returns null when
// there is none (the call is older than the loaded window, or the tool already
// returned): the live tail then renders nothing rather than inventing a state
// the rows do not show.
function openToolCall(
  messages: Message[],
): { name: string; preview: string } | null {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.kind !== "tool-result") continue;
    const id = toolUseIdOf(m.content);
    if (id !== undefined) answered.add(id);
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind !== "tool-call" || m.parentToolUseId !== undefined) continue;
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

// Memoized: the parent tree re-renders on a 15s age tick, but the transcript
// shows no ages, so the tick must not re-render every row. Both props are safe
// under that rule — sessionId is fixed for the pane, and sessionStatus changes
// rarely and always means something (a re-render on a status flip is the point:
// the live cursor, the queued caption and the running-tool tail all depend on
// it).
const Transcript = memo(function Transcript({
  sessionId,
  sessionStatus,
}: {
  sessionId: Id<"claudeSessions">;
  sessionStatus: string;
}) {
  const {
    results,
    status: pageStatus,
    loadMore,
  } = usePaginatedQuery(
    api.claudeSessions.getMessages,
    { sessionId },
    { initialNumItems: 60 },
  );
  const streamBuf = useQuery(api.claudeSessions.getStreamBuf, { sessionId });
  const pendingInbound = useQuery(api.claudeSessions.getPendingInbound, {
    sessionId,
  });

  // results are seq-descending (newest first); display ascending. The stream
  // buf re-renders this component several times a second, so the reverse and
  // both passes over the loaded rows are keyed on the rows themselves and not
  // redone until a page or a finalized message actually lands.
  const messages = useMemo(() => [...results].reverse(), [results]);
  const groups = useMemo(() => groupRows(messages), [messages]);
  const subagentTypes = useMemo(() => subagentTypeIndex(messages), [messages]);
  const toolNames = useMemo(() => toolNameIndex(messages), [messages]);
  const pendingTurns = (pendingInbound ?? []).filter(
    (row) => row.kind === "user-turn",
  );
  const pendingControls = (pendingInbound ?? []).filter(
    (row) => row.kind !== "user-turn",
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  // Set when "Load earlier" is clicked; consumed only once the older rows
  // actually land (the first message's seq drops), NOT on the pageStatus
  // flip — that fires before the rows exist and would apply a ~0px
  // correction, then none when the page arrives (review finding).
  const earlierAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  // Previous first-message seq, to detect growth at the TOP of the list.
  const prevFirstSeqRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  // Unread mark. The stored seq is read ONCE, on mount, into state — so the
  // divider is frozen where the reader left off and does not creep down as new
  // rows land during the visit. localStorage throws in some privacy modes;
  // every touch is guarded and a failure simply means no divider.
  const [lastReadSeq, setLastReadSeq] = useState<number | null>(null);
  const didReadStorageRef = useRef(false);
  const storageKey = lastReadKey(sessionId);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const seq = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(seq)) setLastReadSeq(seq);
    } catch {
      // storage unavailable — no divider, nothing else changes
    }
    // Gates the write-back below: the read must always happen first, and
    // layout effects run before this passive one on the same commit.
    didReadStorageRef.current = true;
  }, [storageKey]);

  // The group the divider sits above: the first one ANCHORED after the stored
  // seq. Null when nothing was stored, or nothing is newer. Anchor, not
  // rows.some — an agent group is anchored at its parent's first row and
  // absorbs later rows out of seq order, so `some` would re-anchor the divider
  // back above already-read main-thread rows whenever a long-running Task
  // emitted one more row since the last visit. Trade-off: new rows absorbed
  // into an already-read agent group no longer summon a divider — they sit
  // inside the collapsed fold anyway.
  const unreadGroupKey = useMemo(() => {
    if (lastReadSeq === null) return null;
    for (const g of groups) {
      const rows = g.kind === "row" ? [g.message] : g.messages;
      if (rows[0].seq > lastReadSeq) return rows[0]._id;
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

  // Content signature: any growth at the tail or the tip of the stream buf.
  const contentSignature = `${messages.length}:${streamBuf?.text.length ?? 0}:${
    pendingTurns.length
  }:${pendingControls.length}`;

  const firstSeq = messages.length > 0 ? messages[0].seq : null;
  const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;

  useLayoutEffect(() => {
    // Write-back first, and only after the mount read has run — otherwise the
    // very first commit would overwrite the mark before it was read.
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
      // Waiting for an older page. Apply the compensation only when rows
      // actually appeared above (first seq dropped); pageStatus flips and
      // tail growth in the meantime must not consume the anchor.
      if (
        firstSeq !== null &&
        prevFirstSeq !== null &&
        firstSeq < prevFirstSeq
      ) {
        const anchor = earlierAnchorRef.current;
        el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
        earlierAnchorRef.current = null;
      } else if (pageStatus !== "LoadingMore") {
        // The page settled without rows appearing above (nothing older) —
        // drop the anchor so tail auto-scroll resumes.
        earlierAnchorRef.current = null;
      }
      return;
    }
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
  }, [contentSignature, pageStatus, firstSeq, lastSeq, storageKey]);

  const loadEarlier = () => {
    const el = containerRef.current;
    earlierAnchorRef.current = el
      ? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      : null;
    loadMore(60);
  };

  // What the agent is doing right now — derived, never asserted (see
  // openToolCall).
  const runningTool = useMemo(
    () => (sessionStatus === "running" ? openToolCall(messages) : null),
    [messages, sessionStatus],
  );

  // The buf row survives a turn as an empty string, so "is text streaming" is
  // a text check, not a row check.
  const streaming = (streamBuf?.text ?? "") !== "";

  const empty =
    pageStatus !== "LoadingFirstPage" &&
    messages.length === 0 &&
    !streamBuf &&
    pendingTurns.length === 0 &&
    pendingControls.length === 0;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-3 sm:px-4 py-3 space-y-2"
      >
        {pageStatus === "CanLoadMore" && (
          <div className="text-center">
            <button
              type="button"
              onClick={loadEarlier}
              className="rounded px-3 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt"
            >
              Load earlier
            </button>
          </div>
        )}
        {pageStatus === "LoadingMore" && (
          <div className="text-center text-xs text-text-faint">
            loading earlier…
          </div>
        )}
        {pageStatus === "LoadingFirstPage" && (
          <div className="text-center text-xs text-text-faint py-6">
            loading transcript…
          </div>
        )}
        {empty && (
          <div className="text-center text-xs text-text-faint py-6">
            no transcript yet
          </div>
        )}

        {groups.map((g) => {
          const anchor = g.kind === "row" ? g.message : g.messages[0];
          return (
            <Fragment key={anchor._id}>
              {anchor._id === unreadGroupKey && <UnreadDivider />}
              {/* A top-level user row starts a turn — mark it with the clock. */}
              {g.kind === "row" &&
                g.message.kind === "user" &&
                g.message.parentToolUseId === undefined && (
                  <TurnDivider at={g.message.createdAt} />
                )}
              {g.kind === "row" ? (
                <MessageRow message={g.message} toolNames={toolNames} />
              ) : (
                <details className="text-sm">
                  <summary className="cursor-pointer list-none text-xs text-text-faint px-1 hover:text-text-muted">
                    agent{" "}
                    {subagentTypes.get(g.parentToolUseId) ?? g.parentToolUseId}{" "}
                    — {g.messages.length} rows
                  </summary>
                  <div className="mt-1 space-y-2 border-l border-border pl-3">
                    {g.messages.map((m) => (
                      <MessageRow key={m._id} message={m} toolNames={toolNames} />
                    ))}
                  </div>
                </details>
              )}
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

export default Transcript;
