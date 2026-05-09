"use client";

import { debug } from "@/app/lib/debug";

export type CallFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: Array<{ id: string; name?: string }>;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: {
    modelProvider: string | null;
    model: string | null;
    contextTokens: number | null;
  };
  sessions: Array<{
    key: string;
    spawnedBy?: string;
    spawnedWorkspaceDir?: string;
    forkedFromParent?: boolean;
    spawnDepth?: number;
    subagentRole?: string;
    subagentControlScope?: string;
    kind: "direct" | "group" | "global" | "unknown";
    label?: string;
    displayName?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
    chatType?: string;
    origin?: {
      label?: string;
      provider?: string;
      surface?: string;
      chatType?: string;
      from?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    };
    updatedAt: number | null;
    sessionId?: string;
    systemSent?: boolean;
    abortedLastRun?: boolean;
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    totalTokensFresh?: boolean;
    estimatedCostUsd?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    startedAt?: number;
    endedAt?: number;
    runtimeMs?: number;
    parentSessionKey?: string;
    childSessions?: string[];
    responseUsage?: "on" | "off" | "tokens" | "full";
    modelProvider?: string;
    model?: string;
    contextTokens?: number;
    compactionCheckpointCount?: number;
  }>;
};

export type SessionsGetResult = {
  messages: Array<Record<string, unknown>>;
};

export type SessionsMessagesSubscriptionResult = {
  subscribed: boolean;
  key: string;
};

export type ChatHistoryResult = {
  sessionKey: string;
  sessionId?: string;
  messages: Array<Record<string, unknown>>;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
};

export type ChatSendResult =
  | { runId: string; status: "started" | "in_flight" }
  | { ok: true; aborted: boolean; runIds: string[] }
  | { ok: true; messageId: string };

export type ChatAbortResult = {
  ok: true;
  aborted: boolean;
  runIds: string[];
};

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastErrorReason?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: string;
  lastDeliveryError?: string;
  lastFailureAlertAtMs?: number;
};

export type CronJob = {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: Record<string, unknown>;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  failureAlert?: false | Record<string, unknown>;
  state: CronJobState;
};

export type CronListResult = {
  jobs: CronJob[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type CronRunResult = {
  id?: string;
  runAtMs?: number;
  queued?: boolean;
  ok?: boolean;
};

export type CronRunsResult = {
  entries: Array<{
    ts: number;
    jobId: string;
    action: "finished";
    status?: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
    delivered?: boolean;
    deliveryStatus?: string;
    deliveryError?: string;
    sessionId?: string;
    sessionKey?: string;
    runAtMs?: number;
    durationMs?: number;
    nextRunAtMs?: number;
    model?: string;
    provider?: string;
    usage?: Record<string, number | undefined>;
    jobName?: string;
  }>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type AgentsFilesListResult = {
  agentId: string;
  workspace: string;
  files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
    content?: string;
  }>;
};

export type AgentsFilesGetResult = {
  agentId: string;
  workspace: string;
  file: {
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
    content?: string;
  };
};

export type SkillsStatusResult = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: Array<{
    name: string;
    description: string;
    source: string;
    bundled: boolean;
    filePath: string;
    baseDir: string;
    skillKey: string;
    always: boolean;
    disabled: boolean;
    blockedByAllowlist: boolean;
    eligible: boolean;
    requirements: Record<string, unknown>;
    missing: Record<string, unknown>;
    configChecks: Array<Record<string, unknown>>;
    install: Array<Record<string, unknown>>;
  }>;
};

export type LogsTailResult = {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated?: boolean;
  reset?: boolean;
};

export type UsageCostResult = {
  updatedAt: number;
  days: number;
  daily: Array<Record<string, unknown>>;
  totals: Record<string, unknown>;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: Array<Record<string, unknown>>;
  totals: Record<string, unknown>;
  aggregates: Record<string, unknown>;
};

export type TodayResult = {
  date: string;
  path: string;
  title: string;
  raw?: string;
  orderedSections: string[];
  sections: Record<string, string>;
};

export type TodayWriteParams = {
  date: string;
  title?: string;
  orderedSections?: string[];
  sections: Record<string, string>;
};

export type TodayWriteResult = {
  ok: true;
  path: string;
  content?: string;
};

export type TimelineEntry = {
  timeLabel: string | null;
  minutes: number | null;
  text: string;
};

export type TimelineDay = {
  date: string;
  title: string;
  path?: string;
  exists: boolean;
  timedActivities: TimelineEntry[];
  timedMeals: TimelineEntry[];
  timedSocial: TimelineEntry[];
  sections: {
    activities: string[];
    meals: string[];
    mood: string[];
    social: string[];
    substances: string[];
  };
};

export type TimelineResult = {
  center: string;
  days: TimelineDay[];
};

export type WorkspaceEntry = {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
};

export type WorkspaceListResult = {
  prefix: string;
  entries: WorkspaceEntry[];
};

export type WorkspaceReadResult = {
  path: string;
  content: string;
};

export type WorkspaceWriteResult = {
  ok: true;
  path: string;
};

export type StatusSummaryResult = {
  today?: string;
  codex?: { configured?: boolean; auth?: string | null; label?: string | null };
  anthropic?: { configured?: boolean; auth?: string | null; label?: string | null };
  providerCosts?: Record<string, unknown>;
  localUsage?: {
    today?: { estimatedCostUsd?: number; totalTokens?: number } | null;
    summary?: Record<string, unknown> | null;
  };
};

type Check = [label: string, check: (value: unknown) => boolean];

const protoLog = debug.scoped("gw.proto");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === "string";
}

