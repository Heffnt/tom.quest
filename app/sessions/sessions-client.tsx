"use client";

// TTS Sessions — a chat surface over headless Claude Code sessions running on
// the Jarvis Box. Convex is the stream: the daemon persists transcript rows,
// this page subscribes. Phone-first: the list is the default view; opening a
// session takes over the viewport with back-navigation (?session=<id>
// deep-links, forge-style read-on-mount + router.replace on open/close).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import { useUIStore } from "@/app/lib/stores/ui-store";
import TomGate from "@/app/components/tom-gate";
import SessionList from "./components/session-list";
import SessionView from "./components/session-view";
import { DAEMON_STALE_MS, ageText } from "./lib";

// Shape of a Convex document id as it appears in a deep link. A malformed
// ?session= value passed straight into useQuery throws during render, so
// anything not id-shaped is treated as absent (the list view shows instead).
const SESSION_ID_SHAPE = /^[a-z0-9]{20,40}$/;

// Height of the part of the page the phone is actually showing, in px, or
// null before the effect runs / where the API is missing (the CSS 100dvh
// fallback then stands alone).
//
// Why this exists: the open session is a `position: fixed` layer, and a fixed
// layer does NOT get scrolled into view when the on-screen keyboard opens the
// way an in-flow one does — the composer at its bottom edge would sit under
// the keyboard. visualViewport.height excludes the keyboard, so binding the
// layer to it keeps the composer on screen. It also excludes the browser's
// address bar, which is the same thing 100dvh does, so this is one mechanism
// covering both and not a second one fighting the first.
//
// Only `resize` is listened to, deliberately: `scroll` fires continuously
// while the address bar slides and would jitter the layer mid-read.
function useVisibleViewportHeight(active: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!active || !vv) {
      setHeight(null);
      return;
    }
    const apply = () => setHeight(vv.height);
    apply();
    vv.addEventListener("resize", apply);
    return () => vv.removeEventListener("resize", apply);
  }, [active]);
  return height;
}

export default function SessionsClient() {
  // isTom still gates the queries ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
  const router = useRouter();
  const sessions = useQuery(api.claudeSessions.listSessions, isTom ? {} : "skip");
  const health = useQuery(api.claudeSessions.getDaemonHealth, isTom ? {} : "skip");

  const [activeId, setActiveId] = useState<Id<"claudeSessions"> | null>(null);

  // Same offset AppShell applies to <main> when Tom's diagnostic panel is
  // open. The full-viewport session layer is fixed, so it does not inherit
  // that margin and has to read the store itself.
  const debugOpen = useUIStore((state) => state.debugOpen);
  const debugWidth = useUIStore((state) => state.debugWidth);
  const debugInset = isTom && debugOpen ? debugWidth : 0;

  const visibleHeight = useVisibleViewportHeight(activeId !== null);

  // Staleness is derived at render; a 15s tick keeps ages honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Read ?session=<id> once on mount (GETs never change state).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("session");
    if (id && SESSION_ID_SHAPE.test(id)) {
      setActiveId(id as Id<"claudeSessions">);
    }
  }, []);

  const openSession = (id: Id<"claudeSessions">) => {
    setActiveId(id);
    router.replace(`/sessions?session=${id}`, { scroll: false });
  };

  const closeSession = () => {
    setActiveId(null);
    router.replace("/sessions", { scroll: false });
  };

  // health: undefined = query loading; null = the worker has never reported.
  const daemonStale =
    health !== undefined &&
    (health === null || now - health.lastSeenAt > DAEMON_STALE_MS);

  const lastIngestError = health?.lastIngestError;

  // Worker health, as two lines of text. On the list it is a top banner; on an
  // open session the SAME lines render at the BOTTOM (the transcript owns the
  // top edge there), so the border side is the caller's to pick.
  const notice = (edge: "top" | "bottom") =>
    daemonStale || lastIngestError !== undefined ? (
      <div
        className={`${edge === "top" ? "border-b" : "border-t"} border-border bg-surface-alt/50 px-3 sm:px-4 py-2 text-xs space-y-0.5`}
      >
        {daemonStale && (
          <div className="text-text-muted">
            {health
              ? `worker last heard from ${ageText(health.lastSeenAt, now)} (reports at least every 30s)`
              : "worker has not reported yet"}
          </div>
        )}
        {lastIngestError !== undefined && (
          <div className="text-text-faint">
            last rejected write:{" "}
            {lastIngestError.length > 200
              ? `${lastIngestError.slice(0, 200)}…`
              : lastIngestError}
          </div>
        )}
      </div>
    ) : null;

  const body = activeId ? (
    // The open session takes the WHOLE viewport, top edge included: it is a
    // fixed layer that covers the site nav (z-40) rather than unmounting it,
    // so nothing on the page moves when a session opens or closes, and the
    // transcript's first line is the first line on the screen.
    //
    // Height is 100dvh, not 100vh or 100svh: the transcript is the only
    // scrolling region and the composer is pinned under it, so the column has
    // to track the phone's address bar as it shows and hides — 100vh would
    // push the composer under the bar, 100svh would strand a dead strip below
    // it once the bar retracted. The inline height from visualViewport (see
    // useVisibleViewportHeight) is the same measurement taken more precisely
    // and takes over once JS runs; the class is the pre-hydration fallback.
    //
    // The left inset mirrors AppShell's own: the Tom-only diagnostic panel is
    // also fixed and also z-50, but it is painted after <main>, so it still
    // sits on top when open, and this layer steps aside for it.
    <div
      className="fixed top-0 right-0 z-50 h-[100dvh] flex flex-col bg-bg"
      style={
        visibleHeight === null
          ? { left: debugInset }
          : { left: debugInset, height: visibleHeight }
      }
    >
      <SessionView
        sessionId={activeId}
        now={now}
        daemonStale={daemonStale}
        daemonLastSeenAt={health?.lastSeenAt}
        notice={notice("bottom")}
        onBack={closeSession}
      />
    </div>
  ) : (
    <div className="max-w-3xl mx-auto w-full">
      {notice("top")}
      <div className="px-3 sm:px-4 py-6 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
        </header>
        <SessionList sessions={sessions} now={now} onOpen={openSession} />
      </div>
    </div>
  );

  return <TomGate label="Sessions">{body}</TomGate>;
}
