"use client";

// Transcript pane: finalized messages (paginated, newest page first —
// reversed for display), the live stream-buf tail, and pending-inbound echo.
// Auto-scrolls only when the reader is already near the bottom; preserves
// position when earlier pages load.

import { memo, useLayoutEffect, useRef, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import MessageRow from "./message-row";

const NEAR_BOTTOM_PX = 150;

// Memoized: the parent tree re-renders on a 15s age tick, but the transcript
// shows no ages — sessionId is its only prop, so the tick must not re-render
// every row.
const Transcript = memo(function Transcript({
  sessionId,
}: {
  sessionId: Id<"claudeSessions">;
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

  // results are seq-descending (newest first); display ascending.
  const messages = [...results].reverse();
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

  useLayoutEffect(() => {
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
  }, [contentSignature, pageStatus, firstSeq]);

  const loadEarlier = () => {
    const el = containerRef.current;
    earlierAnchorRef.current = el
      ? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      : null;
    loadMore(60);
  };

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

        {messages.map((m) => (
          <MessageRow key={m._id} message={m} />
        ))}

        {streamBuf && (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text px-1">
            {streamBuf.text}
            <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom bg-accent animate-pulse" />
          </pre>
        )}

        {pendingTurns.map((row) => (
          <div
            key={row._id}
            className="border-l-2 border-accent/50 bg-surface-alt/30 rounded-r px-3 py-2 ml-6 sm:ml-16"
          >
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text-muted">
              {row.text ?? ""}
            </pre>
            <div className="text-xs text-text-faint mt-1">sending</div>
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
