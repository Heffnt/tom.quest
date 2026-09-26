"use client";

// THE LINES, GROUPED BY KIND. One row per line of his intent: the line itself,
// then where it is written, when it was last said, and whose words it is.
//
// A ROW IS A CONTROL. Pressing one opens its evidence in the drawer beside the
// page, so nothing below it moves and nobody loses their place in a list that
// is hundreds of lines long.
//
// A ROW ALSO SAYS WHAT THE RECORD DID WITH THE LINE: how often the eval items
// naming it passed (a ruling given to the judge), and how many delegate
// decisions rested on it.

import { dateLabel, VOICE_CLASS, type IntentKind, type IntentLine } from "../lib";

const KIND_TITLE: Record<IntentKind, string> = {
  direction: "directions",
  "standing-rule": "standing rules",
  ruling: "rulings",
  label: "labels",
};

export default function LineList({
  groups,
  selected,
  onSelect,
  evals,
  decisions,
}: {
  groups: { kind: IntentKind; lines: IntentLine[] }[];
  selected: string | null;
  onSelect: (line: IntentLine) => void;
  /** Per line id: how often the eval items naming it passed, over the runs read. */
  evals?: Map<string, { passed: number; runs: number }>;
  /** Per line id: how many delegate decisions rested on it. */
  decisions?: Map<string, number>;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.kind}>
          <h2 className="flex items-baseline gap-2 border-b border-border pb-1">
            <span className="text-[13px] font-semibold text-text">{KIND_TITLE[group.kind]}</span>
            <span className="text-[11px] font-mono text-text-faint">{group.lines.length}</span>
          </h2>
          <ul>
            {group.lines.map((line) => (
              <li key={line.id}>
                <button
                  type="button"
                  aria-pressed={selected === line.id}
                  onClick={() => onSelect(line)}
                  className={`w-full border-b border-border/50 px-2 py-1.5 text-left hover:bg-surface-alt ${
                    selected === line.id ? "bg-surface-alt" : ""
                  }`}
                >
                  <span className="block text-[13px] leading-snug text-text">{line.text}</span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[10px] font-mono text-text-faint">
                    <span>{dateLabel(line)}</span>
                    <span>
                      {line.source} · {line.locator}
                    </span>
                    {line.section !== "" && <span>{line.section}</span>}
                    <span className={VOICE_CLASS[line.voice]}>{line.voice}</span>
                    {line.evidence.length > 0 && <span>{line.evidence.length} evidence</span>}
                    {evals?.has(line.id) && (
                      <span className={evals.get(line.id)!.passed < evals.get(line.id)!.runs ? "text-error" : ""}>
                        evals {evals.get(line.id)!.passed}/{evals.get(line.id)!.runs}
                      </span>
                    )}
                    {(decisions?.get(line.id) ?? 0) > 0 && <span>{decisions!.get(line.id)} decisions</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
