"use client";

// The Jarvis thread: Tom's one standing conversation with Jarvis. It reads
// three sources merged by time — his thread messages (api.thread.messages),
// the day log (api.dayLog.page, the /log page's query) and the #dump captures
// (api.tts.listTodos, filtered to source "slack-capture") — and derives each
// reply line from what the record already holds. A message he types here is
// appended to the record's events table; a box job reads those rows and posts
// Jarvis's one-line reply back under each.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";

const ZONE = "America/New_York";
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

type Kind = "fact" | "todo" | "rule" | "errand" | "question";

type Said = {
  id: string;
  at: number;
  day: string;
  text: string;
  kind?: Kind;
  line: string;
  processed: boolean;
  needsTom: boolean;
};

type ThreadMessage = {
  id: string;
  at: number;
  text: string;
  reply: { at: number; text: string; kind: string | null } | null;
};

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

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const dueName = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric" });

const KINDS: readonly Kind[] = ["fact", "todo", "rule", "errand", "question"];

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
  const base = { id: todo._id, at: todo.createdAt, day: dayKey.format(todo.createdAt), text: todo.statement, processed: true, needsTom: false };
  // Terminal status first: needsTomToday is kept on a todo after it is done
  // or archived, so checking it first would show a finished capture as a
  // live question.
  if (todo.status === "done") return { ...base, kind: "errand", line: "a todo, done" };
  if (todo.status === "archived") return { ...base, kind: "todo", line: "a todo, archived" };
  if (todo.needsTomToday) return { ...base, kind: "question", line: todo.needsTomToday.why || "waiting for your answer", needsTom: true };
  if (todo.timingClass === "dated" && todo.dueAt !== undefined) {
    return { ...base, kind: "errand", line: `on the calendar for ${dueName.format(todo.dueAt)}` };
  }
  if (todo.readiness === "prepared") return { ...base, kind: "todo", line: "a todo, prepared" };
  return { ...base, kind: "todo", line: "waiting for a session" };
}

function fromThread(message: ThreadMessage): Said {
  const base = { id: message.id, at: message.at, day: dayKey.format(message.at), text: message.text };
  if (message.reply !== null) {
    const kind = KINDS.includes(message.reply.kind as Kind) ? (message.reply.kind as Kind) : undefined;
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
  const date = dayName.format(new Date(`${day}T12:00:00Z`));
  if (day === today) return `Today · ${date}`;
  if (day === yesterday) return `Yesterday · ${date}`;
  return date;
}

export default function ThreadClient() {
  const { isTom } = useAuth();
  const entries = useQuery(api.dayLog.page, isTom ? {} : "skip") as LogEntry[] | undefined;
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip") as Doc<"todos">[] | undefined;
  const thread = useQuery(api.thread.messages, isTom ? {} : "skip") as ThreadMessage[] | undefined;
  const days = useMemo(() => {
    const since = Date.now() - WINDOW_MS;
    const said: Said[] = [
      ...(entries ?? []).filter((e) => e.threadMessageId === undefined).map(fromLog),
      ...(todos ?? []).filter((t) => t.source === "slack-capture" && t.createdAt >= since).map(fromCapture),
      ...(thread ?? []).map(fromThread),
    ].sort((a, b) => a.at - b.at);
    const grouped = new Map<string, Said[]>();
    for (const s of said) grouped.set(s.day, [...(grouped.get(s.day) ?? []), s]);
    return [...grouped.entries()];
  }, [entries, todos, thread]);

  return (
    <TomGate label="Thread">
      <ThreadView days={days} loading={entries === undefined || todos === undefined || thread === undefined} />
    </TomGate>
  );
}

function ThreadView({ days, loading }: { days: Array<[string, Said[]]>; loading: boolean }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = useMutation(api.thread.send);
  const now = Date.now();
  const today = dayKey.format(now);
  const yesterday = dayKey.format(now - 24 * 60 * 60 * 1000);
  const canSend = draft.trim() !== "" && !sending;

  async function submit() {
    if (draft.trim() === "" || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await send({ text: draft });
      setDraft("");
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
          {days.map(([day, said]) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-0 z-10 bg-bg pb-1.5 pt-4 font-mono text-xs text-text-muted">
                {dayLabel(day, today, yesterday)}
              </h2>
              <ol className="space-y-3">
                {said.map((s) => (
                  <li key={s.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-0.5">
                    <time
                      dateTime={new Date(s.at).toISOString()}
                      className="pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-text-faint"
                    >
                      {clock.format(s.at)}
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
            placeholder="Message Jarvis"
            aria-label="Message Jarvis"
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
