"use client";

// THE DISAGREEMENT CANDIDATES: what stands as his until he says otherwise.
//
// A DELEGATE DECISION, with the lines it rested on. Each `restedOn` reference
// the delegate cited is drawn as the line it names when the list holds that
// line (pressing it opens the line's evidence in the drawer), and as the bare
// reference when it does not, so a citation nothing backs looks different
// from one that lands. Accept records that the decision stands; object opens
// the one fixed dialog for his sentence. Both are jarvis/intent.settle.
//
// A FAILING EVAL ITEM, with the ruling it tests. The judge, given his ruling's
// statement, answered another verdict; the note says which. "stands" records
// that his ruling stands as it is; "rule" takes the sentence the rules should
// carry so that the judge answers as he did.

import { useState } from "react";
import type { Decision, EvalItem } from "@/convex/jarvis/intent";
import Info from "@/app/jarvis/components/info";
import { errMessage } from "@/app/jarvis/lib";
import RulingDialog from "@/app/jarvis/components/ruling-dialog";
import { evalItemLineSuffix, linesRestedOn, type IntentLine } from "../lib";

type Verdict = "approve" | "revise";

type Pending = { subject: string; statement: string; action: string; confirm: string };

export default function Decisions({
  decisions,
  evalItems,
  lines,
  selected,
  onSelect,
  onSettle,
}: {
  decisions: Decision[];
  evalItems: EvalItem[];
  lines: IntentLine[];
  selected: string | null;
  onSelect: (line: IntentLine) => void;
  onSettle: (args: { subject: string; verdict: Verdict; sentence?: string }) => Promise<unknown>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const failing = evalItems.filter((item) => item.pass === false);
  const scored = evalItems.filter((item) => item.pass !== null).length;
  const skipped = evalItems.length - scored;

  return (
    <div className="space-y-5">
      <section>
        <h2 className="flex items-baseline gap-2 border-b border-border pb-1">
          <span className="text-[13px] font-semibold text-text">delegate decisions</span>
          <span className="text-[11px] font-mono text-text-faint">{decisions.length}</span>
          <Info call="jarvis/intent.decisions()" side="below">
            Every decision the delegate took in his place, newest first: the question, what it decided and why,
            and the lines of this page it rested on. One it refused is listed with its reason.
          </Info>
        </h2>
        {decisions.length === 0 && <p className="mt-2 text-[12px] text-text-muted">No delegate decision in the record.</p>}
        <ul>
          {decisions.map((decision) => (
            <li key={decision.id} className="border-b border-border/50 px-2 py-2">
              <p className="text-[13px] leading-snug text-text">{decision.question}</p>
              <p className="mt-0.5 text-[13px] leading-snug text-accent">
                {decision.refused ? `refused: ${decision.refusedBecause ?? "no reason given"}` : decision.decision}
              </p>
              {decision.reason !== null && <p className="mt-0.5 text-[12px] leading-snug text-text-muted">{decision.reason}</p>}
              {decision.wouldChange !== null && (
                <p className="mt-0.5 text-[11px] leading-snug text-text-faint">would change: {decision.wouldChange}</p>
              )}
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[10px] font-mono text-text-faint">
                <span>{new Date(decision.at).toISOString().slice(0, 16).replace("T", " ")}</span>
                <span>{decision.caller}</span>
                {decision.model !== null && <span>{decision.model}</span>}
                <span>{decision.askId}</span>
              </p>
              <RestedOn refs={decision.restedOn} lines={lines} selected={selected} onSelect={onSelect} />
              <Settle
                subject={`decision:${decision.askId}`}
                settled={decision.settled}
                // A refused or unanswered decision took nothing in his name, so
                // there is nothing to accept; he can only give his sentence.
                accept={decision.refused || decision.decision === null ? null : "accept"}
                object="object"
                statement={decision.decision ?? decision.question}
                onAccept={(subject) => onSettle({ subject, verdict: "approve" })}
                onObject={(subject, statement) =>
                  setPending({ subject, statement, action: "object", confirm: "record objection" })}
              />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="flex items-baseline gap-2 border-b border-border pb-1">
          <span className="text-[13px] font-semibold text-text">failing eval items</span>
          <span className="text-[11px] font-mono text-text-faint">{failing.length}</span>
          <Info call="jarvis/intent.evalItems()" side="below">
            The items the newest eval run of each set failed. A rule item is his ruling given to the judge; failing
            means the judge, reading the rules, answered another verdict than he did.
          </Info>
        </h2>
        {failing.length === 0 && (
          <p className="mt-2 text-[12px] text-text-muted">{noFailureText(scored, skipped)}</p>
        )}
        <ul>
          {failing.map((item) => {
            const suffix = evalItemLineSuffix(item.name);
            const line = suffix === null ? undefined : lines.find((one) => one.kind === "ruling" && one.id.endsWith(suffix));
            return (
              <li key={item.name} className="border-b border-border/50 px-2 py-2">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-mono text-text-faint">
                  <span className="text-text">{item.name}</span>
                  <span>
                    {item.passed}/{item.runs} runs passed
                  </span>
                  {item.model !== null && <span>{item.model}</span>}
                </p>
                {item.note !== "" && <p className="mt-0.5 text-[12px] leading-snug text-text-muted">{item.note}</p>}
                {line !== undefined ? (
                  <LineRef line={line} selected={selected} onSelect={onSelect} />
                ) : (
                  <p className="mt-0.5 text-[11px] text-text-faint">names no line of this page</p>
                )}
                <Settle
                  subject={`eval:${item.runId}:${item.name}`}
                  settled={item.settled}
                  accept="stands"
                  object="rule"
                  statement={line?.text ?? item.name}
                  onAccept={(subject) => onSettle({ subject, verdict: "approve" })}
                  onObject={(subject, statement) => setPending({ subject, statement, action: "rule", confirm: "record ruling" })}
                />
              </li>
            );
          })}
        </ul>
      </section>

      {pending !== null && (
        <RulingDialog
          action={pending.action}
          confirm={pending.confirm}
          placeholder="his sentence"
          required
          call={`jarvis/intent.settle({ subject: "${pending.subject}", verdict: "revise", sentence })`}
          effect="Records his sentence as an event of the record; when the decision was about a todo, writes his revise ruling on that todo too."
          statement={pending.statement}
          onConfirm={(sentence) => onSettle({ subject: pending.subject, verdict: "revise", sentence })}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

/** What the failing list says when nothing failed: a skipped item was not
 *  scored, so a run whose items were all skipped passed nothing. */
function noFailureText(scored: number, skipped: number): string {
  if (scored === 0 && skipped === 0) return "No eval item in the newest runs.";
  if (scored === 0) return `No item of the newest runs was scored: all ${skipped} were skipped.`;
  if (skipped === 0) return "Every item of the newest runs passed.";
  return `Every scored item of the newest runs passed; ${skipped} ${skipped === 1 ? "was" : "were"} skipped.`;
}

function RestedOn({
  refs,
  lines,
  selected,
  onSelect,
}: {
  refs: string[];
  lines: IntentLine[];
  selected: string | null;
  onSelect: (line: IntentLine) => void;
}) {
  if (refs.length === 0) return <p className="mt-1 text-[11px] text-text-faint">rested on nothing it named</p>;
  return (
    <ul className="mt-1 space-y-0.5">
      {refs.map((ref) => {
        const matched = linesRestedOn(ref, lines);
        return (
          <li key={ref}>
            <span className="text-[10px] font-mono text-text-faint">{ref}</span>
            {matched.length === 0 ? (
              <span className="ml-2 text-[10px] font-mono text-text-faint">(no line)</span>
            ) : (
              matched.map((line) => <LineRef key={line.id} line={line} selected={selected} onSelect={onSelect} />)
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LineRef({
  line,
  selected,
  onSelect,
}: {
  line: IntentLine;
  selected: string | null;
  onSelect: (line: IntentLine) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected === line.id}
      onClick={() => onSelect(line)}
      className={`block w-full px-2 py-0.5 text-left text-[12px] leading-snug text-text hover:bg-surface-alt ${
        selected === line.id ? "bg-surface-alt" : ""
      }`}
    >
      {line.text}
      <span className="ml-2 text-[10px] font-mono text-text-faint">
        {line.source} · {line.locator}
      </span>
    </button>
  );
}

function Settle({
  subject,
  settled,
  accept,
  object,
  statement,
  onAccept,
  onObject,
}: {
  subject: string;
  settled: { at: number; verdict: Verdict; sentence: string | null } | null;
  /** The accept button's word; null draws no accept button. */
  accept: string | null;
  object: string;
  statement: string;
  onAccept: (subject: string) => Promise<unknown>;
  onObject: (subject: string, statement: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (settled !== null) {
    return (
      <p className="mt-1 text-[11px] font-mono text-text-faint">
        {settled.verdict === "approve" ? "stands" : "objected"} ·{" "}
        {new Date(settled.at).toISOString().slice(0, 16).replace("T", " ")}
        {settled.sentence !== null && <span className="ml-2 text-text-muted">{settled.sentence}</span>}
      </p>
    );
  }
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        {accept !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed(null);
              // A refusal is shown under the controls: he must be able to tell
              // that nothing was recorded.
              void onAccept(subject)
                .catch((error: unknown) => setFailed(errMessage(error)))
                .finally(() => setBusy(false));
            }}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text disabled:opacity-50"
          >
            {accept}
          </button>
        )}
        <button
          type="button"
          onClick={() => onObject(subject, statement)}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
        >
          {object}
        </button>
        <Info
          call={
            accept === null
              ? `jarvis/intent.settle({ subject: "${subject}", verdict: "revise", sentence })`
              : `jarvis/intent.settle({ subject: "${subject}", verdict: "approve" | "revise", sentence? })`
          }
          side="below"
        >
          {accept === null
            ? `"${object}" takes his sentence and records it as an event of the record with his name on it; when a decision was about a todo, writes his revise ruling on that todo too. There is nothing to accept here: nothing was taken in his name.`
            : `"${accept}" records that this stands, as an event of the record with his name on it, and "${object}" takes his sentence first and records it; when a decision was about a todo, each writes his ruling on that todo too (approve, or revise with his sentence).`}
        </Info>
      </div>
      {/* Below the controls, not in their row: the row stays the controls. */}
      {failed !== null && <p className="mt-0.5 text-[11px] text-error">not recorded: {failed}</p>}
    </div>
  );
}
