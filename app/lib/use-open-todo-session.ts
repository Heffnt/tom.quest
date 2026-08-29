"use client";

// One entry point for opening a Claude session scoped to a single todo —
// shared by Focus's "Work in a session" button and the Inventory row's
// session button, so the createSession contract (kind choice, prompt build,
// navigation) cannot drift between call sites, and failures land in state
// for the caller to render instead of being swallowed.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  buildTodoSessionPrompt,
  type BatchMemberContext,
  type LiveRulingContext,
} from "@/app/lib/tts-session-prompt";

// Resolve a batch's members to live statements + statuses against the todos
// and mirror the caller already subscribes to — a member whose mirror row is
// gone reads "closed upstream" (mirror rows are deleted on upstream close).
function resolveMembers(
  todo: Doc<"dtsTodos">,
  batch: { todos: Doc<"dtsTodos">[]; mirror: Doc<"dtsCodeTodoMirror">[] },
): BatchMemberContext[] {
  const todoById = new Map(batch.todos.map((t) => [t._id, t]));
  const mirrorByKey = new Map(
    batch.mirror.map((m) => [`${m.repo} ${m.externalId}`, m]),
  );
  return (todo.members ?? []).map((m) => {
    if (m.todoId !== undefined) {
      const member = todoById.get(m.todoId);
      return member
        ? { kind: "life" as const, statement: member.statement, status: member.status }
        : { kind: "life" as const, statement: "(not found)", status: "unknown" };
    }
    const row = mirrorByKey.get(`${m.repo} ${m.externalId}`);
    return {
      kind: "code" as const,
      label: `${m.repo} ${m.externalId}`,
      statement: row ? row.statement : "(no longer in the mirror)",
      status: row ? row.status : "closed upstream",
    };
  });
}

// A browser tab claimed during the click itself, before the createSession
// round trip. Browsers only honour window.open inside the user-gesture call
// stack, so callers reserve first and point the tab at the session once the
// id comes back; a failed mutation closes it again.
export type ReservedTab = {
  goto: (sessionId: string) => void;
  close: () => void;
};

// Must be called synchronously inside a click handler, before any await.
export function reserveSessionTab(): ReservedTab {
  const tab = window.open("", "_blank");
  return {
    goto: (sessionId) => {
      const href = `/sessions?session=${sessionId}`;
      // Popup blocked (or the tab was closed): fall back to this tab. Plain
      // location.assign keeps this helper hook-free, so click handlers can
      // call it without a router in scope.
      if (tab && !tab.closed) tab.location.href = href;
      else window.location.assign(href);
    },
    close: () => {
      if (tab && !tab.closed) tab.close();
    },
  };
}

export function useOpenTodoSession() {
  const createSession = useMutation(api.claudeSessions.createSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (
    todo: Doc<"dtsTodos">,
    opts?: {
      fireEngaged?: (id: Id<"dtsTodos">) => void;
      // For batch todos (members set): the todos + mirror the caller already
      // holds, so the prompt carries live member statements and statuses.
      batch?: { todos: Doc<"dtsTodos">[]; mirror: Doc<"dtsCodeTodoMirror">[] };
      // A tab the caller already reserved in its own click handler (e.g. the
      // session verdict, which records a ruling first). Omit it and open
      // reserves one itself — synchronously, before the mutation.
      tab?: ReservedTab;
      // The ruling just recorded (session verdict path) — its sentence goes
      // into the session prompt so Tom never repeats himself.
      ruling?: LiveRulingContext;
    },
  ) => {
    if (busy) {
      // A caller that reserved its own tab in the click (the session verdict)
      // would otherwise strand a blank window on the second click.
      opts?.tab?.close();
      return;
    }
    const tab = opts?.tab ?? reserveSessionTab();
    setBusy(true);
    setError(null);
    try {
      opts?.fireEngaged?.(todo._id);
      // A ready-for-tom item is worked as a gate session (spec §15);
      // anything else is a focus-item session.
      const kind = todo.readiness === "ready-for-tom" ? "gate" : "focus-item";
      const id = await createSession({
        title: todo.statement,
        kind,
        repo: "none",
        todoId: todo._id,
        initialPrompt: buildTodoSessionPrompt(
          todo,
          kind,
          todo.members !== undefined && opts?.batch
            ? { members: resolveMembers(todo, opts.batch) }
            : undefined,
          opts?.ruling,
        ),
      });
      tab.goto(id);
    } catch (e) {
      tab.close();
      setError(e instanceof Error ? e.message : "the session did not open");
    } finally {
      setBusy(false);
    }
  };

  return { open, busy, error };
}
