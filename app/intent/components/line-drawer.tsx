"use client";

// THE EVIDENCE BEHIND ONE LINE, beside the page rather than instead of it.
//
// WHAT IT SHOWS IS WHAT THE SOURCE HOLDS. A model-of-tom line's entries are the
// ones its evidence file carries, in the file's own words; a ruling's is the
// sentence of his the agent read as the ruling; an `AGENTS.md` rule has none,
// and the drawer says that rather than drawing an empty panel.
//
// Fixed, so opening it moves nothing on the page behind it.

import { dateLabel, type IntentLine } from "../lib";

export default function LineDrawer({
  line,
  onClose,
}: {
  line: IntentLine | null;
  onClose: () => void;
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
      </div>
    </aside>
  );
}
