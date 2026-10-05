"use client";

// The Jarvis thread as drawn: header, open items, the stream by New York day,
// composer. A row is one line until pressed; the fragment's row is expanded.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Info from "@/app/jarvis/components/info";
import { slackSegments } from "./digest-text";
import { addDays, displayDayKey, displayTime, newYorkDay } from "@/shared/clock.mjs";
import { decidedByText } from "@/shared/decided-by.mjs";
import { type AgentChange, type FeedItem, type OpenItems as OpenData, type Said, type ThreadMessage } from "./feed";
import OpenItems, { needsYouTarget, type ReplyTarget } from "./open-items";


type Row<T extends FeedItem["type"]> = Extract<FeedItem, { type: T }>;
type Merge = Extract<AgentChange, { kind: "merge" }>;

function dayLabel(day: string, today: string, yesterday: string): string {
  const date = displayDayKey(day);
  if (day === today) return `Today · ${date}`;
  if (day === yesterday) return `Yesterday · ${date}`;
  return date;
}

/** The digest's folded line: each section it printed but the settled run,
 *  in the order the composer counted them, with its item count. */
function digestLine(digest: Row<"digest">["digest"]): string {
  const counts: Record<string, number> = {
    ...digest.sectionCounts,
    "needs-you-today": digest.items.length + digest.laterItems,
  };
  const parts = Object.entries(counts).filter(([section, n]) => section !== "settled" && n > 0).map(([section, n]) => `${section} ${n}`);
  return ["digest", ...parts].join(" · ");
}

/** A decision's one line. */
function decisionLine(decision: { question: string; decision: string }): string {
  const stop = /[.?!]$/.test(decision.question) ? "" : ".";
  return `Decision: ${decision.question}${stop} ${decision.decision}`;
}

/** A suggestion's one line. */
function suggestionLine(suggestion: { class: string; built: boolean; text: string }): string {
  return `Suggestion (${suggestion.class}, ${suggestion.built ? "built" : "proposed"}): ${suggestion.text}`;
}

/** The accept control of a decision: jarvis/intent.settle with verdict
 *  approve, a refusal shown under it. */
function Settle({ onAccept }: { onAccept: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(null);
          // A refusal is shown under the controls: he must be able to tell
          // that nothing was recorded.
          void onAccept()
            .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)))
            .finally(() => setBusy(false));
        }}
        className="rounded-md border border-border px-2 py-0.5 text-xs text-text-muted hover:bg-surface-alt hover:text-text disabled:opacity-50"
      >
        accept
      </button>
      {failed !== null && <p className="mt-0.5 text-[11px] text-error">not recorded: {failed}</p>}
    </div>
  );
}

function returnLine(change: Merge): string {
  return `${change.line}${change.checksAlone ? " · on checks alone" : ""}`;
}


function checkLine(check: Row<"check">["check"]): string {
  return `${check.part}: ${check.check} failed, ${check.measure} against ${check.target === null ? "nothing" : check.target}`;
}

function SlackText({ text }: { text: string }) {
  return slackSegments(text).map((segment, index) => "href" in segment ? (
    <a
      key={index}
      href={segment.href}
      {...(segment.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}
      className="underline underline-offset-2 hover:text-accent"
    >
      {segment.text}
    </a>
  ) : <span key={index}>{segment.text}</span>);
}

const timeCls = "pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint";
const linkCls = "underline underline-offset-2 transition-colors hover:text-text";
const monoCls = "font-mono text-[11px] text-text-faint";

function Time({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()} className={timeCls}>{displayTime(at)}</time>;
}

/** A link inside a pressable line: following it does not fold the line. */
function InlineLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      onClick={(e) => e.stopPropagation()}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={`ml-2 ${linkCls}`}
    >
      {children}
    </a>
  );
}

function ReplyButton({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPress}
      className={`rounded-md border px-2 py-0.5 text-xs hover:bg-surface-alt hover:text-text ${on ? "border-accent/60 bg-surface-alt text-text" : "border-border text-text-muted"}`}
    >
      {on ? "Replying" : label}
    </button>
  );
}

/** One stream row that folds: its time, one pressable line, and when
 *  expanded the fields and controls beneath it. */
