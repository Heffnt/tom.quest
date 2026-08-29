"use client";

// The four verdict buttons — identical on every ruling subject (life or code;
// first ruling or a superseding one). The verdict set is closed:
// approve · revise (sentence required) · session · archive.

import { useState } from "react";
import Info from "./info";
import { errMessage, VERDICTS, type RulingVerdict } from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

export default function VerdictButtons({
  record,
  afterSession,
}: {
  /** Records the ruling with the subject already bound (todoId or repo+externalId). */
  record: (args: {
    verdict: RulingVerdict;
    sentence?: string;
    unarchiveCondition?: string;
  }) => Promise<unknown>;
  /** Life subjects only: runs AFTER the session ruling is recorded. */
  afterSession?: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"revise" | "archive" | null>(null);
  const [sentence, setSentence] = useState("");
  const [unarchive, setUnarchive] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(null);
      setSentence("");
      setUnarchive("");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const click = (v: RulingVerdict) => {
    setError(null);
    if (v === "revise" || v === "archive") {
      setMode((m) => (m === v ? null : v));
      return;
    }
    if (v === "approve") {
      void run(() => record({ verdict: "approve" }));
      return;
    }
    // session: record the ruling, then (life subjects) open the session.
    void run(async () => {
      await record({ verdict: "session" });
      await afterSession?.();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {VERDICTS.map((v) => (
          <button
            key={v}
            onClick={() => click(v)}
            disabled={busy}
            className={`${btnCls} ${mode === v ? "border-accent/60 text-text" : ""}`}
          >
            {v}
          </button>
        ))}
        <Info label='dtsRulings.recordRuling({verdict:"…"})' />
      </div>

      {mode === "revise" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const s = sentence.trim();
            if (!s) return;
            void run(() => record({ verdict: "revise", sentence: s }));
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder="sentence (required)"
            autoFocus
            className={`${inputCls} flex-1 min-w-56 max-w-md`}
          />
          <button
            type="submit"
            disabled={busy || !sentence.trim()}
            className={btnCls}
          >
            revise
          </button>
        </form>
      )}

      {mode === "archive" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={unarchive}
            onChange={(e) => setUnarchive(e.target.value)}
            placeholder="unarchiveCondition (optional)"
            autoFocus
            className={`${inputCls} flex-1 min-w-56 max-w-md`}
          />
          <button
            onClick={() =>
              void run(() =>
                record({
                  verdict: "archive",
                  unarchiveCondition: unarchive.trim() || undefined,
                }),
              )
            }
            disabled={busy}
            className={btnCls}
          >
            archive
          </button>
        </div>
      )}

      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
