"use client";

// The open items (api.thread.open): numbered needs-you items, live sessions'
// questions, the counts. Pressed, a line shows its links and its Reply.

import { useState } from "react";
import type { OpenItems as OpenData } from "./feed";
import { displayDayKey, displayTime } from "@/shared/clock.mjs";

/** `id` is what is pressed, `subject` the row a reply goes under if not `id`. */
export type ReplyTarget = { id: string; subject?: string; placeholder: string };

/** One needs-you item, a target of its own, answered under its digest by number. */
export function needsYouTarget(digestId: string, n: number): ReplyTarget {
  return { id: `${digestId}#${n}`, subject: digestId, placeholder: `Answer item ${n}` };
}

type NeedsYou = OpenData["needsYou"][number];
type Question = OpenData["questions"][number];

function needsYouLine(item: NeedsYou, newestDigestId: string | null): string {
  const older = item.digestId !== newestDigestId ? ` (of ${displayDayKey(item.day)})` : "";
  return `${item.n} · ${item.text}${older}`;
}

const lineCls = "cursor-pointer rounded px-1 py-0.5 text-sm leading-5 text-text hover:bg-surface-alt";
const replyCls = (on: boolean) =>
  `rounded-md border px-2 py-0.5 text-xs hover:bg-surface-alt hover:text-text ${on ? "border-accent/60 bg-surface-alt text-text" : "border-border text-text-muted"}`;
const linkCls = "underline underline-offset-2 hover:text-accent";

function Fold({ line, children }: { line: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((was) => !was);
          }
        }}
        className={`${lineCls} ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}
      >
        {line}
      </div>
      {open && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-1 pl-3 pt-0.5 text-xs text-text-muted">{children}</div>}
    </li>
  );
}

export default function OpenItems({
  open,
  newestDigestId,
  targetId,
  onReply,
}: {
  open: OpenData | undefined;
  newestDigestId: string | null;
  targetId: string | null;
  onReply: (target: ReplyTarget, prefill: string) => void;
}) {
  if (open === undefined) return null;
  const { needsYou, questions, counts } = open;
  // A count built from a cut read is a lower bound.
  const at = (key: "openLoopRuns" | "liveSessions") => (counts.partial.includes(key) ? "at least " : "");
  const countLinks: Array<{ label: string; count: string; href: string }> = [
    ...(counts.openLoopRuns === undefined ? [] : [{ label: "open loop runs", count: at("openLoopRuns") + counts.openLoopRuns, href: "/design" }]),
    { label: "live sessions", count: at("liveSessions") + counts.liveSessions, href: "/agents" },
  ];
  return (
    <div className="space-y-1 py-2">
      {needsYou.length + questions.length > 0 && (
        <ul className="space-y-0.5">
          {needsYou.map((item) => {
            // An item is answered by number under the digest that numbered it.
            const target = needsYouTarget(item.digestId, item.n);
            return (
              <Fold key={item.id} line={needsYouLine(item, newestDigestId)}>
                {item.todoId !== undefined ? (
                  <a href={`/jarvis?item=${item.todoId}`} className={linkCls}>{item.statement ?? "the todo"}</a>
                ) : item.job !== undefined ? <span>{item.job}</span> : null}
                <span className="font-mono text-[11px] text-text-faint">{displayTime(item.at)}</span>
                <button type="button" aria-pressed={targetId === target.id} onClick={() => onReply(target, `${item.n} `)} className={replyCls(targetId === target.id)}>
                  {targetId === target.id ? "Replying" : "Reply"}
                </button>
              </Fold>
            );
          })}
          {questions.map((question: Question) => (
            <Fold key={question.id} line={`${question.title} asks: ${question.question}`}>
              <a href={question.href} className={linkCls}>session</a>
              <button
                type="button"
                aria-pressed={targetId === question.id}
                onClick={() => onReply({ id: question.id, placeholder: `Answer ${question.title}` }, "")}
                className={replyCls(targetId === question.id)}
              >
                {targetId === question.id ? "Replying" : "Reply"}
              </button>
            </Fold>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap gap-x-3 font-mono text-[11px] text-text-faint">
        {countLinks.map((one) => (
          <a key={one.label} href={one.href} className={`${linkCls} hover:text-text`}>
            {one.label} {one.count}
          </a>
        ))}
      </p>
    </div>
  );
}
