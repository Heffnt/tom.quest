"use client";

// One entry point for opening a Claude session scoped to a single todo —
// shared by Focus's "Work in a session" button and the Inventory row's
// session button, so the createSession contract (kind choice, prompt build,
// navigation) cannot drift between call sites, and failures land in state
// for the caller to render instead of being swallowed.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  buildTodoSessionPrompt,
  type BatchMemberContext,
} from "@/app/lib/dts-session-prompt";

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

export function useOpenTodoSession() {
  const createSession = useMutation(api.claudeSessions.createSession);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (
    todo: Doc<"dtsTodos">,
    opts?: {
      fireEngaged?: (id: Id<"dtsTodos">) => void;
      // For batch todos (members set): the todos + mirror the caller already
      // holds, so the prompt carries live member statements and statuses.
      batch?: { todos: Doc<"dtsTodos">[]; mirror: Doc<"dtsCodeTodoMirror">[] };
    },
  ) => {
    if (busy) return;
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
        ),
      });
      router.push(`/sessions?session=${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "the session did not open");
    } finally {
      setBusy(false);
    }
  };

  return { open, busy, error };
}
