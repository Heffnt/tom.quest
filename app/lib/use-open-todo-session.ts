"use client";

// One entry point for opening a Claude session scoped to a single todo —
// shared by the /tts session buttons (app/tts/components/todo-row.tsx,
// batches-tab.tsx, options-row.tsx; app/tts/components/calendar-tab.tsx and
// app/sessions/components/session-list.tsx take the lower-level useOpenSession
// below) — so the createSession contract (kind choice, prompt build,
// navigation) cannot drift between call sites, and failures land in state
// for the caller to render instead of being swallowed. Not Focus and not the
// Inventory: /focus and /inventory are bare redirects to /tts now.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { WRITING_SKILL } from "@/convex/ttsShared";
import { useAuth } from "@/app/lib/auth";
import {
  buildBatchSessionPrompt,
  buildTodoSessionPrompt,
  type BatchMemberContext,
  type BatchSessionContext,
  type LiveRulingContext,
} from "@/app/lib/tts-session-prompt";

// The writing skill (WikiTom, synced into ttsSkills) that opens every session
// prompt built here. Tom-gated like the rest of TTS, so it skips for anyone
// else — and an unsynced or skipped read leaves the builders on their fallback.
function useWritingSkill(): string | undefined {
  const { isTom } = useAuth();
  const row = useQuery(
    api.ttsSkills.getSkill,
    isTom ? { name: WRITING_SKILL } : "skip",
  );
  return row?.body;
}

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

// ── The ONE client launch hook (VQC C1: one home) ────────────────────────────
// Ratified by Tom 2026-08-30. Before this, four launch surfaces each assembled
// their own createSession call, and three of the four passed `repo: "none"`
// because that was the only value a caller with no repo picker could name — so
// every session opened from a TTS button arrived with an empty scratch
// directory and could neither clone a private repo nor push anything.
//
// The arguments are assembled HERE, once, for all of them:
//   - the tab is reserved inside the click (browsers only honour window.open
//     inside the user-gesture call stack), and closed again if the mutation
//     fails;
//   - failures land in state for the caller to render, never swallowed;
//   - REPOS ARE NOT PASSED. Omitting them is a real answer, not a default: the
//     server resolves the session's repos from the todo's batch declaration
//     (convex/claudeSessions.ts resolveSessionRepos), which is the only place
//     that knows. A surface that genuinely knows better — the /sessions form,
//     where Tom picks from a dropdown — passes `repos` explicitly.
export function useOpenSession() {
  const createSession = useMutation(api.claudeSessions.createSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (args: {
    title: string;
    kind: "gate" | "focus-item" | "weekly" | "adhoc" | "block";
    initialPrompt: string;
    todoId?: Id<"dtsTodos">;
    /** The batch this session is opened ON — its subject, so the server
     * resolves the batch's declared repos directly. */
    batchId?: Id<"batches">;
    blockCategory?: string;
    /** Only when the caller genuinely knows — otherwise the server resolves. */
    repos?: string[];
    /** A tab the caller reserved in its own click handler, before any await. */
    tab?: ReservedTab;
    /** Fired once the launch is committed to, before the round trip. */
    before?: () => void;
  }): Promise<void> => {
    if (busy) {
      // A caller that reserved its own tab in the click (the session verdict)
      // would otherwise strand a blank window on the second click.
      args.tab?.close();
      return;
    }
    const tab = args.tab ?? reserveSessionTab();
    setBusy(true);
    setError(null);
    try {
      args.before?.();
      const id = await createSession({
        title: args.title,
        kind: args.kind,
        todoId: args.todoId,
        batchId: args.batchId,
        blockCategory: args.blockCategory,
        repos: args.repos,
        initialPrompt: args.initialPrompt,
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

// The batch twin of useOpenTodoSession (schema v2). A batch is its own row, not
// a dtsTodos row, so it cannot go through `open` below with a todoId — its
// subject is the batch itself, passed as batchId (claudeSessions.batchId,
// ledger graduation session-repos-need-batch-subject 2026-08-31), so the
// server's repo resolver reads the batch's declared repos directly and the
// session starts with the checkout the batch's work needs.
export function useOpenBatchSession() {
  const writingSkill = useWritingSkill();
  const { open: openSession, busy, error } = useOpenSession();

  const open = async (batch: BatchSessionContext) => {
    await openSession({
      title: batch.statement,
      kind: "focus-item",
      batchId: batch.id,
      initialPrompt: buildBatchSessionPrompt(batch, writingSkill),
    });
  };

  return { open, busy, error };
}

export function useOpenTodoSession() {
  const writingSkill = useWritingSkill();
  const { open: openSession, busy, error } = useOpenSession();

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
    // A ready-for-tom item is worked as a gate session (spec §15);
    // anything else is a focus-item session.
    const kind = todo.readiness === "ready-for-tom" ? "gate" : "focus-item";
    await openSession({
      title: todo.statement,
      kind,
      todoId: todo._id,
      tab: opts?.tab,
      before: () => opts?.fireEngaged?.(todo._id),
      initialPrompt: buildTodoSessionPrompt(
        todo,
        kind,
        todo.members !== undefined && opts?.batch
          ? { members: resolveMembers(todo, opts.batch) }
          : undefined,
        opts?.ruling,
        writingSkill,
      ),
    });
  };

  return { open, busy, error };
}
