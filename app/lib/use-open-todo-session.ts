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
import { buildTodoSessionPrompt } from "@/app/lib/dts-session-prompt";

export function useOpenTodoSession() {
  const createSession = useMutation(api.claudeSessions.createSession);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (
    todo: Doc<"dtsTodos">,
    opts?: { fireEngaged?: (id: Id<"dtsTodos">) => void },
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
        initialPrompt: buildTodoSessionPrompt(todo, kind),
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
