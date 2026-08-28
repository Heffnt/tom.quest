"use client";

// One OPEN code-todo mirror row: a click-to-expand summary line plus the
// prepared brief and Tom's ruling controls. Descriptive copy only — the
// brief recommends, Tom rules, the worker applies. Closed mirror rows never
// reach this component (they stay compact links in the section).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ageText, type MirrorRow } from "../lib";

// Local names for the api.dtsCode row shapes (contract with convex/dtsCode.ts).
// Structural — the generated query types satisfy these.
export type CodeRulingKind =
  | "approve"
  | "needs-session"
  | "propose-archive"
  | "stale-replan"
  | "defer";

export type CodeBrief = {
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: "approve" | "needs-session" | "propose-archive" | "stale-replan";
  execClass: "box" | "needs-turing";
  evidence?: string;
  preparedAt: number;
};

export type CodeRuling = {
  repo: string;
  externalId: string;
  ruling: CodeRulingKind;
  note?: string;
  ruledAt: number;
  appliedAt?: number;
  applyResult?: string;
};

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
const chipCls =
  "text-xs text-text-faint border border-border rounded px-1 py-px";

const RULING_BUTTONS: { ruling: CodeRulingKind; label: string }[] = [
  { ruling: "approve", label: "Approve plan" },
  { ruling: "needs-session", label: "Needs session" },
  { ruling: "propose-archive", label: "Propose archive" },
  { ruling: "stale-replan", label: "Replan" },
  { ruling: "defer", label: "Defer" },
];

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
  brief: CodeBrief | undefined;
  /** The LIVE ruling (latest ruledAt), when one exists. */
  ruling: CodeRuling | undefined;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const recordCodeRuling = useMutation(api.dtsCode.recordCodeRuling);

  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a live ruling exists the buttons sit behind this disclosure.
  const [changeOpen, setChangeOpen] = useState(false);

  const rule = async (kind: CodeRulingKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await recordCodeRuling({
        repo: row.repo,
        externalId: row.externalId,
        ruling: kind,
        note: noteDraft.trim() || undefined,
      });
      setNoteDraft("");
      setChangeOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const controls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {RULING_BUTTONS.map(({ ruling: kind, label }) => (
          <button
            key={kind}
            onClick={() => void rule(kind)}
            disabled={busy}
            className={btnCls}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        value={noteDraft}
        onChange={(e) => setNoteDraft(e.target.value)}
        placeholder="note… (optional, recorded with the ruling)"
        className={`${inputCls} w-full max-w-md`}
      />
      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );

  return (
    <div className="border border-border rounded-lg bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 hover:bg-surface/60 rounded-lg"
      >
        <span className="text-sm text-text">{row.statement}</span>
        <span className={chipCls}>{row.tier}</span>
        {brief && (
          <span className={chipCls}>recommends: {brief.recommendation}</span>
        )}
        {brief?.execClass === "needs-turing" && (
          <span className={chipCls}>needs-turing</span>
        )}
        {ruling && (
          <span className="text-xs text-text-muted">
            {ruling.appliedAt !== undefined
              ? `applied: ${shortResult(ruling.applyResult ?? "no result recorded")}`
              : `ruled: ${ruling.ruling} — applying…`}
          </span>
        )}
        <span className="text-xs text-text-faint ml-auto">
          {row.status} · synced {ageText(row.syncedAt, now)}
        </span>
      </button>

      {expanded && brief && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-text-faint">
              brief · prepared {ageText(brief.preparedAt, now)}
            </div>
            <div className="text-xs text-text-muted whitespace-pre-wrap border border-border rounded-md px-2 py-1.5 bg-surface/60">
              {brief.brief}
            </div>
          </div>

          {brief.evidence && (
            <div className="text-xs">
              <span className="text-text-faint">evidence: </span>
              <span className="text-text-muted break-words">
                {brief.evidence}
              </span>
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

          {ruling ? (
            <div className="space-y-2">
              <div className="text-xs text-text-muted">
                ruled {ruling.ruling}, {ageText(ruling.ruledAt, now)}
                {ruling.note ? ` — ${ruling.note}` : ""}
              </div>
              <div className="text-xs text-text-muted">
                {ruling.appliedAt !== undefined ? (
                  <>
                    applied {ageText(ruling.appliedAt, now)}
                    {ruling.applyResult ? (
                      <>
                        {" — "}
                        <ApplyResult result={ruling.applyResult} />
                      </>
                    ) : null}
                  </>
                ) : (
                  "not yet applied — the worker picks rulings up on its next pass"
                )}
              </div>
              {changeOpen ? (
                <div className="space-y-1">
                  <div className="text-xs text-text-faint">
                    a new ruling supersedes the one above
                  </div>
                  {controls}
                </div>
              ) : (
                <button
                  onClick={() => setChangeOpen(true)}
                  className="text-xs text-text-faint hover:text-text-muted"
                >
                  change ruling
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-xs text-text-faint">your ruling</div>
              {controls}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
