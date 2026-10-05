"use client";

// The Jarvis thread: Tom's one standing conversation with Jarvis. It reads
// four sources merged by time — his messages, Jarvis's daily digests and the
// silence alarm's lines (api.thread.messages), Jarvis's changes
// (api.thread.changes), the day log (api.dayLog.page, the /log page's query)
// and the #dump captures (api.tts.listTodos, filtered to source
// "slack-capture"). A message he types is appended to the events table;
// replies to changes appear under the change, replies to digests are nested
// under the digest, and a box job answers ordinary messages.

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import { addDays, displayDay, displayDayKey, displayTime, newYorkDay } from "@/shared/clock.mjs";
import type { THREAD_REPLY_KINDS } from "@/shared/jarvis-events.mjs";
import { slackSegments } from "./digest-text";

const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

type Reply = { at: number; text: string; kind: (typeof THREAD_REPLY_KINDS)[number] | null } | null;

type Said = {
  id: string;
  at: number;
  day: string;
  text: string;
  kind?: (typeof THREAD_REPLY_KINDS)[number];
  line: string;
  processed: boolean;
  needsTom: boolean;
};

type ThreadMessage =
  | { kind: "message"; id: Id<"events">; at: number; text: string;
      subject: Id<"events"> | null; reply: Reply }
  | { kind: "digest"; id: Id<"events">; at: number; day: string; text: string;
      items: Array<{ n: number; text: string }>;
      replies: Array<{ id: Id<"events">; at: number; text: string; reply: Reply }> }
  | { kind: "item"; id: Id<"events">; at: number; digestId: Id<"events">;
      day: string; n: number; text: string }
  | { kind: "alarm"; id: Id<"events">; at: number; text: string; href: string };

type DigestEntry = Extract<ThreadMessage, { kind: "digest" }>;
type NeedsYouEntry = Extract<ThreadMessage, { kind: "item" }>;
type AlarmEntry = Extract<ThreadMessage, { kind: "alarm" }>;

type AgentChange = {
  id: Id<"events">;
  at: number;
  kind: "merge" | "deploy" | "learning-change" | "repo-proposal-applied";
  line: string;
  href: string | null;
};

type FeedItem =
  | { type: "said"; id: string; at: number; day: string; said: Said }
  | { type: "digest"; id: string; at: number; day: string; digest: DigestEntry }
  | { type: "item"; id: string; at: number; day: string; item: NeedsYouEntry }
  | { type: "alarm"; id: string; at: number; day: string; alarm: AlarmEntry }
  | { type: "change"; id: string; at: number; day: string; change: AgentChange; replies: Said[] };

type ReplyTarget =
  | { kind: "change"; id: Id<"events"> }
  | { kind: "digest"; id: Id<"events">; day: string };

type LogItem = {
  _id: string;
  type: "measurement" | "workout" | "food" | "feeling" | "symptom" | "work";
  summary: string;
  metric?: string;
  value?: number;
  unit?: string;
  activity?: string;
  distanceMi?: number;
  durationMin?: number;
};

type LogEntry = {
  _id: string;
  day: string;
  text: string;
  createdAt: number;
  status: "pending" | "applied" | "needs-session";
  threadMessageId?: string;
  items: LogItem[];
};


function words(value: string): string {
  return value.replaceAll("_", " ");
}

function fact(item: LogItem): string {
  if (item.type === "measurement" && item.metric !== undefined && item.value !== undefined) {
    return `${words(item.metric)} ${item.value.toFixed(1)}${item.unit ? ` ${item.unit}` : ""}`;
  }
  if (item.type === "workout" && item.activity !== undefined) {
    const detail = item.distanceMi !== undefined
      ? ` ${item.distanceMi.toFixed(1)} mi`
      : item.durationMin !== undefined ? ` ${item.durationMin.toFixed(0)} min` : "";
    return `${words(item.activity)}${detail}`;
  }
  return item.summary;
}

