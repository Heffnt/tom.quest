"use client";

// The frame's right drawer on /tts: the selected todo, its statement and the
// facts on its row. Round 1 of the frame keeps it to that; the actions, brief,
// verdicts and time notes join it in a later round.

import { ageText, fmtDate, type Todo } from "../lib";

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[12px] text-text-faint">{name}</dt>
      <dd className="min-w-0 break-words text-[13px] text-text-muted">{children}</dd>
    </>
  );
}

export default function TodoDetail({ todo, now }: { todo: Todo | null; now: number }) {
  if (!todo) return null;
  return (
    <article className="space-y-4 p-3">
      <p className="text-[15px] leading-normal text-text">{todo.statement}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <Fact name="status">{todo.status}</Fact>
        <Fact name="readiness">{todo.readiness}</Fact>
        {todo.dueAt !== undefined && <Fact name="due">{fmtDate(todo.dueAt)}</Fact>}
        {todo.wakeAt !== undefined && <Fact name="wakes">{fmtDate(todo.wakeAt)}</Fact>}
        <Fact name="source">{todo.source}</Fact>
        {todo.provenance && <Fact name="provenance">{todo.provenance}</Fact>}
        <Fact name="captured">{ageText(todo.createdAt, now)}</Fact>
        <Fact name="updated">{ageText(todo.updatedAt, now)}</Fact>
      </dl>
      {todo.body && <p className="whitespace-pre-wrap text-[13px] leading-normal text-text-muted">{todo.body}</p>}
    </article>
  );
}
