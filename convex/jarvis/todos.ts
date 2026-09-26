// todos.ts — what the box writes about todos, rulings, sessions and time
// notes, as events. Each was a pen of its own under /tts/ (capture,
// prepare-todo, session-outcome, ruling-applied, apply-time-note); each is now
// a kind posted to POST /jarvis/event whose hook here does what the pen did,
// inside the record mutation, so a refused write leaves no event and an
// accepted one leaves exactly one.
//
//   todo-captured      data { statement, source?, provenance?, slackChannel?,
//                      slackTs?, needsTomToday?, why? } -> creates the todo;
//                      the event's subject becomes its id; answers { todoId }.
//   todo-prepared      subject: the todo; data { brief?, entryAction?,
//                      workDescription?, readiness?, dueAt?, dateKind?,
//                      evidence?, groundUpExplanation?, status?, agentToken?,
//                      doorFaults? } -> the write-up lands on the todo.
//   session-ended      subject: the session; data { outcome, summary? } ->
//                      the outcome lands on the session (and its todo).
//   ruling-applied     subject: the ruling; data { result } -> the ruling is
//                      consumed.
//   time-note-applied  subject: the time note; data { status, result,
//                      actions? } -> the note's actions land and it resolves.
//
// The checks each pen made on its body are here, once; the old /tts/ routes
// post the same event (convex/http.ts), until the box's last caller spells
// POST /jarvis/event.

import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { v, type Infer } from "convex/values";
import { applyTimeNote, captureTodo, prepareTodo, TIME_NOTE_ACTION } from "../tts";
import { recordSessionOutcome } from "../claudeSessions";
import { markRulingApplied } from "../ttsRulings";
import { redactSecrets } from "../../shared/redact.mjs";
import { checkValue } from "./checkValue";

const dataOf = (row: Doc<"events">): Record<string, unknown> =>
  typeof row.data === "object" && row.data !== null && !Array.isArray(row.data)
    ? (row.data as Record<string, unknown>)
    : {};
const str = (x: unknown) => (typeof x === "string" ? x : undefined);

function subjectOf(row: Doc<"events">, what: string): string {
  if (typeof row.subject !== "string" || row.subject === "") throw new Error(`subject (the ${what}'s id) required`);
  return row.subject;
}

/** The first run-spelled key the body carries, as the refusal naming it. */
function oldSpelling(b: Record<string, unknown>, keys: Record<string, string>): string | null {
  for (const [old, replacement] of Object.entries(keys)) {
    if (b[old] !== undefined) return `${old} is no longer read; send ${replacement}`;
  }
  return null;
}

export async function onTodoCaptured(ctx: MutationCtx, row: Doc<"events">): Promise<{ todoId: string }> {
  const b = dataOf(row);
  if (typeof b.statement !== "string" || b.statement.trim().length === 0) {
    throw new Error("statement (non-empty string) required");
  }
  const todoId = await captureTodo(ctx, {
    statement: b.statement,
    source: typeof b.source === "string" && b.source ? b.source : "slack-capture",
    provenance: str(b.provenance),
    // The Slack coordinates, when the caller is a Slack producer: what the
    // threaded reply is addressed to and what the push route dedupes on.
    slackChannel: str(b.slackChannel),
    slackTs: str(b.slackTs),
    needsTomToday: b.needsTomToday === true ? { why: typeof b.why === "string" ? b.why.trim() : "" } : undefined,
  });
  // The event is about the todo it made; its subject says which.
  await ctx.db.patch(row._id, { subject: todoId });
  return { todoId };
}

// A door fault is a sentence the preparer's check wrote about a refused
// write-up; bounded, and redacted like everything that reaches Slack.
const DOOR_FAULT_MAX_CHARS = 300;
const DOOR_FAULTS_MAX = 10;

function doorFaultsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("doorFaults must be an array of strings");
  }
  return (value as string[]).slice(0, DOOR_FAULTS_MAX).map((item) => redactSecrets(item).slice(0, DOOR_FAULT_MAX_CHARS));
}

