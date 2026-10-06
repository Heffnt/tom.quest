"use client";

// tom.quest/secrets: Tom pastes NAME=VALUE lines, as many as he likes, read by
// parse-paste.ts; each line becomes one row of the secretMailbox table
// (convex/secrets.ts) until the Jarvis Box's session-host daemon writes it
// into its env file, and the value is then deleted. The paste area shows what
// he types in clear. The list shows names, dates and value lengths only: no
// query returns a value, to Tom either, so nothing here could show one.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";
import { displayForm } from "@/shared/clock.mjs";
import { parsePaste, type RefusedLine } from "./parse-paste";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const primaryBtnCls =
  "bg-accent text-bg rounded-md px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none";

function when(ms: number): string {
  return displayForm(ms);
}

// A Convex error arrives wrapped in request ids and a stack; the refusal
// itself is the text after "Error: " up to the stack.
function refusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const match = /Uncaught Error: (.*?)(?:\n|\s+at |$)/.exec(text);
  return match ? match[1] : text;
}

type Outcome = { sent: string[]; refused: RefusedLine[] };

export default function SecretsClient() {
  const { isTom } = useAuth();
  const rows = useQuery(api.secrets.list, isTom ? {} : "skip");
  const setSecret = useMutation(api.secrets.set);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const lines = paste.split(/\r?\n/);
    const { secrets, refused } = parsePaste(paste);
    const sent: string[] = [];
    try {
      // One at a time, in paste order, so each refusal from the record is
      // tied to its line.
      for (const secret of secrets) {
        try {
          await setSecret({ name: secret.name, value: secret.value });
          sent.push(secret.name);
        } catch (err) {
          // The record's refusals name the variable, never the value.
          refused.push({ line: secret.line, name: secret.name, reason: refusal(err) });
        }
      }
    } finally {
      refused.sort((a, b) => a.line - b.line);
      setOutcome({ sent, refused });
      // What was sent leaves the paste area; a refused line stays to be fixed.
      setPaste(
        refused
          .filter((r) => !r.superseded)
          .map((r) => lines[r.line - 1])
          .join("\n"),
      );
      setBusy(false);
    }
  };

  return (
    <TomGate label="Secrets">
      <div className="max-w-3xl mx-auto w-full">
        <div className="px-3 sm:px-4 py-6 space-y-4">
          <header>
            <h1 className="text-2xl font-bold tracking-tight">Secrets</h1>
          </header>
          <form onSubmit={submit} className="space-y-2">
            <textarea
              aria-label="paste"
              placeholder={"NAME=value\nOTHER_NAME=value"}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={6}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className={`${inputCls} font-mono w-full resize-y`}
            />
            <span className="inline-flex items-center gap-1">
              <button type="submit" disabled={busy || paste.trim() === ""} className={primaryBtnCls}>
                Send to the box
              </button>
              <Info call="secrets.set({ name, value }) per line" side="below">
                Sends each NAME=value line as its own value, held in Convex until the Jarvis Box writes it into
                /etc/tts/worker.env, then deleted from Convex.
              </Info>
            </span>
          </form>
          <div role="status" className="min-h-5 text-xs space-y-1">
            {outcome && (
              <>
                <p className="text-text-muted">
                  {outcome.sent.length > 0 ? `sent ${outcome.sent.join(", ")}` : "nothing sent"}
                </p>
                {outcome.refused.map((r) => (
                  <p key={r.line} className="text-error">
                    line {r.line}
                    {r.name ? ` (${r.name})` : ""}: {r.reason}
                  </p>
                ))}
              </>
            )}
          </div>
          <ul className="divide-y divide-border border-y border-border">
            {(rows ?? []).map((row) => (
              <li key={row.name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm">
                <span className="font-mono text-text">{row.name}</span>
                <span className="text-xs text-text-muted">set {when(row.setAt)}</span>
                <span className="text-xs text-text-muted">
                  {row.takenAt !== undefined ? `taken ${when(row.takenAt)}` : "waiting for the box"}
                </span>
                {/* A row from before lengths were kept has none; convex/schema.ts
                    (secretMailbox) says why those rows stay. */}
                {row.length !== undefined && (
                  <span className="text-xs text-text-muted">
                    {row.length} {row.length === 1 ? "character" : "characters"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </TomGate>
  );
}
