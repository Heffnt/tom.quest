"use client";

// tom.quest/secrets: Tom types a variable name and pastes a value; the value
// goes to the secretMailbox table (convex/secrets.ts) until the Jarvis Box's
// session-host daemon writes it into its env file, and is then deleted. The
// page lists names and dates only. No query returns a value, to Tom either,
// so nothing here could show one.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const primaryBtnCls =
  "bg-accent text-bg rounded-md px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none";

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A Convex error arrives wrapped in request ids and a stack; the refusal
// itself is the text after "Error: " up to the stack.
function refusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const match = /Uncaught Error: (.*?)(?:\n|\s+at |$)/.exec(text);
  return match ? match[1] : text;
}

export default function SecretsClient() {
  const { isTom } = useAuth();
  const rows = useQuery(api.secrets.list, isTom ? {} : "skip");
  const setSecret = useMutation(api.secrets.set);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setSecret({ name, value });
      setName("");
      setValue("");
    } catch (err) {
      setError(refusal(err));
    } finally {
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
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <input
              aria-label="name"
              placeholder="NAME"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              className={`${inputCls} font-mono w-48`}
            />
            <input
              aria-label="value"
              placeholder="value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              className={`${inputCls} font-mono flex-1 min-w-48`}
            />
            <span className="inline-flex items-center gap-1">
              <button type="submit" disabled={busy || name === "" || value === ""} className={primaryBtnCls}>
                Send to the box
              </button>
              <Info call="secrets.set({ name, value })" side="below">
                Holds the value in Convex until the Jarvis Box writes it into /etc/tts/worker.env, then deletes it from Convex.
              </Info>
            </span>
          </form>
          <p className="min-h-5 text-xs text-error">{error}</p>
          <ul className="divide-y divide-border border-y border-border">
            {(rows ?? []).map((row) => (
              <li key={row.name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm">
                <span className="font-mono text-text">{row.name}</span>
                <span className="text-xs text-text-muted">set {when(row.setAt)}</span>
                <span className="text-xs text-text-muted">
                  {row.takenAt !== undefined ? `taken ${when(row.takenAt)}` : "waiting for the box"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </TomGate>
  );
}
