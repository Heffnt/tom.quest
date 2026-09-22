"use client";

// CHANGES for the window: one row per merge the record holds, with the commit
// subject the merge was reported under, its sha, and what the merge gate says
// about that commit — the three head rows, read back through the gate's own
// answer (convex/observe.ts gateRows).
//
// The link is the pull request when the record's own sentence about the sha
// names one, and the commit otherwise: the merge row keeps the repository, the
// sha, the subject and GitHub's answer, and no pull request number of its own.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { dayAndClock, mergeHref, mergeRowOf, type PointEvent } from "../lib";

export default function ChangesList({ events }: { events: PointEvent[] }) {
  const merges = events
    .filter((event) => event.kind === "merge")
    .map(mergeRowOf)
    .sort((left, right) => right.at - left.at)
    .slice(0, 60);

  const commits = merges
    .filter((row) => row.repo !== null && row.sha !== null)
    .map((row) => ({ repo: row.repo as string, sha: row.sha as string }));

  const gates = useQuery(api.observe.gateRows, commits.length === 0 ? "skip" : { commits });
  const byKey = new Map((gates ?? []).map((gate) => [gate.key, gate]));

  return (
    <section className="space-y-1.5">
      <h2 className="text-[13px] font-semibold text-text-muted">changes</h2>
      <div className="flex flex-col gap-1.5">
        {merges.map((row) => {
          const href = mergeHref(row);
          const gate = row.commitKey === null ? undefined : byKey.get(row.commitKey);
          return (
            <div key={row.id} className="rounded-md border border-border bg-surface/50 px-2.5 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-[13px] text-text">
                  {href === null ? (
                    (row.subject ?? "")
                  ) : (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-accent"
                    >
                      {row.subject ?? href}
                    </a>
                  )}
                </span>
                <span className="shrink-0 text-[10px] font-mono text-text-faint">
                  {dayAndClock(row.at)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-mono text-text-muted">
                  {row.repo ?? ""}@{(row.sha ?? "").slice(0, 7)}
                </span>
                {gate === undefined
                  ? null
                  : gate.checks.map((check) => (
                      <span
                        key={check.name}
                        aria-label={check.why}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                          check.passed
                            ? "bg-success/15 text-success"
                            : "bg-error/15 text-error"
                        }`}
                      >
                        {check.name}
                      </span>
                    ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
