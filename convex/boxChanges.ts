// BOX CHANGES: every change to the Jarvis Box, where Tom already reads
// (plan-root T1; guarantee G4, "Tom understands what ran").
//
// The box-change reader on the box (Jarvis worker/jobs/box-watch.mjs) reads
// the systemd journal every two minutes and compares the machine's state
// every ten, and posts each change as one `events` row of kind `box-change`
// through POST /jarvis/event (night/w4, 2026-09-26; before, a dtsEvents row
// through the legacy pen POST /tts/event, which now hands a box change to
// the same write, see convex/ttsNightly.ts internalRecordBoxChange). The data
// shape is fixed between the two repositories (plan-root-dispositions.md,
// "Fixed shapes"):
//
//   { source: "sudo"|"systemd"|"user"|"ssh"|"state"|"deploy"|"setup",
//     why: "ran-as-root"|"unit"|"login"|"state"|"deploy"|"setup",
//     command?, change?: { what, before?, after? }, cwd?, user, at,
//     agentId?, count?, commit? }
//
// The row's `at` is data.at, when it happened on the box, and its
// provenance.agentId is data.agentId when the box matched an agent, so an
// agent's changes are one indexed read (events.by_agent_at). This module is
// the record's side of it:
//   - assertBoxChange, the write-time shape check;
//   - forAgent, the /agents chat's read of one agent's changes;
//   - boxChangeLines, the history page's facts: one line per agent
//     that ran root commands, one per deploy and per setup run, and one per
//     other kind of change.
//
// The command text arrives redacted by the box (its shape pass and its
// exact-value pass). Every reader here runs it through redactSecrets again,
// the record's one choke point, before it leaves the server: a row from a box
// that has not deployed the reader's redaction yet is still shown redacted.

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTom } from "./authRoles";
import { redactSecrets } from "../shared/redact.mjs";

export const BOX_CHANGE = "box-change";
/** The deploy job's own row (Jarvis worker/jobs/deploy.mjs): data
 *  { repo, from, to, commits, setupNeeded }, keyed `<repo>:<sha>`. */
export const DEPLOY = "deploy";
/** Where the history page links a summarized box change. */
const AGENTS_WINDOW_URL = "/agents?view=window";

type BoxChangeFact = { id: string; text: string; url: string };

const BOX_SOURCES = ["sudo", "systemd", "user", "ssh", "state", "deploy", "setup"] as const;
const BOX_WHYS = ["ran-as-root", "unit", "login", "state", "deploy", "setup"] as const;
type BoxSource = (typeof BOX_SOURCES)[number];
type BoxWhy = (typeof BOX_WHYS)[number];

export type BoxChange = {
  source: BoxSource;
  why: BoxWhy;
  command?: string;
  change?: { what: string; before?: string; after?: string };
  cwd?: string;
  user: string;
  at: number;
  agentId?: string;
  count?: number;
  commit?: string;
  /** The reader's own identity for the change: the journal cursor of its
   *  first line, or the state comparison's snapshot key. A resend carries the
   *  same id; two changes never do. Absent from a box that does not send it
   *  yet, and then nothing is taken for a resend. */
  id?: string;
};

const COMMAND_CHARS = 2000;
const CHANGE_CHARS = 4000;
const ID_CHARS = 512;

/** Why a posted box-change body cannot be recorded; empty when it can. */
export function boxChangeFaults(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return ["data must be an object"];
  const d = data as Record<string, unknown>;
  const faults: string[] = [];
  if (!(BOX_SOURCES as readonly unknown[]).includes(d.source)) faults.push(`data.source must be one of ${BOX_SOURCES.join(", ")}`);
  if (!(BOX_WHYS as readonly unknown[]).includes(d.why)) faults.push(`data.why must be one of ${BOX_WHYS.join(", ")}`);
  if (typeof d.user !== "string" || d.user === "") faults.push("data.user must be a non-empty string");
  if (typeof d.at !== "number" || !Number.isFinite(d.at)) faults.push("data.at must be a number (ms)");
  if (d.command !== undefined && (typeof d.command !== "string" || d.command.length > COMMAND_CHARS)) faults.push(`data.command must be a string of at most ${COMMAND_CHARS} characters`);
  if (d.cwd !== undefined && typeof d.cwd !== "string") faults.push("data.cwd must be a string");
  if (d.agentId !== undefined && (typeof d.agentId !== "string" || d.agentId === "")) faults.push("data.agentId must be a non-empty string");
  if (d.commit !== undefined && (typeof d.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(d.commit))) faults.push("data.commit must be a hex commit");
  // Capped because the id becomes the row's indexed subject (onBoxChange); a
  // journal cursor is about 150 characters.
  if (d.id !== undefined && (typeof d.id !== "string" || d.id === "" || d.id.length > ID_CHARS)) faults.push(`data.id must be a non-empty string of at most ${ID_CHARS} characters`);
  if (d.count !== undefined && (typeof d.count !== "number" || !Number.isSafeInteger(d.count) || d.count < 1)) faults.push("data.count must be a positive integer");
  if (d.change !== undefined) {
    const c = d.change as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null || typeof c.what !== "string" || c.what === "") faults.push("data.change.what must be a non-empty string");
    else for (const side of ["before", "after"] as const) {
      if (c[side] !== undefined && (typeof c[side] !== "string" || (c[side] as string).length > CHANGE_CHARS)) faults.push(`data.change.${side} must be a string of at most ${CHANGE_CHARS} characters`);
    }
  }
  return faults;
}

