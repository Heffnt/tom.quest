"use client";

// CHANGES: first the ones that are waiting, every open pull request, then the
// merges of the window. A waiting row shows the pull request's title, its
// branch, the gate's three rows as they stand and one control, Approve. A
// merge row shows the merge's own sentence — the pull request's title, which by this repository's
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
//
// APPROVE. convex/observe.ts approveChange records Tom's ruling approving the
// change; convex/observeMerge.ts merges an approved waiting change once its
// gate is green. A change that already carries a ruling shows the ruled word
// in place of the control. On a merge row the control is quieter and records
// the ruling only, since the change has already landed.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "@/app/tts/components/info";
import Terms from "./terms";
import {
  dayAndClock,
  lasted,
  mergeRowOf,
  outcomeWords,
  agentHref,
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
  const all = events
    .filter((event) => event.kind === "merge")
    .map(mergeRowOf)
    .sort((left, right) => right.at - left.at);
  const merges = all.slice(0, MERGES_MAX);

  const commits = merges
    .filter((row) => row.repo !== null && row.sha !== null)
    .map((row) => ({ repo: row.repo as string, sha: row.sha as string }));

  const gates = useQuery(api.observe.gateRows, commits.length === 0 ? "skip" : { commits });
  const byKey = new Map((gates ?? []).map((gate) => [gate.key, gate]));
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="space-y-1.5">
      <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-text-muted">
        changes
        {all.length > merges.length && (
          <span className="text-[10px] font-normal font-mono text-text-faint">
            {merges.length} of {all.length}
          </span>
        )}
      </h2>
      <Waiting />
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
              {gate !== undefined && row.repo !== null && row.sha !== null && (
                <div className="flex justify-end px-2.5 pb-1.5">
                  <ApproveControl
                    ruled={gate.ruled}
                    quiet
                    target={{ repo: row.repo, sha: row.sha }}
                  />
                </div>
              )}
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
                  <Opens head={`${did.length} agents did this work`} tone="plain">
                    {did.length === 0 ? (
                      <p className="text-[11px] text-text-faint">
                        No agent in this window names this merge.
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
                              href={agentHref(run.runId)}
                              className="shrink-0 text-[11px] text-text-muted underline hover:text-text"
                            >
                              open the agent
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

type Target = { repo: string; number?: number; sha?: string };

/** The changes that are waiting: every open pull request the record mirrors.
 *  Nothing waiting draws nothing — an empty list under its own heading claims
 *  a section of the page for a fact already told by the changes below it —
 *  and undefined is Convex's word for a read that has not answered yet. */
function Waiting() {
  const waiting = useQuery(api.observe.changesWaiting, {});
  const [open, setOpen] = useState<string | null>(null);
  if (waiting === undefined || waiting.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {waiting.map((row) => {
        const showing = open === row.id;
        return (
          <div key={row.id} className="rounded-md border border-border bg-surface/50">
            <div className="flex items-start gap-2 px-2.5 py-1.5">
              <button
                type="button"
                aria-expanded={showing}
                onClick={() => setOpen(showing ? null : row.id)}
                className="-mx-1 min-w-0 flex-1 rounded px-1 text-left hover:bg-surface-alt/60"
              >
                <span className="block text-[13px] text-text">{row.title}</span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[10px]">
                  <span className="text-text-muted">
                    {row.branch}
                    {row.draft ? " · draft" : ""}
                  </span>
                  {row.checks.map((check) => (
                    <span key={check.name} className={check.passed ? "text-success" : "text-error"}>
                      {check.name}
                    </span>
                  ))}
                </span>
              </button>
              <ApproveControl ruled={row.ruled} quiet={false} target={{ repo: row.repo, number: row.number }} />
            </div>
            {row.ruled === "approve" && (
              <div className="px-2.5 pb-1.5 text-[11px] text-text-muted">
                {row.lastAttempt !== null && !row.lastAttempt.ok ? (
                  <>
                    <p>approved, waiting for a merge</p>
                    <Terms text={row.lastAttempt.why} className="block text-text-faint" />
                  </>
                ) : row.allowed ? (
                  <p>approved, merging</p>
                ) : (
                  <p>approved, lands when the gate is green</p>
                )}
              </div>
            )}
            {showing && (
              <div className="space-y-2 border-t border-border px-2.5 py-2">
                <Terms text={row.title} className="block text-[13px] leading-snug text-text" />
                <p className="font-mono text-[11px] text-text-muted">
                  #{row.number} · {row.branch} · {row.repo}@{row.headSha.slice(0, 7)}
                </p>
                <div className="space-y-1">
                  {row.checks.map((check) => (
                    <Opens key={check.name} head={check.name} tone={check.passed ? "pass" : "fail"}>
                      <Terms text={check.why} className="block text-[11px] text-text-muted" />
                    </Opens>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Approve, or the word already ruled. The mutation is idempotent on the
 * server; `pending` only stops a double press from sending two requests.
 */
function ApproveControl({
  ruled,
  quiet,
  target,
}: {
  ruled: string | null;
  quiet: boolean;
  target: Target;
}) {
  const approve = useMutation(api.observe.approveChange);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (ruled !== null) {
    return <span className="shrink-0 text-[11px] font-mono text-accent">{ruled}</span>;
  }
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      {failed !== null && <span className="text-[10px] text-error">{failed}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailed(null);
          try {
            await approve(target);
          } catch (error) {
            setFailed(error instanceof Error ? error.message : String(error));
          } finally {
            setPending(false);
          }
        }}
        className={
          quiet
            ? "rounded px-1.5 py-0.5 text-[11px] text-text-faint hover:bg-surface-alt hover:text-text disabled:opacity-50"
            : "rounded border border-border px-2 py-0.5 text-[11px] text-text hover:border-text-faint hover:bg-surface-alt disabled:opacity-50"
        }
      >
        Approve
      </button>
      <Info
        side="below"
        call={`observe.approveChange({ repo, ${target.number !== undefined ? "number" : "sha"} })`}
      >
        {quiet
          ? "Records your ruling approving this change. It has already merged, so nothing else happens."
          : "Records your ruling approving this change. The record merges it with a merge commit once its three gate rows are green."}
      </Info>
    </span>
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
