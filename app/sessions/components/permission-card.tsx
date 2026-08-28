"use client";

// One pending permission request: tool name, compact input, age, an optional
// note ("a deny note reaches Claude verbatim"), and Allow / Deny.
// The card disappears reactively once any client decides it.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PermissionRow } from "../lib";
import { compactInput, shortAge } from "../lib";

export default function PermissionCard({
  permission,
  now,
}: {
  permission: PermissionRow;
  now: number;
}) {
  const decidePermission = useMutation(api.claudeSessions.decidePermission);
  const [note, setNote] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "allowed" | "denied") => {
    setInFlight(true);
    setError(null);
    try {
      await decidePermission({
        requestId: permission.requestId,
        decision,
        note: note.trim() === "" ? undefined : note.trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "decision failed");
      setInFlight(false);
    }
    // On success the row leaves "pending" and this card unmounts reactively.
  };

  const inputText = compactInput(permission.toolName, permission.input);
  const waiting = shortAge(permission.requestedAt, now);

  return (
    <div className="border border-accent/60 bg-surface rounded-lg p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-text">
          permission requested:{" "}
          <span className="font-mono text-accent">{permission.toolName}</span>
        </span>
        <span className="text-xs text-text-faint shrink-0">
          {waiting === "just now" ? "just requested" : `waiting ${waiting}`}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-muted bg-surface-alt/50 border border-border rounded p-2 max-h-40 overflow-y-auto">
        {inputText}
      </pre>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="optional note — a deny note reaches Claude verbatim"
        className="w-full bg-surface-alt border border-border rounded px-2 py-1.5 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
      />
      {error && <div className="text-xs text-error">{error}</div>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={inFlight}
          onClick={() => void decide("allowed")}
          className="flex-1 rounded px-3 py-2 text-sm border border-accent text-accent hover:bg-surface-alt disabled:opacity-50"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={inFlight}
          onClick={() => void decide("denied")}
          className="flex-1 rounded px-3 py-2 text-sm border border-border text-text-muted hover:bg-surface-alt disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