function hasBoolean(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === "boolean";
}

function hasArray(value: unknown, key: string): boolean {
  return isRecord(value) && Array.isArray(value[key]);
}

function assertShape<T>(method: string, data: unknown, checks: Check[]): T {
  for (const [label, check] of checks) {
    if (!check(data)) {
      protoLog.error(`Protocol drift: ${method} -- unexpected shape for "${label}"`, {
        expected: label,
      });
    }
  }
  return data as T;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `jarvis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function health(call: CallFn, params?: { probe?: boolean }) {
  const result = await call("health", params);
  return assertShape<Record<string, unknown>>("health", result, [
    ["object response", isRecord],
    ["ok boolean", (value) => hasBoolean(value, "ok")],
  ]);
}

export async function status(call: CallFn) {
  const result = await call("status", undefined);
  return assertShape<Record<string, unknown>>("status", result, [
    ["object response", isRecord],
  ]);
}

export async function agentsList(call: CallFn) {
  const result = await call("agents.list", undefined);
  return assertShape<AgentsListResult>("agents.list", result, [
    ["defaultId string", (value) => hasString(value, "defaultId")],
    ["mainKey string", (value) => hasString(value, "mainKey")],
    ["agents array", (value) => hasArray(value, "agents")],
  ]);
}

export async function sessionsList(call: CallFn, params?: Record<string, unknown>) {
  const result = await call("sessions.list", params);
  return assertShape<SessionsListResult>("sessions.list", result, [
    ["sessions array", (value) => hasArray(value, "sessions")],
    ["count number", (value) => isRecord(value) && typeof value.count === "number"],
    ["path string", (value) => hasString(value, "path")],
  ]);
}

export async function sessionsGet(
  call: CallFn,
  sessionKey: string,
  params?: { limit?: number },
) {
  const result = await call("sessions.get", {
    sessionKey,
    ...(params ?? {}),
  });
  return assertShape<SessionsGetResult>("sessions.get", result, [
    ["messages array", (value) => hasArray(value, "messages")],
  ]);
}

export async function sessionsMessagesSubscribe(call: CallFn, key: string) {
  const result = await call("sessions.messages.subscribe", { key });
  return assertShape<SessionsMessagesSubscriptionResult>("sessions.messages.subscribe", result, [
    ["subscribed boolean", (value) => hasBoolean(value, "subscribed")],
    ["key string", (value) => hasString(value, "key")],
  ]);
}

export async function sessionsMessagesUnsubscribe(call: CallFn, key: string) {
  const result = await call("sessions.messages.unsubscribe", { key });
  return assertShape<SessionsMessagesSubscriptionResult>("sessions.messages.unsubscribe", result, [
    ["subscribed boolean", (value) => hasBoolean(value, "subscribed")],
    ["key string", (value) => hasString(value, "key")],
  ]);
}

export async function chatHistory(
  call: CallFn,
  sessionKey: string,
  params?: { limit?: number; maxChars?: number },
) {
  const result = await call("chat.history", {
    sessionKey,
    ...(params ?? {}),
  });
  return assertShape<ChatHistoryResult>("chat.history", result, [
    ["sessionKey string", (value) => hasString(value, "sessionKey")],
    ["messages array", (value) => hasArray(value, "messages")],
  ]);
}

export async function chatSend(
  call: CallFn,
  sessionKey: string,
  message: string,
  params?: Record<string, unknown>,
) {
  const result = await call("chat.send", {
    sessionKey,
    message,
    idempotencyKey:
      typeof params?.idempotencyKey === "string" && params.idempotencyKey.trim().length > 0
        ? params.idempotencyKey
        : createIdempotencyKey(),
    ...params,
  });
  return assertShape<ChatSendResult>("chat.send", result, [
    [
      "connect ack shape",
      (value) =>
        isRecord(value) &&
        (
          (typeof value.runId === "string" && typeof value.status === "string") ||
          value.ok === true
        ),
    ],
  ]);
}

export async function chatAbort(call: CallFn, sessionKey: string, runId?: string) {
  const result = await call("chat.abort", runId ? { sessionKey, runId } : { sessionKey });
  return assertShape<ChatAbortResult>("chat.abort", result, [
    ["ok true", (value) => isRecord(value) && value.ok === true],
    ["aborted boolean", (value) => hasBoolean(value, "aborted")],
    ["runIds array", (value) => hasArray(value, "runIds")],
  ]);
}

export async function cronList(call: CallFn, params?: Record<string, unknown>) {
  const result = await call("cron.list", params);
  return assertShape<CronListResult>("cron.list", result, [
    ["jobs array", (value) => hasArray(value, "jobs")],
    ["total number", (value) => isRecord(value) && typeof value.total === "number"],
    ["hasMore boolean", (value) => hasBoolean(value, "hasMore")],
  ]);
}

export async function cronRun(call: CallFn, params: Record<string, unknown>) {
  const result = await call("cron.run", params);
  return assertShape<CronRunResult>("cron.run", result, [
    ["object response", isRecord],
  ]);
}

export async function cronRuns(call: CallFn, params: Record<string, unknown>) {
  const result = await call("cron.runs", params);
  return assertShape<CronRunsResult>("cron.runs", result, [
    ["entries array", (value) => hasArray(value, "entries")],
    ["total number", (value) => isRecord(value) && typeof value.total === "number"],
  ]);
}

export async function cronUpdate(
  call: CallFn,
  id: string,
  patch: Record<string, unknown>,
) {
  const result = await call("cron.update", { id, patch });
  return assertShape<CronJob>("cron.update", result, [
    ["id string", (value) => hasString(value, "id")],
    ["enabled boolean", (value) => hasBoolean(value, "enabled")],
    ["state object", (value) => isRecord(value) && isRecord(value.state)],
  ]);
}

export async function agentsFilesList(call: CallFn, agentId: string) {
  const result = await call("agents.files.list", { agentId });
  return assertShape<AgentsFilesListResult>("agents.files.list", result, [
    ["agentId string", (value) => hasString(value, "agentId")],
    ["files array", (value) => hasArray(value, "files")],
    ["workspace string", (value) => hasString(value, "workspace")],
  ]);
}

export async function agentsFilesGet(call: CallFn, agentId: string, name: string) {
  const result = await call("agents.files.get", { agentId, name });
  return assertShape<AgentsFilesGetResult>("agents.files.get", result, [
    ["agentId string", (value) => hasString(value, "agentId")],
    ["file object", (value) => isRecord(value) && isRecord(value.file)],
    ["workspace string", (value) => hasString(value, "workspace")],
  ]);
}

export async function skillsStatus(call: CallFn, agentId?: string) {
  const result = await call("skills.status", agentId ? { agentId } : undefined);
  return assertShape<SkillsStatusResult>("skills.status", result, [
    ["skills array", (value) => hasArray(value, "skills")],
    ["workspaceDir string", (value) => hasString(value, "workspaceDir")],
    ["managedSkillsDir string", (value) => hasString(value, "managedSkillsDir")],
  ]);
}

export async function logsTail(call: CallFn, params?: Record<string, unknown>) {
  const result = await call("logs.tail", params);
  return assertShape<LogsTailResult>("logs.tail", result, [
    ["file string", (value) => hasString(value, "file")],
    ["lines array", (value) => hasArray(value, "lines")],
    ["cursor number", (value) => isRecord(value) && typeof value.cursor === "number"],
  ]);
}

export async function usageCost(call: CallFn, params?: Record<string, unknown>) {
  const result = await call("usage.cost", params);
  return assertShape<UsageCostResult>("usage.cost", result, [
    ["daily array", (value) => hasArray(value, "daily")],
    ["totals object", (value) => isRecord(value) && isRecord(value.totals)],
    ["days number", (value) => isRecord(value) && typeof value.days === "number"],
  ]);
}

export async function sessionsUsage(call: CallFn, params?: Record<string, unknown>) {
  const result = await call("sessions.usage", params);
  return assertShape<SessionsUsageResult>("sessions.usage", result, [
    ["sessions array", (value) => hasArray(value, "sessions")],
    ["totals object", (value) => isRecord(value) && isRecord(value.totals)],
    ["aggregates object", (value) => isRecord(value) && isRecord(value.aggregates)],
  ]);
}

export async function todayRead(call: CallFn, params?: { date?: string }) {
  const result = await call("today.read", params);
  return assertShape<TodayResult>("today.read", result, [
    ["date string", (value) => hasString(value, "date")],
    ["path string", (value) => hasString(value, "path")],
    ["orderedSections array", (value) => hasArray(value, "orderedSections")],
    ["sections object", (value) => isRecord(value) && isRecord(value.sections)],
  ]);
}

export async function todayWrite(call: CallFn, params: TodayWriteParams) {
  const result = await call("today.write", params);
  return assertShape<TodayWriteResult>("today.write", result, [
    ["ok true", (value) => isRecord(value) && value.ok === true],
    ["path string", (value) => hasString(value, "path")],
  ]);
}

export async function timelineRead(call: CallFn, params?: { center?: string; days?: number }) {
  const result = await call("timeline.read", params);
  return assertShape<TimelineResult>("timeline.read", result, [
    ["center string", (value) => hasString(value, "center")],
    ["days array", (value) => hasArray(value, "days")],
  ]);
}

export async function workspaceList(call: CallFn, prefix: string) {
  const result = await call("workspace.list", { prefix });
  return assertShape<WorkspaceListResult>("workspace.list", result, [
    ["prefix string", (value) => hasString(value, "prefix")],
    ["entries array", (value) => hasArray(value, "entries")],
  ]);
}

export async function workspaceRead(call: CallFn, path: string) {
  const result = await call("workspace.read", { path });
  return assertShape<WorkspaceReadResult>("workspace.read", result, [
    ["path string", (value) => hasString(value, "path")],
    ["content string", (value) => hasString(value, "content")],
  ]);
}

export async function workspaceWrite(call: CallFn, path: string, content: string) {
  const result = await call("workspace.write", { path, content });
  return assertShape<WorkspaceWriteResult>("workspace.write", result, [
    ["ok true", (value) => isRecord(value) && value.ok === true],
    ["path string", (value) => hasString(value, "path")],
  ]);
}

export async function statusSummary(call: CallFn) {
  const result = await call("status.summary", undefined);
  return assertShape<StatusSummaryResult>("status.summary", result, [
    ["object response", isRecord],
  ]);
}
