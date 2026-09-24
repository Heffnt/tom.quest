"use client";

// THE LINES, GROUPED BY KIND. One row per line of his intent: the line itself,
// then where it is written, when it was last said, and whose words it is.
//
// A ROW IS A CONTROL. Pressing one opens its evidence in the drawer beside the
// page, so nothing below it moves and nobody loses their place in a list that
// is hundreds of lines long.

import { dateLabel, type IntentKind, type IntentLine } from "../lib";

const KIND_TITLE: Record<IntentKind, string> = {
  direction: "directions",
  "standing-rule": "standing rules",
  ruling: "rulings",
  label: "labels",
};

/** `his` is the only one of the three that gets the accent: the page is read to
 *  find drift from what HE said, so his own lines are the ones that must be
 *  findable at a glance. */
const VOICE_CLASS: Record<IntentLine["voice"], string> = {
  his: "text-accent",
  inferred: "text-text-muted",
  unattributed: "text-text-faint",
};

export default function LineList({
  groups,
  selected,
  onSelect,
}: {
  groups: { kind: IntentKind; lines: IntentLine[] }[];
  selected: string | null;
  onSelect: (line: IntentLine) => void;
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
