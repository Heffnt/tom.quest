import { TTS_BATCHES_LINK, nyHhmm, ttsSessionLink } from "./ttsShared";

// The hourly update's TEXT. Pure: no server imports, so convex/ttsSync.ts (a
// "use node" file) and the tests can both call composeHourlyUpdate with facts
// read by convex/ttsHourly.ts.
//
// Nothing here knows about Slack. The message's subject, the record of the
// send and the record of a refusal all belong to the one door in
// convex/ttsSync.ts and its bookkeeping in convex/ttsSlack.ts — this file
// only turns facts into lines.

export type RunningSession = {
  sessionId: string;
  title: string;
  kind: string;
  mode: string;
  status: string;
  statement: string | null; // the todo or batch it is on
  batchId: string | null;
  elapsedMs: number;
};

export type BatchWorked = {
  batchId: string;
  statement: string;
  sessions: number;
  workerEvents: number;
};

export type ChangeKind =
  | "captured"
  | "done"
  | "archived"
  | "ruling"
  | "date-outcome"
  | "failure";

export type Change = {
  kind: ChangeKind;
  at: number;
  text: string; // the todo's statement, the session's title, or the failure
  detail: string | null; // verdict, outcome, source, error
  link: string | null;
};

// ── Composition ─────────────────────────────────────────────────────────────

export function elapsedText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

// Slack mrkdwn: these three are the characters a link label or a statement
// must not carry raw.
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linked(text: string, link: string | null): string {
  return link === null ? slackEscape(text) : `<${link}|${slackEscape(text)}>`;
}

export type HourlyFacts = {
  now: number;
  since: number;
  running: RunningSession[];
  batches: BatchWorked[];
  changes: Change[];
};

const CHANGE_LABEL: Record<ChangeKind, string> = {
  captured: "captured",
  done: "done",
  archived: "archived",
  ruling: "ruling",
  "date-outcome": "date outcome",
  failure: "failure",
};

/** The one-line form: nothing running, no batch worked, nothing changed. */
export function hourlyHeartbeatLine(now: number, since: number): string {
  return `${nyHhmm(now)} — nothing running, nothing changed since ${nyHhmm(since)}.`;
}

export function isQuietHour(f: HourlyFacts): boolean {
  return f.running.length === 0 && f.batches.length === 0 && f.changes.length === 0;
}

// Slack refuses a message over 40 kB. A window is normally an hour, but a
// missed cron or a run of rejected posts makes it a day or a week, and an
// uncapped section then grows until the send itself fails — which lengthens
// the NEXT window, so the message never gets through again. Each section lists
// this many items and ends with a line saying how many it left out; the page
// has all of them.
export const MAX_LINES_PER_SECTION = 40;

/** The section's items as lines, capped, with a "+N more" tail when capped. */
function listCapped<T>(lines: string[], items: T[], render: (item: T) => string): void {
  for (const item of items.slice(0, MAX_LINES_PER_SECTION)) lines.push(render(item));
  const dropped = items.length - MAX_LINES_PER_SECTION;
  if (dropped > 0) lines.push(`- +${dropped} more`);
}

export function composeHourlyUpdate(f: HourlyFacts): string {
  if (isQuietHour(f)) return hourlyHeartbeatLine(f.now, f.since);
  const lines: string[] = [`*TTS — ${nyHhmm(f.now)}*`];

  lines.push("", "*Running now*");
  if (f.running.length === 0) lines.push("- nothing");
  listCapped(lines, f.running, (s) => {
    const on = s.statement === null ? "" : ` — ${slackEscape(s.statement)}`;
    return `- ${linked(s.title, ttsSessionLink(s.sessionId))} (${s.kind}, ${s.mode})${on} — ${elapsedText(s.elapsedMs)}`;
  });

  lines.push("", `*Batches worked since ${nyHhmm(f.since)}*`);
  if (f.batches.length === 0) lines.push("- none");
  listCapped(lines, f.batches, (b) => {
    const parts = [
      b.sessions > 0 ? `${b.sessions} session${b.sessions === 1 ? "" : "s"}` : null,
      b.workerEvents > 0
        ? `${b.workerEvents} worker event${b.workerEvents === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    return `- ${linked(b.statement, TTS_BATCHES_LINK)} — ${parts.join(", ")}`;
  });

  lines.push("", `*Changed since ${nyHhmm(f.since)}*`);
  if (f.changes.length === 0) lines.push("- nothing");
  listCapped(lines, f.changes, (c) => {
    const detail = c.detail === null ? "" : ` — ${slackEscape(c.detail)}`;
    return `- ${CHANGE_LABEL[c.kind]}: ${linked(c.text, c.link)}${detail}`;
  });
  return lines.join("\n");
}