/** The change as it may leave the server: command and change text redacted. */
function redactedBoxChange(change: BoxChange): BoxChange {
  return {
    ...change,
    ...(change.command === undefined ? {} : { command: redactSecrets(change.command) }),
    ...(change.change === undefined
      ? {}
      : {
          change: {
            what: change.change.what,
            ...(change.change.before === undefined ? {} : { before: redactSecrets(change.change.before) }),
            ...(change.change.after === undefined ? {} : { after: redactSecrets(change.change.after) }),
          },
        }),
  };
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function shortCommand(command: string): string {
  return oneLine(command.replace(/^\S*\//, ""), 60);
}

function listed(items: string[], shown = 3): string {
  const head = items.slice(0, shown).join("; ");
  return items.length > shown ? `${head}; and ${items.length - shown} more` : head;
}

/** Summaries the history page uses to fold a day's box changes without
 * exposing commands or state values unredacted. */
export function boxChangeLines(
  changes: BoxChange[],
  deploys: Array<{ at: number; repo?: string; to?: string; commits?: unknown }> = [],
): BoxChangeFact[] {
  const facts: BoxChangeFact[] = [];
  const shown = changes.map(redactedBoxChange);
  const byAgent = new Map<string, BoxChange[]>();
  for (const change of shown) {
    if (change.source !== "sudo") continue;
    const key = change.agentId ?? "";
    byAgent.set(key, [...(byAgent.get(key) ?? []), change]);
  }
  const rootLine = (runs: BoxChange[]) => {
    const total = runs.reduce((sum, run) => sum + (run.count ?? 1), 0);
    const changed = runs.filter((run) => run.count === undefined);
    const tail = changed.length === 0
      ? "all of them reads"
      : `${changed.length} changed the machine: ${listed(changed.map((run) => shortCommand(run.command ?? "")))}`;
    return `ran ${total} root ${plural(total, "command", "commands")}, ${tail}`;
  };
  for (const [agentId, runs] of byAgent) {
    if (agentId === "") continue;
    facts.push({ id: `box:agent:${agentId}`, text: `An agent ${rootLine(runs)}.`, url: `/agents?agent=${encodeURIComponent(agentId)}` });
  }
  const unmatched = byAgent.get("");
  if (unmatched !== undefined) {
    facts.push({ id: "box:unmatched", text: `Root commands no agent was matched to: ${rootLine(unmatched)}.`, url: AGENTS_WINDOW_URL });
  }
  const deployed = new Set<string>();
  for (const deploy of deploys) {
    const sha = typeof deploy.to === "string" ? deploy.to : "";
    if (sha !== "") deployed.add(sha);
    const commits = Array.isArray(deploy.commits) ? deploy.commits.length : 0;
    facts.push({
      id: `box:deploy:${sha}@${deploy.at}`,
      text: `The box deployed ${deploy.repo ?? "Jarvis"} ${sha.slice(0, 7)}${commits > 0 ? `, ${commits} ${plural(commits, "commit", "commits")}` : ""}.`,
      url: AGENTS_WINDOW_URL,
    });
  }
  for (const change of shown) {
    if (change.source === "deploy") {
      const commit = change.commit ?? "";
      if (![...deployed].some((sha) => commit !== "" && sha.startsWith(commit))) {
        facts.push({ id: `box:deploy:${commit}@${change.at}`, text: `The box deployed ${commit.slice(0, 7)}.`, url: AGENTS_WINDOW_URL });
      }
    }
    if (change.source === "setup") {
      const folded = change.change?.what === "setup" && change.change.after ? `, ${change.change.after.replace(/^folded: /, "")}` : "";
      facts.push({ id: `box:setup:${change.commit ?? ""}@${change.at}`, text: `Setup ran as root${change.commit ? ` at ${change.commit.slice(0, 7)}` : ""}${folded}.`, url: AGENTS_WINDOW_URL });
    }
  }
  const byItem = new Map<string, BoxChange[]>();
  for (const change of shown) {
    if (change.source !== "state" && change.source !== "user") continue;
    const what = change.source === "user" ? "users" : change.change?.what ?? "state";
    byItem.set(what, [...(byItem.get(what) ?? []), change]);
  }
  for (const [what, items] of byItem) {
    const last = items[items.length - 1];
    const now = last.change?.after ? `: ${oneLine(last.change.after, 100)}` : "";
    facts.push({ id: `box:state:${what}`, text: `The ${ITEM_WORDS[what] ?? what} changed${items.length > 1 ? ` ${items.length} times` : ""}${now}.`, url: AGENTS_WINDOW_URL });
  }
  const units = shown.filter((change) => change.source === "systemd");
  if (units.length > 0) {
    const words = units.map((unit) => `${unit.change?.what ?? "a unit"} ${unit.change?.after ?? ""}`.trim());
    facts.push({ id: "box:units", text: `Units changed outside a root command: ${listed(words, 4)}.`, url: AGENTS_WINDOW_URL });
  }
  const logins = new Map<string, number>();
  for (const change of shown) {
    if (change.source === "ssh") logins.set(change.user, (logins.get(change.user) ?? 0) + (change.count ?? 1));
  }
  if (logins.size > 0) {
    const total = [...logins.values()].reduce((sum, n) => sum + n, 0);
    const who = [...logins.entries()].sort((left, right) => right[1] - left[1]).map(([user, n]) => `${user} ${n}`).join(", ");
    facts.push({ id: "box:logins", text: `${total} ssh ${plural(total, "login", "logins")} reached the box: ${who}.`, url: AGENTS_WINDOW_URL });
  }
  return facts;
}

const ITEM_WORDS: Record<string, string> = {
  sudoers: "sudo rules",
  "authorized-keys": "ssh keys",
  users: "user accounts",
  groups: "groups",
  hooks: "Claude hooks",
  logging: "logging configuration",
  packages: "package list",
  "enabled-units": "enabled units",
  crontabs: "crontabs",
  etc: "files under /etc",
  "usr-local": "files under /usr/local",
  "journal-gap": "journal",
};

/**
 * ONE ROW PER CHANGE. The box's outbox is at-least-once: a post whose answer
 * was lost to the network is sent again on the next run, and for as long as a
 * box still posts through the legacy pen and another through POST
 * /jarvis/event, both carry the same outbox. A second row with the same
 * `data.id` (the reader's identity for the change) is that resend, not a
 * second change, so recordEvent (convex/jarvis/events.ts) does not record it
 * and it earns no additional record row. The time and the body are no identity: two sudo runs of one command
 * in one millisecond are two changes. A change posted without an id is
 * always recorded, a resend of it included.
 */
/** The subject a box change with a reader id is filed under. */
export function boxChangeSubject(id: string): string {
  return `box-change-id:${id}`;
}

/** Throws unless the event is a well-formed box change: the fixed data
 *  shape, provenance.agentId its data.agentId, and `at` its data.at. Run by
 *  recordEvent before anything else, a resend's lookup included, so a
 *  malformed post is refused whatever id it carries. */
export function assertBoxChange(event: { at?: number; provenance?: { agentId?: string }; data?: unknown }): void {
  const faults = boxChangeFaults(event.data);
  if (faults.length > 0) throw new Error(`not a box change: ${faults.join("; ")}`);
  const change = event.data as BoxChange;
  if (event.provenance?.agentId !== change.agentId) {
    throw new Error("a box change's provenance.agentId is its data.agentId, and it has none when data.agentId is absent");
  }
  if (event.at !== change.at) throw new Error("a box change's at is data.at, when it happened on the box");
}

/**
 * The event a box change is, from the fixed shape the box posts: `at` when it
 * happened, the reader's half as the job (the state comparison reports as
 * box-state, the journal reader as box-watch), the matched agent as
 * provenance.agentId. The legacy pen's translation and the history copy build
 * the row with it; the box builds the same (Jarvis box-change.mjs
 * recordEvent).
 */
export function boxChangeEvent(data: BoxChange) {
  return {
    kind: BOX_CHANGE,
    at: data.at,
    provenance: {
      // A journal gap is the journal reader's (box-watch) whatever source the
      // row names; older gap rows name "state".
      job: data.source === "state" && data.change?.what !== "journal-gap" ? "box-state" : "box-watch",
      ...(data.agentId === undefined ? {} : { agentId: data.agentId }),
    },
    data,
  };
}

// ── The /agents chat ─────────────────────────────────────────────────────────

/** The most changes one agent's chat reads. */
const AGENT_MAX = 500;

/**
 * One agent's box changes, oldest first, for the marked rows in its chat, off
 * the kind's rows for that agent (events.by_kind_agent_at), so no number of
 * the agent's other rows is read to find them. `at` is when the change
 * happened on the box.
 *
 * NOTHING OLDER IS MISSING FROM IT. The one-time history copy (w4's
 * convex/jarvis/history.ts, run in production on 2026-09-26 and deleted in
 * 9555ceff) moved every dtsEvents box change into `events`; and no box
 * change in the record has ever named an agent (production's events table,
 * read 2026-09-26: 16 box changes, none with provenance.agentId), so no
 * agent's chat had a box change to lose. boxChanges.test.ts "the /agents
 * read" holds this read path.
 */
export const forAgent = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    await requireTom(ctx, "Agents");
    const rows = await ctx.db
      .query("events")
      .withIndex("by_kind_agent_at", (q) => q.eq("kind", BOX_CHANGE).eq("provenance.agentId", agentId))
      .order("asc")
      .take(AGENT_MAX);
    return rows.map((row) => ({ ...redactedBoxChange(row.data as BoxChange), id: row._id }));
  },
});
