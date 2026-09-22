"use client";

// RULINGS for the window: Tom's own from the rulings table, and the delegate's
// decisions from the record's `delegate-decision` rows, in one list, newest
// first. Both carry a statement, who settled it, and what it was about.
//
// THE OBJECT CONTROL. A ruling of Tom's is objected to through the pen that
// wrote it: `revise` on the same subject, with the sentence that redirects —
// convex/ttsRulings.ts recordRuling, the same call the TTS page's verdict
// buttons make, in the same dialog. A DELEGATE DECISION HAS NO SUCH DOOR: its
// objection is recorded by convex/ttsAsk.ts internalRecordDelegateObjection,
// which is internal and reached only from a reply in the decision's own
// #tts-decisions thread, so the browser cannot write one. Its control is
// therefore present and disabled, carrying no word, rather than a control that
// would fail or a row that quietly has one fewer action than its neighbour.

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import RulingDialog from "@/app/tts/components/ruling-dialog";
import { dayAndClock, rulingHref, type PointEvent, type RulingRow } from "../lib";

type Row =
  | { at: number; by: "Tom"; ruling: RulingRow }
  | {
      at: number;
      by: "the delegate";
      id: string;
      statement: string;
      subject: string;
      todoId: string | null;
      refused: boolean;
    };

function text(data: unknown, name: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function flag(data: unknown, name: string): boolean {
  if (typeof data !== "object" || data === null) return false;
  return (data as Record<string, unknown>)[name] === true;
}

export default function RulingsList({
  rulings,
  events,
  isTom,
}: {
  rulings: RulingRow[];
  events: PointEvent[];
  isTom: boolean;
}) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const [objecting, setObjecting] = useState<RulingRow | null>(null);

  const rows: Row[] = [
    ...rulings.map((ruling): Row => ({ at: ruling.ruledAt, by: "Tom", ruling })),
    ...events
      .filter((event) => event.kind === "delegate-decision")
      .map((event): Row => {
        const refused = flag(event.data, "refused");
        return {
          at: event.at,
          by: "the delegate",
          id: event.id,
          statement:
            text(event.data, "decision") ?? text(event.data, "fallback") ?? "",
          subject: text(event.data, "question") ?? "",
          todoId: event.todoId,
          refused,
        };
      }),
  ].sort((left, right) => right.at - left.at);

  return (
    <section className="space-y-1.5">
      <h2 className="text-[13px] font-semibold text-text-muted">rulings</h2>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div
            key={row.by === "Tom" ? row.ruling.id : row.id}
            className="rounded-md border border-border bg-surface/50 px-2.5 py-1.5"
          >
            <div className="flex items-baseline gap-2">
              <span
                className={`shrink-0 text-[11px] font-mono ${row.by === "Tom" ? "text-accent" : "text-text-muted"}`}
              >
                {row.by === "Tom" ? row.ruling.verdict : row.refused ? "refused" : "decision"}
              </span>
              <span className="min-w-0 flex-1 text-[13px] text-text">
                {row.by === "Tom"
                  ? (row.ruling.sentence ?? row.ruling.quote ?? row.ruling.subject)
                  : row.statement}
              </span>
              <span className="shrink-0 text-[10px] font-mono text-text-faint">
                {dayAndClock(row.at)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-text-faint">{row.by}</span>
              {row.by === "Tom" ? (
                <Link
                  href={rulingHref(row.ruling)}
                  className="min-w-0 flex-1 truncate text-[11px] text-text-muted underline hover:text-text"
                >
                  {row.ruling.subject === "" ? row.ruling.subjectType : row.ruling.subject}
                </Link>
              ) : row.todoId === null ? (
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                  {row.subject}
                </span>
              ) : (
                <Link
                  href={`/tts?item=${row.todoId}`}
                  className="min-w-0 flex-1 truncate text-[11px] text-text-muted underline hover:text-text"
                >
                  {row.subject}
                </Link>
              )}
              {row.by === "Tom" && isTom ? (
                <button
                  type="button"
                  onClick={() => setObjecting(row.ruling)}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
                >
                  object
                </button>
              ) : (
                <span
                  aria-disabled="true"
                  aria-label="objecting is not a door this page holds"
                  className="block h-[19px] w-[46px] shrink-0 rounded border border-border/60 bg-surface-alt/40"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {objecting !== null && (
        <RulingDialog
          action="revise"
          confirm="record revise"
          placeholder="the sentence that redirects"
          required
          call="ttsRulings.recordRuling({ verdict: 'revise', sentence })"
          effect="Records a revise on this subject, which supersedes the ruling above and hands the work back."
          statement={objecting.subject === "" ? objecting.subjectType : objecting.subject}
          onConfirm={async (sentence) => {
            await recordRuling({
              verdict: "revise",
              sentence,
              ...(objecting.subjectType === "life" && objecting.todoId !== null
                ? { todoId: objecting.todoId as Id<"dtsTodos"> }
                : {}),
              ...(objecting.subjectType === "batch" && objecting.batchId !== null
                ? { batchId: objecting.batchId as Id<"batches"> }
                : {}),
              ...(objecting.subjectType === "code" && objecting.repo !== null && objecting.externalId !== null
                ? { repo: objecting.repo, externalId: objecting.externalId }
                : {}),
            });
            setObjecting(null);
          }}
          onClose={() => setObjecting(null)}
        />
      )}
    </section>
  );
}
