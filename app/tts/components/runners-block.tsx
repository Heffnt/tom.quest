"use client";

// RUNNERS — the box's runners, above the batch cards on the batches tab. The
// live ones newest first, the ended ones under a fold. A row's title opens its
// newest step run in the run view on /sessions, which already walks the chain
// of steps back; a row expands to the runner's document, its check-ins and the
// questions it asked. The one action is Tom's: open a new runner.
//
// Status is ttsRunners.runnerStatus's, read off the query; nothing here
// derives one. The tier and decision words are the composer's own
// (runnerTierWords, runnerDecisionWords), so the page and Slack say the same
// thing.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { elapsedText, runnerDecisionWords, runnerTierWords } from "@/convex/ttsCompose";
import { NO_REPO, SESSION_REPO_NAMES } from "@/convex/ttsShared";
import { useAuth } from "@/app/lib/auth";
import Markdown from "@/app/sessions/components/markdown";
import Info from "./info";
import SectionHeader from "./section-header";
import { RUNNER_STATUS_WORDS, ageText, errMessage, fmtDate, untilText } from "@/app/tts/lib";

type Runner = FunctionReturnType<typeof api.ttsRunners.listRunners>[number];

/** The run view on /sessions, which reads ?run= on arrival. */
function runHref(runId: string): string {
  return `/sessions?run=${encodeURIComponent(runId)}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function RunnersBlock({ now }: { now: number }) {
  const { isTom } = useAuth();
  const runners = useQuery(api.ttsRunners.listRunners, {});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showEnded, setShowEnded] = useState(false);
  const [creating, setCreating] = useState(false);

  if (runners === undefined) return null;
  const live = runners.filter((r) => r.endedAt === null);
  const ended = runners.filter((r) => r.endedAt !== null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader title="runners" count={live.length} />
        {isTom && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-text-faint hover:text-text"
          >
            New runner
          </button>
        )}
      </div>
      {live.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {live.map((r) => (
            <RunnerRow
              key={r.runnerId}
              runner={r}
              now={now}
              expanded={expanded.has(r.runnerId)}
              onToggle={() => toggle(r.runnerId)}
            />
          ))}
        </div>
      )}
      {ended.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            aria-expanded={showEnded}
            onClick={() => setShowEnded((v) => !v)}
            className="flex items-center gap-1.5 rounded px-1 text-left hover:bg-surface-alt/60"
          >
            <span className="text-[11px] text-text-faint">{showEnded ? "▾" : "▸"}</span>
            <SectionHeader title="ended runners" count={ended.length} />
          </button>
          {showEnded &&
            ended.map((r) => (
              <RunnerRow
                key={r.runnerId}
                runner={r}
                now={now}
                expanded={expanded.has(r.runnerId)}
                onToggle={() => toggle(r.runnerId)}
              />
            ))}
        </div>
      )}
      {creating && <NewRunnerDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

function RunnerRow({
  runner: r,
  now,
  expanded,
  onToggle,
}: {
  runner: Runner;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const waiting = r.status === "waiting-on-tom";
  return (
    <div className={`rounded-lg border bg-surface ${expanded ? "border-[#2c3a52]" : "border-border"}`}>
      <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-3 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "collapse" : "expand"}
          onClick={onToggle}
          className="mt-0.5 rounded text-[11px] text-text-faint hover:bg-surface-alt hover:text-text"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            {r.stepRunId !== null ? (
              <a
                href={runHref(r.stepRunId)}
                className="truncate text-[15px] text-text underline underline-offset-2 hover:opacity-80"
              >
                {r.title}
              </a>
            ) : (
              <span className="truncate text-[15px] text-text">{r.title}</span>
            )}
            <span
              className={`shrink-0 text-xs ${
                waiting ? "rounded border border-accent/60 px-1 text-accent" : "text-text-faint"
              }`}
            >
              {RUNNER_STATUS_WORDS[r.status]}
            </span>
          </span>
          <span className="block truncate text-xs text-text-muted">
            {r.experimentHost} · {r.type} · every {elapsedText(r.stepMs)}
            {r.endedAt === null
              ? ` · next step ${untilText(r.nextStepAt, now)}`
              : ` · ended ${ageText(r.endedAt, now)}`}
          </span>
          <span className="block truncate text-xs text-text-faint">
            {r.lastCheckIn === null
              ? "no check-in"
              : `${ageText(r.lastCheckIn.at, now)} · ${r.lastCheckIn.line ?? ""}`}
          </span>
        </span>
      </div>
      {expanded && <RunnerDetail runnerId={r.runnerId} now={now} />}
    </div>
  );
}

const SECTION = "text-[10px] uppercase tracking-wide text-text-faint";

function RunnerDetail({ runnerId, now }: { runnerId: Id<"runners">; now: number }) {
  const detail = useQuery(api.ttsRunners.runnerDetail, { runnerId });
  const [showDocument, setShowDocument] = useState(false);
  if (detail === undefined) return <div className="border-t border-border px-3 py-2 text-xs text-text-faint">loading…</div>;
  if (detail === null) return null;
  return (
    <div className="space-y-3 border-t border-border px-3 pb-3 pt-2.5">
      <div>
        <span className="inline-flex items-center gap-0.5">
          <button
            type="button"
            aria-expanded={showDocument}
            onClick={() => setShowDocument((v) => !v)}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-text-faint hover:text-text"
          >
            document · version {detail.documentVersion}
          </button>
          <Info call="ttsRunners.runnerDetail({ runnerId })">
            Shows the runner&rsquo;s handoff document as its last step rewrote it. Each step
            starts from this document and nothing else. Read-only here.
          </Info>
        </span>
        {showDocument && (
          <div className="mt-2 rounded border border-border bg-surface-alt/40 px-3 py-2">
            <Markdown text={detail.document} />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className={SECTION}>questions</div>
        {detail.asks.length === 0 ? (
          <div className="text-[13px] text-text-faint">none</div>
        ) : (
          detail.asks.map((ask) => (
            <div key={ask.id} className="space-y-0.5 text-[13px]">
              <div className="text-text">{ask.text}</div>
              <div className="text-xs text-text-muted">
                {fmtDate(ask.at)} {clock(ask.at)}
                {ask.tier !== null && ` · ${runnerTierWords[ask.tier]}`}
                {ask.blocking ? " · its steps change nothing until answered" : " · its steps carry on"}
                {ask.answeredAt === null ? (
                  <span className="text-accent"> · unanswered</span>
                ) : (
                  ` · answered ${ageText(ask.answeredAt, now)}`
                )}
              </div>
              {ask.answerText !== null && (
                <div className="text-xs text-text-muted">your answer: {ask.answerText}</div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <div className={SECTION}>check-ins</div>
        {detail.checkIns.length === 0 ? (
          <div className="text-[13px] text-text-faint">none</div>
        ) : (
          detail.checkIns.map((c) => (
            <div key={c.id} className="space-y-1 border-l border-border pl-2.5">
              <div className="text-xs text-text-muted">
                {fmtDate(c.at)} {clock(c.at)}
                {c.decision !== null && ` · ${runnerDecisionWords[c.decision]}`}
                {c.verdict === "fail" && " · did not pass the writing check"}
                {c.stepRunId !== null && (
                  <>
                    {" · "}
                    <a
                      href={runHref(c.stepRunId)}
                      className="underline underline-offset-2 hover:text-text"
                    >
                      step run
                    </a>
                  </>
                )}
              </div>
              <Markdown text={c.text} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const FIELD =
  "bg-surface-alt border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent";

function NewRunnerDialog({ onClose }: { onClose: () => void }) {
  const createRunner = useMutation(api.ttsRunners.createRunner);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"campaign" | "probe">("campaign");
  const [experimentHost, setHost] = useState<"turing" | "box">("turing");
  const [repo, setRepo] = useState<string>(SESSION_REPO_NAMES[0] ?? NO_REPO);
  const [stepMinutes, setStepMinutes] = useState("10");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minutes = Number(stepMinutes.trim());
  const ready = title.trim() !== "" && objective.trim() !== "" && Number.isFinite(minutes) && minutes > 0;

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createRunner({
        title: title.trim(),
        type,
        experimentHost,
        repo,
        stepMs: Math.round(minutes * 60_000),
        from: { kind: "prompt", text: objective },
      });
      onClose();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-label="New runner" className="w-full max-w-lg space-y-2 rounded-lg border border-border bg-surface p-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="title"
          className={`w-full ${FIELD}`}
        />
        <div className="flex flex-wrap gap-2">
          <select aria-label="type" value={type} onChange={(e) => setType(e.target.value as "campaign" | "probe")} className={FIELD}>
            <option value="campaign">campaign</option>
            <option value="probe">probe</option>
          </select>
          <select aria-label="host" value={experimentHost} onChange={(e) => setHost(e.target.value as "turing" | "box")} className={FIELD}>
            <option value="turing">turing</option>
            <option value="box">box</option>
          </select>
          <select aria-label="repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={FIELD}>
            {[...SESSION_REPO_NAMES, NO_REPO].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            step, minutes
            <input
              type="text"
              inputMode="numeric"
              aria-label="step length in minutes"
              value={stepMinutes}
              onChange={(e) => setStepMinutes(e.target.value)}
              className={`w-16 ${FIELD}`}
            />
          </label>
        </div>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={5}
          placeholder="objective"
          className={`w-full resize-y ${FIELD}`}
        />
        {error && <div className="text-xs text-error">{error}</div>}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => void create()}
              disabled={!ready || busy}
              className="rounded border border-accent px-4 py-2 text-sm text-accent hover:bg-surface-alt disabled:opacity-50"
            >
              Create runner
            </button>
            <Info call="ttsRunners.createRunner({ title, type, experimentHost, repo, stepMs, from })">
              Writes the runner, its first document holding the objective, and its first step,
              due now. The box launches that step on its next poll, and each step schedules the
              next one step length later.
            </Info>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:border-text-faint hover:text-text"
          >
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
