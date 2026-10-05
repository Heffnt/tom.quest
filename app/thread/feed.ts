// The thread's stream by New York day. A message Tom typed under a row is
// nested beneath it; one whose row is not in the stream is a line of its own.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { displayDay, newYorkDay } from "@/shared/clock.mjs";
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export type ThreadMessage = FunctionReturnType<typeof api.thread.messages>["entries"][number];
export type AgentChange = FunctionReturnType<typeof api.thread.changes>["entries"][number];
export type OpenItems = FunctionReturnType<typeof api.thread.open>;

export type Kind = Exclude<Extract<ThreadMessage, { kind: "message" }>["reply"], null | { cut: true }>["kind"];

export type Said = {
  id: string;
  at: number;
  day: string;
  text: string;
  kind?: Kind;
  line: string;
  processed: boolean;
  needsTom: boolean;
};

type Row<T extends string, K extends string, V> = { type: T; id: string; at: number; day: string; replies: Said[] } & Record<K, V>;

export type FeedItem =
  | Row<"said", "said", Said>
  | Row<"digest", "digest", Extract<ThreadMessage, { kind: "digest" }>>
  | Row<"item", "item", Extract<ThreadMessage, { kind: "item" }>>
  | Row<"alarm", "alarm", Extract<ThreadMessage, { kind: "alarm" }>>
  | Row<"decision", "decision", Extract<ThreadMessage, { kind: "decision" }>>
  | Row<"suggestion", "suggestion", Extract<ThreadMessage, { kind: "suggestion" }>>
  | Row<"check", "check", Extract<ThreadMessage, { kind: "check" }>>
  | Row<"diagnosis", "diagnosis", Extract<ThreadMessage, { kind: "diagnosis" }>>
  | Row<"change", "change", AgentChange>;

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

export type LogEntry = {
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
  // Terminal status first: needsTomToday stays on a done or archived todo.
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
  const base = { id: message.id, at: message.at, day: newYorkDay(message.at), text: message.text ?? "" };
  if (message.reply !== null && !("cut" in message.reply)) {
    return {
      ...base,
      ...(message.reply.kind === null ? {} : { kind: message.reply.kind }),
      line: message.reply.text ?? "",
      processed: true,
      needsTom: message.reply.kind === "question",
    };
  }
  // Only a message with no subject waits on the box's thread-reply job; a
  // cut reply is unknown, not waiting.
  return message.subject === null && message.reply === null
    ? { ...base, line: "not processed yet", processed: false, needsTom: false }
    : { ...base, line: "", processed: true, needsTom: false };
}

/** The stream's days, oldest first, each with its rows oldest first. */
export function buildDays(
  entries: LogEntry[],
  todos: Doc<"todos">[],
  messages: ThreadMessage[],
  changes: AgentChange[],
  now = Date.now(),
): Array<[string, FeedItem[]]> {
  const since = now - WINDOW_MS;
  const rows: FeedItem[] = [];
  const add = <T extends FeedItem["type"]>(type: T, id: string, at: number, day: string, key: T, value: unknown) =>
    rows.push({ type, id, at, day, replies: [], [key]: value } as unknown as FeedItem);
  for (const entry of entries) if (entry.threadMessageId === undefined) add("said", entry._id, entry.createdAt, entry.day, "said", fromLog(entry));
  for (const todo of todos) {
    if (todo.threadMessageId !== undefined || todo.source !== "slack-capture" || todo.createdAt < since) continue;
    const said = fromCapture(todo);
    add("said", said.id, said.at, said.day, "said", said);
  }
  const nested: Array<{ subject: string; said: Said }> = [];
  for (const message of messages) {
    const day = newYorkDay(message.at);
    switch (message.kind) {
      case "message": {
        const said = fromThread(message);
        if (message.subject === null) add("said", said.id, said.at, said.day, "said", said);
        else nested.push({ subject: message.subject, said });
        break;
      }
      case "digest": add("digest", message.id, message.at, message.day, "digest", message); break;
      case "item": add("item", message.id, message.at, message.day, "item", message); break;
      case "alarm": add("alarm", message.id, message.at, day, "alarm", message); break;
      case "decision": add("decision", message.id, message.at, day, "decision", message); break;
      case "suggestion": add("suggestion", message.id, message.at, day, "suggestion", message); break;
      case "check": add("check", message.id, message.at, day, "check", message); break;
      case "diagnosis": add("diagnosis", message.id, message.at, day, "diagnosis", message); break;
    }
  }
  for (const change of changes) add("change", change.id, change.at, newYorkDay(change.at), "change", change);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { subject, said } of nested.sort((a, b) => a.said.at - b.said.at)) {
    const row = byId.get(subject);
    if (row !== undefined) row.replies.push(said);
    else rows.push({ type: "said", id: said.id, at: said.at, day: said.day, replies: [], said });
  }
  rows.sort((a, b) => a.at - b.at);
  const grouped = new Map<string, FeedItem[]>();
  for (const row of rows) grouped.set(row.day, [...(grouped.get(row.day) ?? []), row]);
  return [...grouped.entries()];
}
