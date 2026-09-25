"use client";

// TO SIGN — a message an agent proposes to send in Tom's name, shown verbatim
// with the control that signs it beside it (Tom, 2026-09-25: agents "can also
// send messages in my name after i have reviewed the content and explicitily
// signed off"). At the top of the everything tab, above the runners, because
// nothing else on the page waits on him the way a person waiting on a reply
// does. Absent when nothing waits.
//
// The press is TWO PRESSES: the first arms the control and the second signs.
// What it signs cannot be taken back once it has gone out, and a phone screen
// takes a stray tap. The label changes in place inside a fixed width, so the
// arm never moves the layout.
//
// What the press writes is convex/ttsSignoff.ts signAndSend, the one writer of
// the sign-off table; the send happens in Convex after it, and only while the
// sign-off matches the text, the recipient and the channel shown here.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import Info from "./info";
import SectionHeader from "./section-header";
import { ageText, errMessage } from "@/app/tts/lib";

type Proposal = FunctionReturnType<typeof api.ttsSignoff.listProposals>[number];

/** Where the message goes, in words: the channel as the proposal names it. */
function channelWords(channel: string): string {
  if (channel === "calendar") return "a calendar invitation";
  const slack = /^slack:(.+)$/.exec(channel);
  return slack === null ? channel : `Slack ${slack[1]}`;
}

function agentHref(agentId: string): string {
  return `/agents?agent=${encodeURIComponent(agentId)}`;
}

export default function SignoffBlock({ now }: { now: number }) {
  const { isTom } = useAuth();
  const proposals = useQuery(api.ttsSignoff.listProposals, isTom ? {} : "skip");
  if (proposals === undefined || proposals.length === 0) return null;
  return (
    <section className="space-y-2">
      <SectionHeader title="to sign" count={proposals.length} />
      <div className="flex flex-col gap-1.5">
        {proposals.map((p) => (
          <ProposalRow key={p.id} proposal={p} now={now} />
        ))}
      </div>
    </section>
  );
}

function ProposalRow({ proposal: p, now }: { proposal: Proposal; now: number }) {
  const sign = useMutation(api.ttsSignoff.signAndSend);
  const decline = useMutation(api.ttsSignoff.decline);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const signLabel = armed
    ? "press again to send"
    : p.status === "failed"
      ? "sign and send again"
      : "sign and send";

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-xs text-text-muted">
          to <span className="text-text">{p.recipient}</span> · {channelWords(p.channel)} ·{" "}
          {ageText(p.at, now)}
          {p.agentId !== null && (
            <>
              {" · "}
              <a
                href={agentHref(p.agentId)}
                className="underline underline-offset-2 hover:text-text"
              >
                the agent
              </a>
            </>
          )}
        </span>
        {p.status === "sending" ? (
          <span className="text-xs text-text-faint">signed · sending</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-0.5">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  armed
                    ? void run(() => sign({ proposalId: p.id }))
                    : setArmed(true)
                }
                onBlur={() => setArmed(false)}
                className={`w-[10.5rem] rounded-md border px-2.5 py-1 text-xs hover:brightness-125 disabled:opacity-50 ${
                  armed
                    ? "border-accent text-accent"
                    : "border-border text-text-muted hover:border-text-faint hover:text-text"
                }`}
              >
                {signLabel}
              </button>
              <Info call="ttsSignoff.signAndSend({ proposalId })">
                Records your sign-off on exactly this text, to this recipient, on this channel,
                then sends it from Convex as you. The send goes out only while a sign-off matches
                all three, and it spends the sign-off.
              </Info>
            </span>
            <span className="inline-flex items-center gap-0.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => decline({ proposalId: p.id }))}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-text-faint hover:text-text disabled:opacity-50"
              >
                decline
              </button>
              <Info call="ttsSignoff.decline({ proposalId })">
                Takes the proposal off this list. Nothing is signed and nothing is sent.
              </Info>
            </span>
          </span>
        )}
      </div>
      {p.why !== null && <p className="text-xs text-text-faint">{p.why}</p>}
      <pre className="whitespace-pre-wrap break-words rounded border border-border bg-surface-alt/40 px-3 py-2 font-sans text-[13px] leading-snug text-text">
        {p.text}
      </pre>
      {p.status === "failed" && p.error !== null && (
        <p className="text-xs text-error">not sent: {p.error}</p>
      )}
      {error !== null && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