function fromLog(entry: LogEntry): Said {
  const base = { id: entry._id, at: entry.createdAt, day: entry.day, text: entry.text, needsTom: false };
  if (entry.status === "pending") return { ...base, line: "not processed yet", processed: false };
  if (entry.status === "needs-session") return { ...base, kind: "todo", line: "waiting for a session", processed: true };
  if (entry.items.length === 0) return { ...base, line: "nothing to record", processed: true };
  const head = entry.items.length === 1 ? "recorded as a fact about your day" : `recorded as ${entry.items.length} facts about your day`;
  return { ...base, kind: "fact", line: `${head}: ${entry.items.map(fact).join(" · ")}`, processed: true };
}

function fromCapture(todo: Doc<"todos">): Said {
  const base = { id: todo._id, at: todo.createdAt, day: newYorkDay(todo.createdAt), text: todo.statement, processed: true, needsTom: false };
  // Terminal status first: needsTomToday is kept on a todo after it is done
  // or archived, so checking it first would show a finished capture as a
  // live question.
  if (todo.status === "done") return { ...base, kind: "errand", line: "a todo, done" };
  if (todo.status === "archived") return { ...base, kind: "todo", line: "a todo, archived" };
  if (todo.needsTomToday) return { ...base, kind: "question", line: todo.needsTomToday.why || "waiting for your answer", needsTom: true };
  if (todo.timingClass === "dated" && todo.dueAt !== undefined) {
    return { ...base, kind: "errand", line: `on the calendar for ${displayDay(todo.dueAt)}` };
  }
  if (todo.readiness === "prepared") return { ...base, kind: "todo", line: "a todo, prepared" };
  return { ...base, kind: "todo", line: "waiting for a session" };
}

function fromThread(message: Extract<ThreadMessage, { kind: "message" }>): Said {
  const base = { id: message.id, at: message.at, day: newYorkDay(message.at), text: message.text };
  if (message.reply !== null) {
    const kind = message.reply.kind as (typeof THREAD_REPLY_KINDS)[number];
    return {
      ...base,
      kind,
      line: message.reply.text,
      processed: true,
      needsTom: message.reply.kind === "question",
    };
  }
  return { ...base, line: "not processed yet", processed: false, needsTom: false };
}

function dayLabel(day: string, today: string, yesterday: string): string {
  const date = displayDayKey(day);
  if (day === today) return `Today · ${date}`;
  if (day === yesterday) return `Yesterday · ${date}`;
  return date;
}

