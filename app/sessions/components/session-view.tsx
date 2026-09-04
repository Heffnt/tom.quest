"use client";

// Session view: header facts, transcript, pending permission cards pinned
// above the composer, composer. Fills the viewport below the site nav so the
// transcript is the only scrolling region (phone-first).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SessionModel } from "../lib";
import {
  ageText,
  isLive,
  modelFamily,
  sessionModel,
  shortAge,
  statusChipClass,
} from "../lib";
import Transcript from "./transcript";
import AgentPanel from "./agent-panel";
import PermissionCard from "./permission-card";
import Composer from "./composer";
import ModelSelect from "./model-select";
import ForkDialog from "./fork-dialog";

const LAST_OUTPUT_QUIET_MS = 2 * 60_000;

export default function SessionView({
  sessionId,
  now,
  daemonStale,
  daemonLastSeenAt,
  onBack,
  onOpen,
}: {
  sessionId: Id<"claudeSessions">;
  now: number;
  daemonStale: boolean;
  daemonLastSeenAt: number | undefined;
  onBack: () => void;
  /** Swap the view to another session — the same navigation the list uses. */
  onOpen: (id: Id<"claudeSessions">) => void;
}) {
  const session = useQuery(api.claudeSessions.getSession, { id: sessionId });
  const pendingPermissions = useQuery(api.claudeSessions.getPendingPermissions, {
    sessionId,
  });
  const renameSession = useMutation(api.claudeSessions.renameSession);
  const setSessionModel = useMutation(api.claudeSessions.setSessionModel);
  const forkSessionAs = useMutation(api.claudeSessions.forkSessionAs);

  // The model the header select is asking to move to, when that move crosses
  // families and so needs a first message. null = no dialog open.
  const [forkTo, setForkTo] = useState<SessionModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  // Rename: the h1 IS the control — tapping it swaps in an input that looks
  // the same. Enter blurs (the blur handler is the single save path, so Enter
  // and click-away cannot both fire it); Escape sets this flag first so the
  // blur it causes discards instead of saving.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const cancelRename = useRef(false);

  // The agent panel holds a live Convex subscription, so `hidden sm:block`
  // alone would still pay for it on a phone that never shows it — mount it
  // only when the viewport is already wide. 640px is Tailwind's own sm.
  // Read once at mount, with no resize tracking on purpose: the subscription
  // cost is the point, and orientation flips across the breakpoint are rare
  // (one reload picks the panel up). false until the effect runs, so the
  // server render and the phone agree.
  const [wideViewport, setWideViewport] = useState(false);
  useEffect(() => {
    setWideViewport(window.matchMedia("(min-width: 640px)").matches);
  }, []);

  if (session === undefined) {
    return (
      <div className="px-4 py-6 text-sm text-text-faint">loading session…</div>
    );
  }

  if (session === null) {
    return (
      <div className="px-4 py-6 space-y-3">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          session not found
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded px-3 py-1.5 text-sm border border-border text-text-muted hover:bg-surface-alt"
        >
          Back to sessions
        </button>
      </div>
    );
  }

  const commitRename = (value: string) => {
    setTitleDraft(null);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const next = value.trim();
    if (next === "" || next === session.title) return;
    void renameSession({ sessionId, title: next });
  };

  const model = sessionModel(session);
  const live = isLive(session.status);
  // Bound once so the click handler below closes over a plain id.
  const forkedFrom = session.forkedFrom;

  // ── Which model this session runs on ───────────────────────────────────────
  // Inside one family the row is simply repointed: the runner holds the same
  // conversation and the next turn goes to the new model (setSessionModel
  // refuses a cross-family move, so this branch is the only one it sees).
  // Across families the transcript cannot move — Claude Code and the Codex CLI
  // hold different conversations — so the change is a new session seeded with
  // this one's transcript, which is what the dialog collects a first message
  // for.
  const changeModel = (next: SessionModel) => {
    if (next === model) return;
    setModelError(null);
    if (modelFamily(next) !== modelFamily(model)) {
      setForkTo(next);
      return;
    }
    void (async () => {
      try {
        await setSessionModel({ sessionId, model: next });
      } catch (e) {
        setModelError(e instanceof Error ? e.message : "model change failed");
      }
    })();
  };

  const quietWhileRunning =
    session.status === "running" &&
    session.lastSdkEventAt !== undefined &&
    now - session.lastSdkEventAt > LAST_OUTPUT_QUIET_MS;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="border-b border-border px-3 sm:px-4 py-2.5 space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to sessions"
            className="shrink-0 rounded px-2 py-1 text-sm border border-border text-text-muted hover:bg-surface-alt"
          >
            &larr;
          </button>
          {titleDraft === null ? (
            <h1
              onClick={() => {
                cancelRename.current = false;
                setTitleDraft(session.title);
              }}
              className="text-sm sm:text-base text-text truncate min-w-0 flex-1 cursor-text"
            >
              {session.title}
            </h1>
          ) : (
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
          )}
          {session.mode === "autonomous" && (
            <span className="shrink-0 border border-border rounded px-1.5 py-0.5 text-xs text-text-muted">
              autonomous
            </span>
          )}
          {/* The model is a control, not a chip: Tom picks it here mid-session.
              An ended session has no runner to repoint, so the select is
              disabled rather than hidden — the fact stays readable. */}
          <ModelSelect
            ariaLabel="session model"
            compact
            value={model}
            disabled={!live}
            onChange={changeModel}
          />
          <span
            className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${statusChipClass(session.status)}`}
          >
            {session.status}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-text-faint pl-9">
          <span>{session.repo}</span>
          <span>{ageText(session.statusChangedAt, now)}</span>
          {session.todoId !== undefined && (
            <Link
              href={`/tts?item=${session.todoId}`}
              className="text-accent hover:underline"
            >
              linked item
            </Link>
          )}
          {/* Where this session came from, when it is a cross-family reopen:
              the row it was seeded from. A real href so it can be copied or
              opened in a tab, but the click swaps the view in place — the page
              reads ?session= on mount only, so a soft navigation to the same
              route would leave this session on screen. */}
          {forkedFrom !== undefined && (
            <Link
              href={`/sessions?session=${forkedFrom}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                onOpen(forkedFrom);
              }}
              className="text-accent underline underline-offset-2 hover:text-text"
            >
              continues {forkedFrom.slice(0, 6)}
            </Link>
          )}
          {session.cwd !== undefined && (
            <span className="truncate max-w-full">{session.cwd}</span>
          )}
          {quietWhileRunning && session.lastSdkEventAt !== undefined && (
            <span>
              last output {shortAge(session.lastSdkEventAt, now)} ago
            </span>
          )}
          {daemonStale && isLive(session.status) && (
            <span>
              as of{" "}
              {daemonLastSeenAt !== undefined
                ? ageText(daemonLastSeenAt, now)
                : "an unknown time"}
            </span>
          )}
        </div>
        {/* The arrival headline for an ended session: what it came to, ahead
            of the transcript it came to it in. Live-gated like session-list's
            copy of the same field — a reopened session keeps its old outcome
            as history, which must not headline an actively-streaming run. */}
        {!isLive(session.status) && session.outcome !== undefined && (
          <div
            className={`text-xs pl-9 break-words ${
              session.outcome === "errored" ? "text-error" : "text-text-muted"
            }`}
          >
            outcome: {session.outcome}
            {session.outcomeSummary ? ` — ${session.outcomeSummary}` : ""}
          </div>
        )}
        {modelError && (
          <div className="text-xs text-error pl-9">{modelError}</div>
        )}
      </header>

      {/* Transcript + permission cards are the conversation column; the agent
          panel is a sibling, not a floating overlay. Below sm the phone gets
          the conversation alone (the panel's facts are all in the transcript
          anyway) and the panel is never mounted; on wide viewports the
          wrapper still collapses to zero width when there is no open tool
          work, and keeps sm:block so a narrowed window hides it. */}
      <div className="flex-1 min-h-0 flex flex-row">
        <div className="flex-1 min-w-0 flex flex-col">
          <Transcript sessionId={sessionId} sessionStatus={session.status} />

          {pendingPermissions && pendingPermissions.length > 0 && (
            // Cards may never crowd out the transcript (Tom's ruling): a
            // compact strip that scrolls, not a half-screen tray.
            <div className="border-t border-border px-3 sm:px-4 py-2 space-y-1.5 max-h-40 overflow-y-auto">
              {pendingPermissions.map((p) => (
                <PermissionCard key={p._id} permission={p} now={now} />
              ))}
            </div>
          )}
        </div>
        {wideViewport && (
          <div className="hidden sm:block shrink-0 min-h-0">
            <AgentPanel sessionId={sessionId} />
          </div>
        )}
      </div>

      <Composer session={session} daemonStale={daemonStale} />

      {forkTo !== null && (
        <ForkDialog
          fromModel={model}
          toModel={forkTo}
          onClose={() => setForkTo(null)}
          onConfirm={async (text) => {
            const newId = await forkSessionAs({
              sessionId,
              model: forkTo,
              text,
            });
            setForkTo(null);
            onOpen(newId);
          }}
        />
      )}
    </div>
  );
}
