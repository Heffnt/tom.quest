"use client";

// The sessions page's left column: the persistent sessions, each with its
// icon, above every other session, newest activity first and a hundred at a
// time; and the button that opens a new one. Both orders are the record's
// (claudeSessions.persistentSessions, recentSessions).

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { NewSessionForm } from "@/app/agents/components/agent-list";
import type { Session } from "@/app/agents/lib";
import { MODEL_CHIP_CLASS, ageText, sessionModel, statusChipClass } from "@/app/agents/lib";
import PersistentIcon from "./persistent-icon";

function SessionRow({
  session,
  selected,
  now,
  boxLogin,
  icon,
  onOpen,
}: {
  session: Session;
  selected: boolean;
  now: number;
  boxLogin?: string;
  icon: boolean;
  onOpen: (id: Id<"claudeSessions">) => void;
}) {
  const login = session.login ?? boxLogin;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(session._id)}
        className={`w-full text-left px-3 py-2 space-y-1 hover:bg-surface-alt ${
          selected ? "bg-surface-alt border-l-2 border-accent" : "border-l-2 border-transparent"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon && (
            <span className="text-accent">
              <PersistentIcon name={session.title} />
            </span>
          )}
          <span className="text-sm text-text truncate min-w-0 flex-1">{session.title}</span>
          <span className={`shrink-0 border rounded px-1.5 py-0.5 text-[10px] ${statusChipClass(session.status)}`}>
            {session.status}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-text-faint">
          <span className={MODEL_CHIP_CLASS}>{sessionModel(session)}</span>
          {login !== undefined && (
            <span className="border border-border rounded px-1.5 py-0.5 text-text-muted">{login}</span>
          )}
          <span>{ageText(session.statusChangedAt, now)}</span>
        </div>
      </button>
    </li>
  );
}

export default function SessionList({
  persistent,
  others,
  selectedId,
  now,
  boxLogin,
  onOpen,
  onLoadOlder,
}: {
  persistent: Session[] | undefined;
  /** Newest activity first, as recentSessions pages them. */
  others: Session[] | undefined;
  /** Present while older sessions remain to be read. */
  onLoadOlder?: () => void;
  selectedId?: Id<"claudeSessions">;
  now: number;
  /** The login the box holds, which runs a session whose row names none. */
  boxLogin?: string;
  onOpen: (id: Id<"claudeSessions">) => void;
}) {
  const [creating, setCreating] = useState(false);

  const group = (title: string, rows: Session[] | undefined, icon: boolean) => (
    <section aria-label={title} className="py-1">
      <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
        {title}
      </h3>
      {rows === undefined ? (
        <div className="px-3 py-1 text-xs text-text-faint">loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-1 text-xs text-text-faint">none</div>
      ) : (
        <ul>
          {rows.map((s) => (
            <SessionRow
              key={s._id}
              session={s}
              selected={s._id === selectedId}
              now={now}
              boxLogin={boxLogin}
              icon={icon}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="divide-y divide-border">
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full rounded px-3 py-1.5 text-sm border border-accent text-accent hover:bg-surface-alt"
        >
          New session
        </button>
      </div>
      {group("Persistent", persistent, true)}
      {group("Other", others, false)}
      {onLoadOlder !== undefined && (
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={onLoadOlder}
            className="w-full rounded px-3 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt hover:text-text"
          >
            Older sessions
          </button>
        </div>
      )}
      {creating && (
        <div
          role="dialog"
          aria-label="New session"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24"
        >
          <div className="w-full max-w-3xl space-y-2 rounded-lg border border-border bg-bg p-3">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded px-2.5 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt hover:text-text"
              >
                Close
              </button>
            </div>
            <NewSessionForm
              onCreated={(id) => {
                setCreating(false);
                onOpen(id);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
