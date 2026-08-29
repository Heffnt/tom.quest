"use client";

// One code-todo mirror row: click-to-expand summary line + ruling controls,
// importance, brief, evidence, the live ruling state (newest ruledAt per
// subject, derived by the tab and passed in), and the link out. First rulings
// happen on the batches tab; this row carries the SUPERSEDE path — "change
// ruling" appends a new ruling row that replaces the live one (append-only,
// history kept).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import Info from "./info";
import VerdictButtons from "./verdict-buttons";
import { ageText, errMessage, IMPORTANCE_LEVELS, type MirrorRow } from "../lib";

const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

function shortResult(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** applyResult as a link when it is a URL, plain text otherwise. */
function ApplyResult({ result }: { result: string }) {
  if (result.startsWith("http")) {
    return (
      <a
        href={result}
        target="_blank"
        rel="noreferrer"
        className="text-accent hover:underline break-all"
      >
        {result}
      </a>
    );
  }
  return <span className="break-words">{result}</span>;
}

export default function CodeTodoRow({
  row,
  brief,
  ruling,
  now,
  expanded,
  onToggle,
}: {
  row: MirrorRow;
  /** The prepared brief for this item, when one exists. */
  brief: Doc<"dtsCodeBriefs"> | undefined;
  /** The LIVE ruling (newest ruledAt for this repo+externalId), when one exists. */
  ruling: Doc<"dtsRulings"> | undefined;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const recordRuling = useMutation(api.dtsRulings.recordRuling);
  const setCodeImportance = useMutation(api.dtsCode.setCodeImportance);
  // First rulings happen on the batches tab; here the buttons sit behind this
  // disclosure — a new ruling supersedes the live one shown below.
  const [changeOpen, setChangeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setLevel = async (level: "low" | "medium" | "high" | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setCodeImportance({
        repo: row.repo,
        externalId: row.externalId,
        level,
      });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span
          className={`text-sm ${
            row.status === "open" ? "text-text" : "text-text-faint line-through"
          }`}
        >
          {row.statement}
        </span>
        <span className={chipCls}>{row.tier}</span>
        <span className={chipCls}>{row.repo}</span>
        <span className={chipCls}>{row.status}</span>
        {brief && (
          <span className={chipCls}>recommends: {brief.recommendation}</span>
        )}
        {ruling && (
          <span className="text-xs text-text-muted">
            {ruling.appliedAt !== undefined
              ? `applied: ${shortResult(ruling.applyResult ?? "no result recorded")}`
              : `ruled ${ruling.verdict} · applying…`}
          </span>
        )}
        <span className="text-xs text-text-faint ml-auto">
          synced {ageText(row.syncedAt, now)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-3">
          {/* actions first */}
          {row.status === "open" &&
            (changeOpen ? (
              <div className="space-y-1">
                <div className="text-xs text-text-faint">
                  a new ruling supersedes the live one
                </div>
                <VerdictButtons
                  record={(args) =>
                    recordRuling({
                      repo: row.repo,
                      externalId: row.externalId,
                      ...args,
                    })
                  }
                />
              </div>
            ) : (
              <button
                onClick={() => setChangeOpen(true)}
                className="text-xs text-text-faint hover:text-text-muted"
              >
                {ruling ? "change ruling" : "rule here"}
              </button>
            ))}

          {/* importance — lives on the brief; override same as life todos */}
          {brief && (
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-text-faint">importance</span>
                {IMPORTANCE_LEVELS.map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => void setLevel(lvl)}
                    disabled={busy}
                    className={`${btnCls} ${
                      brief.importance?.level === lvl
                        ? "border-accent/60 text-text"
                        : ""
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
                {brief.importance && (
                  <button
                    onClick={() => void setLevel(null)}
                    disabled={busy}
                    className="text-xs text-text-faint hover:text-text-muted"
                  >
                    clear
                  </button>
                )}
                <Info label="dtsCode.setCodeImportance({repo, externalId, level})" />
                {brief.importance && (
                  <span className="text-xs text-text-faint">
                    · {brief.importance.setBy}
                  </span>
                )}
              </div>
              {brief.importance?.setBy === "agent" &&
                brief.importance.rationale && (
                  <div className="text-xs text-text-faint">
                    {brief.importance.rationale}
                  </div>
                )}
              {error && <div className="text-xs text-error">{error}</div>}
            </div>
          )}

          {brief && (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">
                brief · {brief.execClass} · prepared{" "}
                {ageText(brief.preparedAt, now)}
              </div>
              <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
                {brief.brief}
              </div>
            </div>
          )}

          {brief?.evidence && (
            <div className="text-xs">
              <span className="text-text-faint">evidence: </span>
              <span className="text-text-muted break-words">
                {brief.evidence}
              </span>
            </div>
          )}

          {ruling && (
            <div className="text-xs text-text-muted">
              ruled {ruling.verdict}, {ageText(ruling.ruledAt, now)}
              {ruling.sentence ? ` — ${ruling.sentence}` : ""}
              {ruling.appliedAt !== undefined && (
                <>
                  {" · applied "}
                  {ageText(ruling.appliedAt, now)}
                  {ruling.applyResult ? (
                    <>
                      {" — "}
                      <ApplyResult result={ruling.applyResult} />
                    </>
                  ) : null}
                </>
              )}
            </div>
          )}

          <div className="text-xs">
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              open in {row.repo}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
