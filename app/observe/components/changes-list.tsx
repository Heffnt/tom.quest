"use client";

// CHANGES for the window. A row is one merge, and what it shows at rest is the
// merge's own sentence — the pull request's title, which by this repository's
// commit rule states the world after the change rather than what was done to
// the code. Every vocabulary word in it opens its definition.
//
// EVERY PRESS OPENS MORE AND NOTHING LEAVES THE SITE. The row opens to the
// commit, the gate's three checks and the runs that did the work; each check
// opens to the sentence the gate wrote about it; the audit opens to the prose
// it wrote about the diff; a run opens to its own page here. There is no link
// to GitHub anywhere on this page.
//
// WHAT IS NOT HERE. A merge row keeps the repository, the sha, the subject and
// GitHub's one-sentence answer about whether the sha reached main. It keeps no
// pull request body, and no other table holds one, so the written account of a
// change is the audit's — the audit read the diff and wrote about it, and
// convex/ttsMerge.ts keeps that text on the head row.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Terms from "./terms";
import {
  dayAndClock,
  lasted,
  mergeRowOf,
  outcomeWords,
  runHref,
  type PointEvent,
  type RunMark,
} from "../lib";

/** The most merges one window's list draws, and the most commits gateRows is
 *  asked about in one read. */
const MERGES_MAX = 40;

export default function ChangesList({
  events,
  runs,
  now,
}: {
  events: PointEvent[];
  runs: RunMark[];
  now: number;
}) {
  const merges = events
    .filter((event) => event.kind === "merge")
    .map(mergeRowOf)
    .sort((left, right) => right.at - left.at)
    .slice(0, MERGES_MAX);

  const commits = merges
    .filter((row) => row.repo !== null && row.sha !== null)
    .map((row) => ({ repo: row.repo as string, sha: row.sha as string }));

  const gates = useQuery(api.observe.gateRows, commits.length === 0 ? "skip" : { commits });
  const byKey = new Map((gates ?? []).map((gate) => [gate.key, gate]));
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="space-y-1.5">
      <h2 className="text-[13px] font-semibold text-text-muted">changes</h2>
      <div className="flex flex-col gap-1.5">
        {merges.map((row) => {
          const gate = row.commitKey === null ? undefined : byKey.get(row.commitKey);
          const did = runs.filter((run) => run.mergeKey !== null && run.mergeKey === row.commitKey);
          const showing = open === row.id;
          return (
            <div key={row.id} className="rounded-md border border-border bg-surface/50">
              <button
                type="button"
                aria-expanded={showing}
                onClick={() => setOpen(showing ? null : row.id)}
                className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-surface-alt/60"
              >
                <span className="min-w-0 flex-1 text-[13px] text-text">{row.subject ?? ""}</span>
                <span className="shrink-0 text-[10px] font-mono text-text-faint">
                  {dayAndClock(row.at)}
                </span>
              </button>
              {showing && (
                <div className="space-y-2 border-t border-border px-2.5 py-2">
                  <Terms
                    text={row.subject ?? ""}
                    className="block text-[13px] leading-snug text-text"
                  />
                  <p className="font-mono text-[11px] text-text-muted">
                    {row.repo ?? ""}@{(row.sha ?? "").slice(0, 7)}
                  </p>
                  {row.mainCheck !== null && (
                    <Terms text={row.mainCheck} className="block text-[11px] text-text-muted" />
                  )}
                  {gate === undefined ? null : (
                    <>
                      <div className="space-y-1">
                        {gate.checks.map((check) => (
                          <Opens
                            key={check.name}
                            head={check.name}
                            tone={check.passed ? "pass" : "fail"}
                          >
                            <Terms text={check.why} className="block text-[11px] text-text-muted" />
                          </Opens>
                        ))}
                      </div>
                      {gate.audit !== null && gate.audit.text !== null && (
                        <Opens head="what the audit read" tone="plain">
                          <Terms
                            text={gate.audit.text}
                            className="block whitespace-pre-wrap text-[11px] leading-snug text-text-muted"
                          />
                        </Opens>
                      )}
                    </>
                  )}
                  <Opens head={`${did.length} runs did this work`} tone="plain">
                    {did.length === 0 ? (
                      <p className="text-[11px] text-text-faint">
                        No run in this window names this merge.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {did.map((run) => (
                          <li key={run.runId} className="flex items-baseline gap-2">
                            <Terms
                              text={`${run.kind} · ${outcomeWords(run).join(" · ")} · ran ${lasted(run, now)}`}
                              className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted"
                            />
                            <Link
                              href={runHref(run.runId)}
                              className="shrink-0 text-[11px] text-text-muted underline hover:text-text"
                            >
                              open the run
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Opens>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One more press, one more layer. The head carries the fact; what is under it
 *  carries the account of that fact. */
function Opens({
  head,
  tone,
  children,
}: {
  head: string;
  tone: "pass" | "fail" | "plain";
  children: React.ReactNode;
}) {
  const [on, setOn] = useState(false);
  const colour =
    tone === "pass" ? "text-success" : tone === "fail" ? "text-error" : "text-text-muted";
  return (
    <div>
      <button
        type="button"
        aria-expanded={on}
        onClick={() => setOn((value) => !value)}
        className={`rounded px-1.5 py-0.5 text-[11px] font-mono hover:bg-surface-alt ${colour}`}
      >
        {on ? "▾" : "▸"} {head}
      </button>
      {on && <div className="mt-1 border-l border-border pl-2">{children}</div>}
    </div>
  );
}
