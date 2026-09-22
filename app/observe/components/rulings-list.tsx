"use client";

// RULINGS for the window: Tom's own from the rulings table, and the delegate's
// decisions from the record's `delegate-decision` rows, in one list, newest
// first. A row at rest is the sentence that was ruled; pressing it opens
// everything the record holds about that ruling, and every vocabulary word in
// any of it opens its definition.
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
import Terms from "./terms";
import { dayAndClock, rulingHref, type PointEvent, type RulingRow } from "../lib";

type Row =
  | { id: string; at: number; by: "Tom"; ruling: RulingRow }
  | {
      id: string;
      at: number;
      by: "the delegate";
      statement: string;
      question: string;
      reason: string | null;
      fallback: string | null;
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
}: {
  rulings: RulingRow[];
  events: PointEvent[];
}) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const [objecting, setObjecting] = useState<RulingRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const rows: Row[] = [
    ...rulings.map((ruling): Row => ({ id: ruling.id, at: ruling.ruledAt, by: "Tom", ruling })),
    ...events
      .filter((event) => event.kind === "delegate-decision")
      // dtsEvents.data is v.any(), so nothing makes a delegate-decision row
      // carry these fields; a row missing one draws the part it has rather
      // than taking the list down, and its absence shows as an empty line.
      .map((event): Row => ({
        id: event.id,
        at: event.at,
        by: "the delegate",
        statement: text(event.data, "decision") ?? text(event.data, "fallback") ?? "",
        question: text(event.data, "question") ?? "",
        reason: text(event.data, "reason"),
        fallback: text(event.data, "fallback"),
        todoId: event.todoId,
        refused: flag(event.data, "refused"),
      })),
  ].sort((left, right) => right.at - left.at);

  return (
    <section className="space-y-1.5">
      <h2 className="text-[13px] font-semibold text-text-muted">rulings</h2>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const showing = open === row.id;
          const head =
            row.by === "Tom"
              ? (row.ruling.sentence ?? row.ruling.quote ?? row.ruling.subject)
              : row.statement;
          return (
            <div key={row.id} className="rounded-md border border-border bg-surface/50">
              <button
                type="button"
                aria-expanded={showing}
                onClick={() => setOpen(showing ? null : row.id)}
                className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-surface-alt/60"
              >
                <span
                  className={`shrink-0 text-[11px] font-mono ${
                    row.by === "Tom" ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {row.by === "Tom" ? row.ruling.verdict : row.refused ? "refused" : "decision"}
                </span>
                <span className="min-w-0 flex-1 text-[13px] text-text">{head}</span>
                <span className="shrink-0 text-[10px] font-mono text-text-faint">
                  {dayAndClock(row.at)}
                </span>
              </button>

              {showing && (
                <div className="space-y-2 border-t border-border px-2.5 py-2">
                  <p className="text-[11px] text-text-faint">{row.by}</p>
                  {row.by === "Tom" ? (
                    <>
                      <Terms
                        text={row.ruling.subject === "" ? row.ruling.subjectType : row.ruling.subject}
                        className="block text-[12px] leading-snug text-text"
                      />
                      {row.ruling.sentence !== null && (
                        <Terms
                          text={row.ruling.sentence}
                          className="block text-[12px] leading-snug text-text-muted"
                        />
                      )}
                      {row.ruling.quote !== null && (
                        <Terms
                          text={`his words: ${row.ruling.quote}`}
                          className="block text-[12px] leading-snug text-text-muted"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <Link
                          href={rulingHref(row.ruling)}
                          className="text-[11px] text-text-muted underline hover:text-text"
                        >
                          open the subject
                        </Link>
                        <button
                          type="button"
                          onClick={() => setObjecting(row.ruling)}
                          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
                        >
                          object
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Terms
                        text={row.question}
                        className="block text-[12px] leading-snug text-text"
                      />
                      {row.reason !== null && (
                        <Terms
                          text={row.reason}
                          className="block text-[12px] leading-snug text-text-muted"
                        />
                      )}
                      {row.fallback !== null && (
                        <Terms
                          text={`its default was: ${row.fallback}`}
                          className="block text-[12px] leading-snug text-text-muted"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        {row.todoId !== null && (
                          <Link
                            href={`/tts?item=${row.todoId}`}
                            className="text-[11px] text-text-muted underline hover:text-text"
                          >
                            open the subject
                          </Link>
                        )}
                        <span
                          aria-disabled="true"
                          aria-label="objecting to a delegate decision is not a door this page holds"
                          className="block h-[19px] w-[46px] rounded border border-border/60 bg-surface-alt/40"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
              ...(objecting.subjectType === "code" &&
              objecting.repo !== null &&
              objecting.externalId !== null
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
