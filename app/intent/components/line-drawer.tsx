"use client";

// THE EVIDENCE BEHIND ONE LINE, beside the page rather than instead of it.
//
// WHAT IT SHOWS IS WHAT THE SOURCE HOLDS. A model-of-tom line's entries are the
// ones its evidence file carries, in the file's own words; a ruling's is the
// sentence of his the agent read as the ruling; an `AGENTS.md` rule has none,
// and the drawer says that rather than drawing an empty panel.
//
// WHAT THE RECORD DID WITH THE LINE comes after the evidence: the eval items
// that name it (a ruling given to the judge; each run's pass, and the note
// on a fail) and the delegate decisions that rested on it.
//
// Fixed, so opening it moves nothing on the page behind it.

import type { Decision, EvalItem } from "@/convex/jarvis/intent";
import { dateLabel, type IntentLine } from "../lib";

export default function LineDrawer({
  line,
  onClose,
  evalItems = [],
  decisions = [],
}: {
  line: IntentLine | null;
  onClose: () => void;
  evalItems?: EvalItem[];
  decisions?: Decision[];
}) {
  if (line === null) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(30rem,100vw)] flex-col border-l border-border bg-surface shadow-2xl">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-text">{line.kind}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
        >
          close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p className="text-[13px] leading-snug text-text">{line.text}</p>
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-[11px] font-mono text-text-faint">
          <dt>written in</dt>
          <dd className="text-text-muted">
            {line.source} · {line.locator}
          </dd>
          <dt>under</dt>
          <dd className="text-text-muted">{line.section === "" ? "—" : line.section}</dd>
          <dt>last said</dt>
          <dd className="text-text-muted">{dateLabel(line)}</dd>
          <dt>words</dt>
          <dd className="text-text-muted">{line.voice}</dd>
        </dl>
        {line.evidence.length === 0 ? (
          <p className="mt-3 text-[12px] text-text-muted">No evidence entry stands behind this line.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {line.evidence.map((entry, index) => (
              <li key={`${entry.form}-${index}`}>
                <p className="text-[10px] font-mono text-text-faint">{entry.form}</p>
                <p className="text-[12px] leading-snug text-text">{entry.text}</p>
              </li>
            ))}
          </ul>
        )}
        {evalItems.length > 0 && (
          <section className="mt-4">
            <h3 className="text-[10px] font-mono text-text-faint">eval items naming this line</h3>
            <ul className="mt-1 space-y-1">
              {evalItems.map((item) => (
                <li key={item.name} className="text-[12px] leading-snug">
                  <span className="font-mono text-[11px] text-text">{item.name}</span>
                  <span className="ml-2 font-mono text-[10px] text-text-faint">
                    {item.passed}/{item.runs} runs passed · newest {item.pass === true ? "pass" : item.pass === false ? "fail" : "skipped"}
                  </span>
                  {item.note !== "" && <p className="text-text-muted">{item.note}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {decisions.length > 0 && (
          <section className="mt-4">
            <h3 className="text-[10px] font-mono text-text-faint">delegate decisions that rested on this line</h3>
            <ul className="mt-1 space-y-2">
              {decisions.map((decision) => (
                <li key={decision.id} className="text-[12px] leading-snug">
                  <p className="text-text">{decision.question}</p>
                  <p className="text-accent">{decision.refused ? "refused" : decision.decision}</p>
                  <p className="font-mono text-[10px] text-text-faint">
                    {new Date(decision.at).toISOString().slice(0, 10)} · {decision.caller}
                    {decision.settled !== null && ` · ${decision.settled.verdict === "approve" ? "stands" : "objected"}`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
