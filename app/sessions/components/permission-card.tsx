"use client";

// One pending permission request, on one line: tool name, a preview of the
// input, how long it has waited, Allow / Deny. Near-vestigial under the
// unified auto permission gate — nothing parks anymore — so this stays as
// small as a residual/historical row can be. The optional note ("a deny note
// reaches Claude verbatim") is folded behind a toggle.
// The card disappears reactively once any client decides it.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PermissionRow } from "../lib";
import { compactInput, previewLine, shortAge } from "../lib";

export default function PermissionCard({
  permission,
  now,
}: {
  permission: PermissionRow;
  now: number;
}) {
  const decidePermission = useMutation(api.claudeSessions.decidePermission);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowRef = useRef<HTMLButtonElement | null>(null);

  // Focus Allow on mount so Tom's Enter-to-approve ruling works — but NEVER
  // steal focus out of a text field. A card can mount while Tom is mid-message
  // in the composer, where a bare Enter is just a newline; autoFocus (or an
  // inline callback ref, which re-runs as the `now` prop ticks) would turn
  // that keypress into an approval of a request he never read.
  useEffect(() => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    allowRef.current?.focus();
  }, []);

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

  // Tom's ruling — a residual card must approve on Enter. The Allow button is
  // focused on mount (unless typing), so the common keypress is the button's
  // own Enter-click; this
  // root handler catches the case where focus sits elsewhere in the card. It
  // steps aside for the note field (Enter is text there) and for buttons
  // (Enter already fires their click — never decide twice for one keypress).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || inFlight) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "BUTTON") return;
    e.preventDefault();
    void decide("allowed");
  };

  const inputText = compactInput(permission.toolName, permission.input);
  const waiting = shortAge(permission.requestedAt, now);

  const btn =
    "shrink-0 rounded px-2 py-0.5 text-xs disabled:opacity-50 hover:bg-surface-alt";

  return (
    <div
      onKeyDown={onKeyDown}
      className="w-full border border-accent/60 bg-surface rounded px-2 py-1.5 space-y-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-accent shrink-0">
          {permission.toolName}
        </span>
        <span className="font-mono text-xs text-text-muted truncate min-w-0 flex-1">
          {previewLine(inputText, 120)}
        </span>
        <span className="text-[10px] text-text-faint shrink-0">
          {waiting === "just now" ? "just requested" : `waiting ${waiting}`}
        </span>
        <span className="flex items-center gap-1 ml-auto shrink-0">
          <button
            type="button"
            ref={allowRef}
            disabled={inFlight}
            onClick={() => void decide("allowed")}
            className={`${btn} border border-accent text-accent`}
          >
            Allow
          </button>
          <button
            type="button"
            disabled={inFlight}
            onClick={() => void decide("denied")}
            className={`${btn} border border-border text-text-muted`}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen((v) => !v)}
            className="shrink-0 text-[10px] text-text-faint hover:text-text-muted px-1"
          >
            note
          </button>
        </span>
      </div>
      {noteOpen && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="a deny note reaches Claude verbatim"
          className="w-full resize-y bg-surface-alt border border-border rounded px-2 py-1 text-xs placeholder:text-text-faint focus:outline-none focus:border-accent"
        />
      )}
      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