function FoldRow({
  id, at, line, expanded, onToggle, children,
}: {
  id?: string; at: number; line: ReactNode; expanded: boolean; onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li id={id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <Time at={at} />
      <div className="min-w-0">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className={`cursor-pointer rounded-r border-l-2 border-border pl-3 text-[15px] leading-6 text-text-muted hover:bg-surface-alt ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}
        >
          {line}
        </div>
        {expanded && <div className="space-y-1 pb-1 pl-3.5 pt-1 text-sm leading-5 text-text-muted">{children}</div>}
      </div>
    </li>
  );
}

function MessageRow({ message: s }: { message: Said }) {
  return (
    <li id={s.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <Time at={s.at} />
      <p className="whitespace-pre-wrap break-words border-l-2 border-accent/60 pl-3 text-[15px] leading-6 text-text">
        {s.text}
      </p>
      <span className={`font-mono text-[11px] leading-5 ${s.needsTom ? "text-accent" : "text-text-faint"}`}>
        {s.kind ?? ""}
      </span>
      <p className={`break-words pl-3.5 text-sm leading-5 ${s.needsTom ? "text-text" : s.processed ? "text-text-muted" : "text-text-faint"}`}>
        {s.line}
      </p>
    </li>
  );
}

/** A line of the silence alarm (convex/jarvis/jobs.ts): what went silent,
 *  and the agents window that shows it. No control: it is no question. */
function AlarmRow({ alarm }: { alarm: Row<"alarm">["alarm"] }) {
  return (
    <li id={alarm.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <Time at={alarm.at} />
      <div className="min-w-0">
        <p className="font-mono text-[11px] leading-5 text-text-faint">Jarvis · silence alarm</p>
        <p className="break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text">
          {alarm.text}
          <a href={alarm.href} className={`ml-2 ${linkCls} hover:text-accent`}>agents</a>
        </p>
      </div>
    </li>
  );
}

function NeedsYouRow({ item, replying, onReply }: { item: Row<"item">["item"]; replying: boolean; onReply: () => void }) {
  return (
    <li id={item.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <Time at={item.at} />
      <div className="min-w-0">
        <p className="font-mono text-[11px] leading-5 text-text-faint">Jarvis · needs you</p>
        <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text">
          <span className="mr-1 font-mono text-[11px] text-text-faint">{item.n} ·</span><SlackText text={item.text} />
        </p>
      </div>
      <span />
      <div className="flex justify-end pt-1">
        <ReplyButton on={replying} label="Reply" onPress={onReply} />
      </div>
    </li>
  );
}

function ChangeRow({ change, replying, onReply }: { change: AgentChange; replying: boolean; onReply: () => void }) {
  return (
    <li id={change.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <Time at={change.at} />
      <p className="break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text-muted">
        {change.line}
        {change.href !== null && <InlineLink href={change.href} external>diff</InlineLink>}
      </p>
      <span className="font-mono text-[11px] leading-5 text-text-faint">jarvis</span>
      <div className="pl-3">
        <ReplyButton on={replying} label="Reply" onPress={onReply} />
      </div>
    </li>
  );
}


/** The row id the fragment names (/thread#<row id>), read again on hashchange. */
export function useHashId(): string | null {
  const [hashId, setHashId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setHashId(window.location.hash.length > 1 ? decodeURIComponent(window.location.hash.slice(1)) : null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return hashId;
}

type ThreadViewProps = {
  days: Array<[string, FeedItem[]]>;
  open: OpenData | undefined;
  loading: boolean;
  /** One line per read that stopped early. */
  cuts: string[];
  /** The fragment's decision past the stream's 60 days (api.thread.row). */
  linked?: Extract<ThreadMessage, { kind: "decision" }> | null;
  /** The push control, drawn on the header's right. */
  headerControl?: ReactNode;
  onSend: (text: string, subject?: string) => Promise<unknown>;
  onAccept: (askId: string) => Promise<unknown>;
  now?: number;
};

export default function ThreadView({ days, open, loading, cuts, linked, headerControl, onSend, onAccept, now = Date.now() }: ThreadViewProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const hashId = useHashId();
  const today = newYorkDay(now);
  const yesterday = addDays(today, -1);
  const canSend = draft.trim() !== "" && !sending;
  const placeholder = target?.placeholder ?? "Message Jarvis";

  // A cold link's row mounts after the browser's own fragment scroll found
  // nothing, so the page does that scroll itself, once per fragment.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (hashId === null || scrolledTo.current === hashId) return;
    const row = document.getElementById(hashId);
    if (row === null) return;
    scrolledTo.current = hashId;
    row.scrollIntoView?.({ block: "start" });
  });

  // A fragment opens its row over a fold he made by hand before.
  useEffect(() => {
    if (hashId === null) return;
    setToggled((was) => {
      if (!was.has(hashId)) return was;
      const next = new Map(was);
      next.delete(hashId);
      return next;
    });
  }, [hashId]);
  const isOpen = (id: string) => toggled.get(id) ?? id === hashId;
  const toggle = (id: string) => setToggled((was) => new Map(was).set(id, !isOpen(id)));
  const reply = (next: ReplyTarget, prefill = "") => {
    if (target?.id === next.id) {
      setTarget(null);
      if (draft === prefill) setDraft("");
      return;
    }
    setTarget(next);
    if (prefill !== "") setDraft(prefill);
  };
  const replying = (id: string) => target?.id === id;

  async function submit() {
    if (draft.trim() === "" || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend(draft, target === null ? undefined : target.subject ?? target.id);
      setDraft("");
      setTarget(null);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  const digests = days.flatMap(([, rows]) => rows.filter((row): row is Row<"digest"> => row.type === "digest"));
  const newestDigestId = digests.at(-1)?.id ?? null;

  // A row the open items draw carries no element id: the stream's copy of it
  // is the one a link lands on.
  function rowOf(item: FeedItem, inOpen = false): ReactNode {
    const replies = item.replies.map((said) => <MessageRow key={said.id} message={said} />);
    switch (item.type) {
      case "said":
        return <MessageRow key={item.id} message={item.said} />;
      case "alarm":
        return <AlarmRow key={item.id} alarm={item.alarm} />;
      case "item":
        return (
          <NeedsYouRow
            key={item.id}
            item={item.item}
            replying={replying(needsYouTarget(item.item.digestId, item.item.n).id)}
            onReply={() => reply(needsYouTarget(item.item.digestId, item.item.n), `${item.item.n} `)}
          />
        );
      case "digest": {
        const digest = item.digest;
        return (
          <FoldRow key={item.id} id={item.id} at={item.at} line={digestLine(digest)} expanded={isOpen(item.id)} onToggle={() => toggle(item.id)}>
            <p className="whitespace-pre-wrap break-words text-[15px] leading-6 text-text"><SlackText text={digest.text ?? ""} /></p>
            {digest.items.length > 0 && (
              <ol className="space-y-1">
                {digest.items.map((one) => (
                  <li key={one.n} className="flex gap-1">
                    <span className="shrink-0 font-mono text-[11px] text-text-faint">{one.n} ·</span>
                    <span className="whitespace-pre-wrap break-words"><SlackText text={one.text} /></span>
                  </li>
                ))}
              </ol>
            )}
            {digest.replies.length > 0 && (
              <ul className="space-y-1">
                {digest.replies.map(({ reply, ...one }) => (
                  <li key={one.id} id={one.id}>
                    <p className="whitespace-pre-wrap break-words border-l-2 border-accent/60 pl-3 text-[15px] leading-6 text-text">{one.text}</p>
                    {/* A cut reply is unknown: neither drawn nor "not processed yet". */}
                    {(reply === null || !("cut" in reply)) && (
                      <p className={`pl-3.5 ${reply?.kind === "question" ? "text-text" : reply ? "" : "text-text-faint"}`}>
                        <span className={`mr-1 ${monoCls}`}>{reply?.kind ?? ""}</span>
                        {reply?.text ?? "not processed yet"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <ReplyButton on={replying(item.id)} label="Reply" onPress={() => reply({ id: item.id, placeholder: `Reply to the ${digest.day} digest` })} />
          </FoldRow>
        );
      }
      case "change": {
        const change = item.change;
        const onReply = () => reply({ id: item.id, placeholder: "Reply to Jarvis" });
        if (change.kind !== "merge") {
          return [<ChangeRow key={item.id} change={change} replying={replying(item.id)} onReply={onReply} />, ...replies];
        }
        return [
          <FoldRow
            key={item.id}
            id={item.id}
            at={item.at}
            expanded={isOpen(item.id)}
            onToggle={() => toggle(item.id)}
            line={<>{returnLine(change)}{change.href !== null && <InlineLink href={change.href} external>diff</InlineLink>}</>}
          >
            {change.claim !== null && <p className="whitespace-pre-wrap break-words text-text">{change.claim}</p>}
            {change.parts.length > 0 && (
              <ul>
                {change.parts.map((part) => <li key={`${part.fate}:${part.id}`} className="font-mono text-[12px]">{part.name} · {part.fate}</li>)}
              </ul>
            )}
            {change.explanation !== null && <Info explanation={change.explanation} explanationTitle={change.line} side="below" />}
            <ReplyButton on={replying(item.id)} label="Reply" onPress={onReply} />
          </FoldRow>,
          ...replies,
        ];
      }
      case "decision": {
        const decision = item.decision;
        const verdict = decision.settled === null ? null : decision.settled.verdict === "approve" ? "stands" : "objected";
        return [
          <FoldRow
            key={item.id}
            id={inOpen ? undefined : item.id}
            at={item.at}
            expanded={isOpen(item.id)}
            onToggle={() => toggle(item.id)}
            line={<>{decisionLine(decision)}{verdict !== null && <span className={`ml-2 ${monoCls}`}>{verdict}</span>}</>}
          >
            {decision.reason !== null && <p>{decision.reason}</p>}
            {decision.wouldChange !== null && <p>would change: {decision.wouldChange}</p>}
            {decidedByText(decision.decidedByTom, decision.waitedMs) !== null && <p>{decidedByText(decision.decidedByTom, decision.waitedMs)}</p>}
            {decision.restedOn.length > 0 && (
              <ul>
                {decision.restedOn.map((ref) => <li key={ref}><a href="/intent" className={`${monoCls} ${linkCls}`}>{ref}</a></li>)}
              </ul>
            )}
            <p className={`flex flex-wrap gap-x-2 ${monoCls}`}>
              <span>{decision.caller}</span>
              {decision.model !== null && <span>{decision.model}</span>}
              <span>{decision.askId}</span>
            </p>
            {decision.todoId !== null && <p><a href={`/jarvis?item=${decision.todoId}`} className={linkCls}>todo</a></p>}
            {/* His own decision is not one to accept or object to. */}
            {decision.decidedByTom ? null : decision.settled === null ? (
              <div className="flex items-start gap-1.5">
                <Settle onAccept={() => onAccept(decision.askId)} />
                <ReplyButton on={replying(item.id)} label="object" onPress={() => reply({ id: item.id, placeholder: "Object to this decision" })} />
              </div>
            ) : (
              <p className={monoCls}>
                {verdict} · {displayTime(decision.settled.at)}
                {decision.settled.sentence !== null && <span className="ml-2 text-text-muted">{decision.settled.sentence}</span>}
              </p>
            )}
          </FoldRow>,
          ...replies,
        ];
      }
      case "suggestion": {
        const suggestion = item.suggestion;
        return [
          <FoldRow
            key={item.id}
            id={inOpen ? undefined : item.id}
            at={item.at}
            line={suggestionLine(suggestion)}
            expanded={isOpen(item.id)}
            onToggle={() => toggle(item.id)}
          >
            {suggestion.restsOn !== null && (
              <p>
                {suggestion.restsOn.text}
                {suggestion.restsOn.source !== "" && <span className={`ml-2 ${monoCls}`}>{suggestion.restsOn.source}</span>}
              </p>
            )}
            <p>{suggestion.href !== null ? <a href={suggestion.href} className={linkCls}>{suggestion.subject}</a> : suggestion.subject}</p>
            {suggestion.answer !== null && <p className="text-text">{suggestion.answer.text}</p>}
            <ReplyButton on={replying(item.id)} label="yes, no, or a sentence" onPress={() => reply({ id: item.id, placeholder: "Yes, no, or a sentence" })} />
          </FoldRow>,
          // His answer is drawn once, as the row's answer above.
          ...item.replies.filter((said) => said.id !== suggestion.answer?.messageId)
            .map((said) => <MessageRow key={said.id} message={said} />),
        ];
      }
      case "check": {
        const check = item.check;
        return [
          <FoldRow
            key={item.id}
            id={item.id}
            at={item.at}
            expanded={isOpen(item.id)}
            onToggle={() => toggle(item.id)}
            line={<>{checkLine(check)}{check.agentHref !== null && <InlineLink href={check.agentHref}>agent</InlineLink>}</>}
          >
            <ReplyButton on={replying(item.id)} label="Reply" onPress={() => reply({ id: item.id, placeholder: "Reply under this line" })} />
          </FoldRow>,
          ...replies,
        ];
      }
      case "diagnosis": {
        const diagnosis = item.diagnosis;
        return [
          <FoldRow key={item.id} id={item.id} at={item.at} line={diagnosis.text} expanded={isOpen(item.id)} onToggle={() => toggle(item.id)}>
            <ul>
              {diagnosis.causes.map((cause) => <li key={cause.n}>{cause.n} · {cause.class} · {cause.sentence}</li>)}
            </ul>
            {(diagnosis.fixLanding !== null || diagnosis.preventionLanding !== null) && (
              <p className="flex gap-3">
                {diagnosis.fixLanding !== null && <a href={`#${diagnosis.fixLanding}`} className={linkCls}>fix</a>}
                {diagnosis.preventionLanding !== null && <a href={`#${diagnosis.preventionLanding}`} className={linkCls}>prevention</a>}
              </p>
            )}
            <ReplyButton on={replying(item.id)} label="Reply" onPress={() => reply({ id: item.id, placeholder: "Reply under this line" })} />
          </FoldRow>,
          ...replies,
        ];
      }
    }
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] w-full flex-col">
      <header className="mx-auto flex w-full max-w-[38.5rem] shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-4">
        <h1 className="text-2xl font-bold tracking-tight">Jarvis thread</h1>
        {headerControl}
      </header>
      <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border">
        <div className="mx-auto w-full max-w-[38.5rem] px-4">
          <OpenItems open={open} newestDigestId={newestDigestId} targetId={target?.id ?? null} onReply={reply} />
          {/* Every unsettled decision and unanswered suggestion, as the stream draws it. */}
          {open !== undefined && open.decisions.length + open.suggestions.length > 0 && (
            <ol className="space-y-3 pb-2">
              {open.decisions.map((one) => rowOf({ type: "decision", id: one.id, at: one.at, day: newYorkDay(one.at), replies: [], decision: one }, true))}
              {open.suggestions.map((one) => rowOf({ type: "suggestion", id: one.id, at: one.at, day: newYorkDay(one.at), replies: [], suggestion: one }, true))}
            </ol>
          )}
          {/* A linked row older than the stream. */}
          {linked != null && (
            <ol className="pb-2">
              {rowOf({ type: "decision", id: linked.id, at: linked.at, day: newYorkDay(linked.at), replies: [], decision: linked })}
            </ol>
          )}
        </div>
      </div>
      {/* column-reverse keeps the newest message in view on arrival without
          any scrolling code; the list itself is in time order. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[38.5rem] px-4 pb-4">
          {loading && <p className="pt-4 text-sm text-text-faint">Loading…</p>}
          {cuts.map((cut) => <p key={cut} className="font-mono text-[11px] leading-5 text-text-faint">{cut}</p>)}
          {days.map(([day, items]) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-0 z-10 bg-bg pb-1.5 pt-4 font-mono text-xs text-text-muted">
                {dayLabel(day, today, yesterday)}
              </h2>
              <ol className="space-y-3">{items.map((item) => rowOf(item))}</ol>
            </section>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex w-full max-w-[38.5rem] items-end gap-2 px-4 py-3">
          <textarea
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (canSend) void submit();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className="max-h-40 min-w-0 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-base leading-6 text-text placeholder:text-text-faint focus:border-accent/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {failed ? "Not sent, retry" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