export default function ThreadClient() {
  const { isTom } = useAuth();
  const entries = useQuery(api.dayLog.page, isTom ? {} : "skip") as LogEntry[] | undefined;
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip") as Doc<"todos">[] | undefined;
  const page = useQuery(api.thread.messages, isTom ? {} : "skip") as { entries: ThreadMessage[]; cuts: string[] } | undefined;
  const messages = page?.entries;
  const changes = useQuery(api.thread.changes, isTom ? {} : "skip") as AgentChange[] | undefined;
  const days = useMemo(() => {
    const since = Date.now() - WINDOW_MS;
    const said: Said[] = [
      ...(entries ?? []).filter((e) => e.threadMessageId === undefined).map(fromLog),
      ...(todos ?? []).filter((t) => t.threadMessageId === undefined && t.source === "slack-capture" && t.createdAt >= since).map(fromCapture),
      ...(messages ?? []).flatMap((message) =>
        message.kind === "message" && message.subject === null ? [fromThread(message)] : []),
    ];
    const replies = new Map<string, Said[]>();
    for (const message of messages ?? []) {
      if (message.kind !== "message" || message.subject === null) continue;
      const reply = fromThread(message);
      replies.set(message.subject, [...(replies.get(message.subject) ?? []), reply]);
    }
    const feed: FeedItem[] = [
      ...said.map((s): FeedItem => ({ type: "said", id: s.id, at: s.at, day: s.day, said: s })),
      ...(messages ?? []).flatMap((message): FeedItem[] => message.kind === "digest" ? [{
        type: "digest",
        id: message.id,
        at: message.at,
        day: message.day,
        digest: message,
      }] : message.kind === "item" ? [{
        type: "item",
        id: message.id,
        at: message.at,
        day: message.day,
        item: message,
      }] : message.kind === "alarm" ? [{
        type: "alarm",
        id: message.id,
        at: message.at,
        day: newYorkDay(message.at),
        alarm: message,
      }] : []),
      ...(changes ?? []).map((change): FeedItem => ({
        type: "change",
        id: change.id,
        at: change.at,
        day: newYorkDay(change.at),
        change,
        replies: (replies.get(change.id) ?? []).sort((a, b) => a.at - b.at),
      })),
    ].sort((a, b) => a.at - b.at);
    const grouped = new Map<string, FeedItem[]>();
    for (const item of feed) grouped.set(item.day, [...(grouped.get(item.day) ?? []), item]);
    return [...grouped.entries()];
  }, [changes, entries, messages, todos]);

  return (
    <TomGate label="Thread">
      <ThreadView
        days={days}
        loading={entries === undefined || todos === undefined || messages === undefined || changes === undefined}
        cuts={page?.cuts ?? []}
      />
    </TomGate>
  );
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

function DigestRow({ digest, replying, onReply }: { digest: DigestEntry; replying: boolean; onReply: () => void }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <time dateTime={new Date(digest.at).toISOString()} className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint">
        {displayTime(digest.at)}
      </time>
      <div className="min-w-0">
        <p className="font-mono text-[11px] leading-5 text-text-faint">Jarvis · digest</p>
        <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text">
          <SlackText text={digest.text} />
        </p>
        {digest.items.length > 0 && (
          <ol className="mt-2 space-y-1 pl-3">
            {digest.items.map((item) => (
              <li key={item.n} className="flex gap-1 text-sm leading-5 text-text-muted">
                <span className="shrink-0 font-mono text-[11px] text-text-faint">{item.n} ·</span>
                <span className="whitespace-pre-wrap break-words"><SlackText text={item.text} /></span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {digest.replies.map((reply) => {
        const needsTom = reply.reply?.kind === "question";
        return (
          <div key={reply.id} className="contents">
            <time dateTime={new Date(reply.at).toISOString()} className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint">
              {displayTime(reply.at)}
            </time>
            <p className="whitespace-pre-wrap break-words border-l-2 border-accent/60 pl-3 text-[15px] leading-6 text-text">{reply.text}</p>
            <span className={`font-mono text-[11px] leading-5 ${needsTom ? "text-accent" : "text-text-faint"}`}>
              {reply.reply?.kind ?? ""}
            </span>
            <p className={`break-words pl-3.5 text-sm leading-5 ${needsTom ? "text-text" : reply.reply ? "text-text-muted" : "text-text-faint"}`}>
              {reply.reply?.text ?? "not processed yet"}
            </p>
          </div>
        );
      })}
      <span />
      <div className="flex justify-end pt-1">
        <button
          type="button"
          aria-pressed={replying}
          onClick={onReply}
          className={`w-20 rounded-md border px-2 py-1 text-xs hover:bg-surface-alt hover:text-text ${replying ? "border-accent/60 bg-surface-alt text-text" : "border-border text-text-muted"}`}
        >
          {replying ? "Replying" : "Reply"}
        </button>
      </div>
    </li>
  );
}

function NeedsYouRow({ item, replying, onReply }: { item: NeedsYouEntry; replying: boolean; onReply: () => void }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <time dateTime={new Date(item.at).toISOString()} className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint">{displayTime(item.at)}</time>
      <div className="min-w-0">
        <p className="font-mono text-[11px] leading-5 text-text-faint">Jarvis · needs you</p>
        <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text">
          <span className="mr-1 font-mono text-[11px] text-text-faint">{item.n} ·</span><SlackText text={item.text} />
        </p>
      </div>
      <span />
      <div className="flex justify-end pt-1">
        <button
          type="button" aria-pressed={replying} onClick={onReply}
          className={`w-20 rounded-md border px-2 py-1 text-xs hover:bg-surface-alt hover:text-text ${replying ? "border-accent/60 bg-surface-alt text-text" : "border-border text-text-muted"}`}
        >
          {replying ? "Replying" : "Reply"}
        </button>
      </div>
    </li>
  );
}

function AlarmRow({ alarm }: { alarm: AlarmEntry }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <time dateTime={new Date(alarm.at).toISOString()} className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint">{displayTime(alarm.at)}</time>
      <div className="min-w-0">
        <p className="font-mono text-[11px] leading-5 text-text-faint">Jarvis · silence alarm</p>
        <p className="break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text">
          {alarm.text}
          <a href={alarm.href} className="ml-2 underline underline-offset-2 transition-colors hover:text-accent">agents</a>
        </p>
      </div>
    </li>
  );
}

function ThreadView({ days, loading, cuts }: { days: Array<[string, FeedItem[]]>; loading: boolean; cuts: string[] }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const send = useMutation(api.thread.send);
  const now = Date.now();
  const today = newYorkDay(now);
  const yesterday = addDays(today, -1);
  const canSend = draft.trim() !== "" && !sending;
  const composerLabel = target === null
    ? "Message Jarvis"
    : target.kind === "digest" ? `Reply to the ${target.day} digest` : "Reply to Jarvis";

  async function submit() {
    if (draft.trim() === "" || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await send({ text: draft, ...(target === null ? {} : { subject: target.id }) });
      setDraft("");
      setTarget(null);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] w-full flex-col">
      {/* column-reverse keeps the newest message in view on arrival without
          any scrolling code; the list itself is in time order. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[38.5rem] px-4 pb-4">
          <h1 className="pb-2 pt-4 text-2xl font-bold tracking-tight">Jarvis thread</h1>
          {loading && <p className="text-sm text-text-faint">Loading…</p>}
          {cuts.map((cut) => <p key={cut} className="font-mono text-[11px] leading-5 text-text-faint">{cut}</p>)}
          {days.map(([day, items]) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-0 z-10 bg-bg pb-1.5 pt-4 font-mono text-xs text-text-muted">
                {dayLabel(day, today, yesterday)}
              </h2>
              <ol className="space-y-3">
                {items.map((item) => item.type === "said" ? (
                  <MessageRow key={item.id} message={item.said} />
                ) : item.type === "digest" ? (
                  <DigestRow
                    key={item.id}
                    digest={item.digest}
                    replying={target?.id === item.id}
                    onReply={() => setTarget(target?.id === item.id
                      ? null
                      : { kind: "digest", id: item.digest.id, day: item.day })}
                  />
                ) : item.type === "alarm" ? (
                  <AlarmRow key={item.id} alarm={item.alarm} />
                ) : item.type === "item" ? (
                  <NeedsYouRow
                    key={item.id}
                    item={item.item}
                    replying={target?.id === item.item.digestId}
                    onReply={() => setTarget(target?.id === item.item.digestId
                      ? null
                      : { kind: "digest", id: item.item.digestId, day: item.day })}
                  />
                ) : (
                  <Fragment key={item.id}>
                    <ChangeRow
                      change={item.change}
                      onReply={() => setTarget(target?.id === item.id
                        ? null
                        : { kind: "change", id: item.change.id })}
                    />
                    {item.replies.map((reply) => <MessageRow key={reply.id} message={reply} />)}
                  </Fragment>
                ))}
              </ol>
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
            placeholder={composerLabel}
            aria-label={composerLabel}
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

function MessageRow({ message: s }: { message: Said }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <time
        dateTime={new Date(s.at).toISOString()}
        className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint"
      >
        {displayTime(s.at)}
      </time>
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

function ChangeRow({ change, onReply }: { change: AgentChange; onReply: () => void }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
      <time
        dateTime={new Date(change.at).toISOString()}
        className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint"
      >
        {displayTime(change.at)}
      </time>
      <p className="break-words border-l-2 border-border pl-3 text-[15px] leading-6 text-text-muted">
        {change.line}
        {change.href !== null && (
          <a
            href={change.href}
            target="_blank"
            rel="noreferrer"
            className="ml-2 underline underline-offset-2 transition-colors hover:text-text"
          >
            diff
          </a>
        )}
      </p>
      <span className="font-mono text-[11px] leading-5 text-text-faint">jarvis</span>
      <div className="pl-3">
        <button
          type="button"
          onClick={onReply}
          className="rounded px-1 py-0.5 text-xs leading-4 text-text-muted underline underline-offset-2 transition-colors hover:bg-surface hover:text-text"
        >
          Reply
        </button>
      </div>
    </li>
  );
}
