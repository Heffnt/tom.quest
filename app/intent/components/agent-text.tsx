"use client";

// HIS INTENT AS ONE AGENT READS IT, in the order it reads it: the prompt (the
// header line, the map and the operate rules, then the grant block), the
// harness's listing of every skill it could load, then each skill it was
// granted, as `tts search skills` prints it. The text is the agent's own,
// verbatim, in monospace.
//
// A BULLET OF HIS PAGES IS A CONTROL. Every bullet of agent-rules.md,
// intent.md and priorities.md is the line the "every line" view lists; pressing
// it opens that line's evidence in the drawer, and the word in the right margin
// is whose words it is. Nothing else in the text is clickable.

import { useMemo } from "react";
import { joinLines, segmentBullets, VOICE_CLASS, type IntentLine } from "../lib";

type AgentView = {
  prefix: string;
  grants: string;
  listing: string;
  skills: { name: string; text: string }[];
};

/** A text run whose last line is blank ends in a newline the browser would
 *  not draw; one more keeps that blank line on screen. */
function drawn(text: string): string {
  return text === "" || text.endsWith("\n") ? `${text}\n` : text;
}

export default function AgentText({
  view,
  lines,
  selected,
  onSelect,
}: {
  view: AgentView;
  lines: IntentLine[];
  selected: string | null;
  onSelect: (line: IntentLine) => void;
}) {
  const blocks = useMemo(
    () =>
      [
        { key: "prompt", label: "prompt", text: [view.prefix, view.grants].filter((part) => part !== "").join("\n\n") },
        { key: "listing", label: "skill listing", text: view.listing },
        ...view.skills.map((skill) => ({ key: `skill:${skill.name}`, label: "skill", text: skill.text })),
      ].map((block) => ({ ...block, rows: joinLines(segmentBullets(block.text), lines) })),
    [view, lines],
  );

  return (
    <div className="space-y-4">
      {blocks.map((block) => (
        <section key={block.key}>
          <h2 className="border-b border-border pb-1 text-[13px] font-semibold text-text">{block.label}</h2>
          <div className="mt-1 break-words font-mono text-xs text-text-muted">
            {block.rows.map((row, index) =>
              row.kind === "text" ? (
                <div key={index} className="whitespace-pre-wrap pr-[4.5rem]">
                  {drawn(row.text)}
                </div>
              ) : (
                <button
                  key={index}
                  type="button"
                  aria-pressed={selected === row.line.id}
                  onClick={() => onSelect(row.line)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_4.5rem] text-left text-text hover:bg-surface-alt ${
                    selected === row.line.id ? "bg-surface-alt" : ""
                  }`}
                >
                  <span className="whitespace-pre-wrap">{row.text}</span>
                  <span className={`pl-2 text-right text-[10px] ${VOICE_CLASS[row.line.voice]}`}>
                    {row.line.voice}
                  </span>
                </button>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