export async function onTodoPrepared(ctx: MutationCtx, row: Doc<"events">): Promise<{ todoId: string }> {
  const id = subjectOf(row, "todo");
  const b = dataOf(row);
  // "prepared" is the one value; an agent never erases a write-up.
  if (b.readiness !== undefined && b.readiness !== "prepared") throw new Error('readiness must be "prepared"');
  if (b.dateKind !== undefined && b.dateKind !== "external" && b.dateKind !== "self-imposed") {
    throw new Error('dateKind must be "external" or "self-imposed"');
  }
  if (b.dueAt !== undefined && typeof b.dueAt !== "number") throw new Error("dueAt must be a number (epoch ms)");
  // "done" only, with the todo's evidence, on a row Tom has not ruled on:
  // prepareTodo is the real gate and refuses by name.
  if (b.status !== undefined && b.status !== "done") throw new Error('status must be "done"');
  const oldToken = oldSpelling(b, { runToken: "agentToken" });
  if (oldToken) throw new Error(oldToken);
  // The run that wrote this write-up, so a ruling on it finds that run. A
  // write that carries no token stores none: it is never inferred.
  if (b.agentToken !== undefined && (typeof b.agentToken !== "string" || b.agentToken === "")) {
    throw new Error("agentToken, when given, is a non-empty string");
  }
  await prepareTodo(ctx, {
    id,
    brief: str(b.brief),
    entryAction: str(b.entryAction),
    workDescription: str(b.workDescription),
    readiness: b.readiness as "prepared" | undefined,
    dueAt: b.dueAt as number | undefined,
    dateKind: b.dateKind as "external" | "self-imposed" | undefined,
    evidence: str(b.evidence),
    groundUpExplanation: str(b.groundUpExplanation),
    status: b.status as "done" | undefined,
    runToken: str(b.agentToken),
    doorFaults: doorFaultsOf(b.doorFaults),
  });
  return { todoId: id };
}

export async function onSessionEnded(ctx: MutationCtx, row: Doc<"events">): Promise<Record<string, never>> {
  const id = subjectOf(row, "session");
  const b = dataOf(row);
  if (b.outcome !== "completed" && b.outcome !== "errored") throw new Error('outcome must be "completed" or "errored"');
  await recordSessionOutcome(ctx, { id, outcome: b.outcome, summary: typeof b.summary === "string" ? b.summary : "" });
  return {};
}

export async function onRulingApplied(ctx: MutationCtx, row: Doc<"events">): Promise<Record<string, never>> {
  const id = subjectOf(row, "ruling");
  const b = dataOf(row);
  if (typeof b.result !== "string" || b.result.length === 0) throw new Error("result (non-empty string) required");
  await markRulingApplied(ctx, { id, result: b.result });
  return {};
}

// One note is one sentence; ten actions is already far past what one
// sentence asks for.
export const TIME_NOTE_ACTIONS_MAX = 10;
const TIME_NOTE_ACTIONS = v.array(TIME_NOTE_ACTION);

/** The retired sleep vocabulary, named rather than left to the validator's
 *  answer, so a job still emitting it reads which spelling it was. */
function retiredTimeNoteAction(actions: unknown): string | null {
  if (!Array.isArray(actions)) return null;
  for (const action of actions) {
    if (typeof action !== "object" || action === null) continue;
    const a = action as Record<string, unknown>;
    if (a.kind === "set-latest-safe" || a.kind === "clear-latest-safe") {
      return `${a.kind} is retired — a sleep is a wake time (set-waiting with wakeAt)`;
    }
    if (a.kind === "set-waiting" && a.wakeCondition !== undefined) {
      return "set-waiting.wakeCondition is retired — what a row waits for goes in its statement";
    }
  }
  return null;
}

export async function onTimeNoteApplied(ctx: MutationCtx, row: Doc<"events">): Promise<unknown> {
  const id = subjectOf(row, "time note");
  const b = dataOf(row);
  if (b.status !== "applied" && b.status !== "needs-session") {
    throw new Error('status must be "applied" or "needs-session"');
  }
  if (typeof b.result !== "string" || b.result.trim().length === 0) throw new Error("result (non-empty string) required");
  if (Array.isArray(b.actions) && b.actions.length > TIME_NOTE_ACTIONS_MAX) {
    throw new Error(`at most ${TIME_NOTE_ACTIONS_MAX} actions per time note — got ${b.actions.length}`);
  }
  const retired = retiredTimeNoteAction(b.actions);
  if (retired) throw new Error(retired);
  // The actions pass as written, checked by the validator applyTimeNote's
  // own mutation declares: no projection that could land a half-understood
  // action as a different, legal one.
  if (b.actions !== undefined) {
    const fault = checkValue(TIME_NOTE_ACTIONS, b.actions, "actions");
    if (fault !== null) throw new Error(fault);
  }
  return await applyTimeNote(ctx, {
    id,
    status: b.status,
    result: b.result,
    actions: b.actions as Infer<typeof TIME_NOTE_ACTIONS> | undefined,
  });
}
