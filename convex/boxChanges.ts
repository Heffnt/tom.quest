// BOX CHANGES: every change to the Jarvis Box, where Tom already reads
// (plan-root T1; guarantee G4, "Tom understands what ran").
//
// The box-change reader on the box (Jarvis worker/jobs/box-watch.mjs) reads
// the systemd journal every two minutes and compares the machine's state
// every ten, and posts each change as one dtsEvents row of kind `box-change`
// through POST /tts/event. The shape is fixed between the two repositories
// (plan-root-dispositions.md, "Fixed shapes"):
//
//   { source: "sudo"|"systemd"|"user"|"ssh"|"state"|"deploy"|"setup",
//     why: "ran-as-root"|"unit"|"login"|"state"|"deploy"|"setup",
//     command?, change?: { what, before?, after? }, cwd?, user, at,
//     agentId?, count?, commit? }
//
// and the row's `key` is the agentId when the box matched one, so an agent's
// changes are one indexed read. This module is the record's side of it:
//   - boxChangeFaults, which the worker-event door runs before a row is
//     written, so a row of this kind always has the shape the readers assume;
//   - onBoxChange, which schedules the two Slack lines a change can earn: a
//     #tts-decisions line when it changes who or what can act on the box, and
//     a #tts-broken line when the journal lost entries the reader had not read;
//   - forAgent, the /agents chat's read of one agent's changes;
//   - boxChangeLines, the digest's "Box changes" facts: one line per agent
//     that ran root commands, one per deploy and per setup run, and one per
//     other kind of change.
//
// The command text arrives redacted by the box (its shape pass and, once J1
// lands, its exact-value pass). Every reader here runs it through
// redactSecrets again, the record's one choke point, before it leaves the
// server: a row from a box that has not deployed the reader's redaction yet is
// still shown redacted.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireTom } from "./authRoles";
import { redactSecrets } from "../shared/redact.mjs";
import type { BoxChangeFact } from "./ttsCompose";

export const BOX_CHANGE = "box-change";
/** The deploy job's own row (Jarvis worker/jobs/deploy.mjs): data
 *  { repo, from, to, commits, setupNeeded }, keyed `<repo>:<sha>`. */
export const DEPLOY = "deploy";

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
};

const COMMAND_CHARS = 2000;
const CHANGE_CHARS = 4000;

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

/** A stored row's data as a BoxChange, or null for a row that is not one. */
export function boxChangeOf(data: unknown): BoxChange | null {
  return boxChangeFaults(data).length === 0 ? (data as BoxChange) : null;
}

/** The change as it may leave the server: command and change text redacted. */
export function redactedBoxChange(change: BoxChange): BoxChange {
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

// ── Who or what can act ──────────────────────────────────────────────────────

/** The state items whose change is a change to who or what can act on the
 *  box (Jarvis box-change.mjs WHO_CAN_ACT, the same names): the plan's list,
 *  sudoers, ssh keys, users, the hook and the logging. */
const WHO_CAN_ACT_ITEMS = new Set(["sudoers", "authorized-keys", "users", "groups", "hooks", "logging"]);
// A stop of one of these silences the record the reader depends on.
const LOGGING_UNITS = new Set(["systemd-journald.service", "rsyslog.service", "auditd.service", "systemd-journald.socket"]);
// A root command running one of these changes who can log in or use sudo.
const ACCOUNT_PROGRAMS = new Set(["visudo", "useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod", "gpasswd", "passwd", "chpasswd", "adduser", "deluser", "addgroup", "delgroup"]);
// A root command touching one of these files changes who or what can act.
const WHO_CAN_ACT_PATHS = /sudoers|authorized_keys|\.claude-accounts|settings\.json|journald|rsyslog|\/etc\/passwd|\/etc\/group|\/etc\/shadow/;

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

function programOf(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  if ((words[0] ?? "").split("/").pop() === "env") {
    i = 1;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i].startsWith("-"))) i += 1;
  }
  return (words[i] ?? "").split("/").pop() ?? "";
}

/**
 * The words of a #tts-decisions line when this change is to who or what can
 * act on the box — sudo rules, ssh keys, accounts, the Claude hooks, the
 * logging (plan-root T1) — or null when it is not.
 */
export function whoCanActLine(change: BoxChange): string | null {
  const what = change.change?.what ?? "";
  if (change.source === "state" && WHO_CAN_ACT_ITEMS.has(what)) {
    return `The box's ${ITEM_WORDS[what] ?? what} changed${change.change?.after ? `: now ${oneLine(change.change.after, 160)}` : ""}${change.change?.before ? `; gone: ${oneLine(change.change.before, 120)}` : ""}`;
  }
  if (change.source === "user") return `An account changed on the box: ${oneLine(change.change?.after ?? "", 200)}`;
  if (change.source === "systemd" && LOGGING_UNITS.has(what)) return `The box's logging unit ${what} had a ${change.change?.after ?? "change"}`;
  if (change.source === "sudo" && change.count === undefined && change.command !== undefined) {
    if (ACCOUNT_PROGRAMS.has(programOf(change.command)) || WHO_CAN_ACT_PATHS.test(change.command)) {
      return `${change.user} ran as root: ${oneLine(change.command, 200)}`;
    }
  }
  return null;
}

/**
 * The Slack lines one recorded box change earns, scheduled in the mutation
 * that wrote its row: a #tts-decisions line when it changes who or what can
 * act, and a #tts-broken line when the journal lost entries the reader had
 * not read (plan-root T3). Neither holds a secret: the text is redacted first.
 */
export async function onBoxChange(ctx: MutationCtx, id: Id<"dtsEvents">, data: unknown): Promise<void> {
  const change = boxChangeOf(data);
  if (change === null) return;
  const shown = redactedBoxChange(change);
  if (shown.change?.what === "journal-gap") {
    await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
      job: "box-watch:journal-gap",
      statement: `The box's journal lost entries the box-change reader had not read${shown.change.before ? `, from ${shown.change.before}` : ""}${shown.change.after ? ` to ${shown.change.after}` : ""}, so changes to the machine in that span are not in the record.`,
      url: OBSERVE_URL,
    });
    return;
  }
  const decision = whoCanActLine(shown);
  if (decision === null) return;
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
    askId: `box-change:${id}`,
    decision,
    reason: "it changes who or what can act on the Jarvis Box",
  });
}

// ── The /agents chat ─────────────────────────────────────────────────────────

/** The most changes one agent's chat reads. */
const AGENT_MAX = 500;

/**
 * One agent's box changes, oldest first, for the marked rows in its chat.
 * `at` is when the change happened on the box (the row's own `at` is when it
 * was recorded, up to two minutes later).
 */
export const forAgent = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    await requireTom(ctx, "Agents");
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", BOX_CHANGE).eq("key", agentId))
      .order("asc")
      .take(AGENT_MAX);
    const out: (BoxChange & { id: string })[] = [];
    for (const row of rows) {
      const change = boxChangeOf(row.data);
      if (change !== null) out.push({ ...redactedBoxChange(change), id: row._id });
    }
    return out.sort((left, right) => left.at - right.at);
  },
});

// ── The digest ───────────────────────────────────────────────────────────────

export const OBSERVE_URL = "https://tom.quest/observe";

function agentUrl(agentId: string): string {
  return `https://tom.quest/agents?agent=${encodeURIComponent(agentId)}`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A command as a line names it: the program by its name, not its path. */
function shortCommand(command: string): string {
  return oneLine(command.replace(/^\S*\//, ""), 60);
}

function listed(items: string[], shown = 3): string {
  const head = items.slice(0, shown).join("; ");
  return items.length > shown ? `${head}; and ${items.length - shown} more` : head;
}

/** A deploy row of the deploy job's own, as the lines read it. */
type DeployRow = { at: number; repo?: string; to?: string; commits?: unknown };

/**
 * THE DIGEST'S BOX CHANGES, deterministic, one fact per line:
 *   - one per agent that ran root commands: "ran N root commands, M changed
 *     the machine: …" (N counts the read-only ones folded into a count; M is
 *     the commands the box did not count as reads);
 *   - one for root commands no agent was matched to, in the same words;
 *   - one per deploy (the deploy job's row, or the box's marker when no row
 *     names the same commit) and one per setup run;
 *   - one per kind of state change, one for unit changes, one for logins, and
 *     one per journal gap.
 * Every command text is redacted before it is a line.
 */
export function boxChangeLines(changes: BoxChange[], deploys: DeployRow[] = []): BoxChangeFact[] {
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
    facts.push({ id: `box:agent:${agentId}`, text: `An agent ${rootLine(runs)}.`, url: agentUrl(agentId) });
  }
  const unmatched = byAgent.get("");
  if (unmatched !== undefined) {
    facts.push({ id: "box:unmatched", text: `Root commands no agent was matched to: ${rootLine(unmatched)}.`, url: OBSERVE_URL });
  }

  const deployed = new Set<string>();
  for (const deploy of deploys) {
    const sha = typeof deploy.to === "string" ? deploy.to : "";
    if (sha !== "") deployed.add(sha);
    const commits = Array.isArray(deploy.commits) ? deploy.commits.length : 0;
    facts.push({
      id: `box:deploy:${sha || deploy.at}`,
      text: `The box deployed ${deploy.repo ?? "Jarvis"} ${sha.slice(0, 7)}${commits > 0 ? `, ${commits} ${plural(commits, "commit", "commits")}` : ""}.`,
      url: OBSERVE_URL,
    });
  }
  for (const change of shown) {
    if (change.source === "deploy") {
      const commit = change.commit ?? "";
      if ([...deployed].some((sha) => commit !== "" && sha.startsWith(commit))) continue;
      facts.push({ id: `box:deploy:${commit || change.at}`, text: `The box deployed ${commit.slice(0, 7)}.`, url: OBSERVE_URL });
    }
    if (change.source === "setup") {
      const folded = change.change?.what === "setup" && change.change.after ? `, ${change.change.after.replace(/^folded: /, "")}` : "";
      facts.push({
        id: `box:setup:${change.commit ?? change.at}`,
        text: `Setup ran as root${change.commit ? ` at ${change.commit.slice(0, 7)}` : ""}${folded}.`,
        url: OBSERVE_URL,
      });
    }
  }

  const byItem = new Map<string, BoxChange[]>();
  for (const change of shown) {
    if (change.source !== "state" && change.source !== "user") continue;
    const what = change.source === "user" ? "users" : change.change?.what ?? "state";
    byItem.set(what, [...(byItem.get(what) ?? []), change]);
  }
  for (const [what, items] of byItem) {
    if (what === "journal-gap") {
      for (const gap of items) {
        facts.push({
          id: `box:journal-gap:${gap.at}`,
          text: `The journal lost entries the reader had not read${gap.change?.before ? `, from ${gap.change.before}` : ""}${gap.change?.after ? ` to ${gap.change.after}` : ""}; the record has a gap there.`,
          url: OBSERVE_URL,
        });
      }
      continue;
    }
    const last = items[items.length - 1];
    const now = last.change?.after ? `: ${oneLine(last.change.after, 100)}` : "";
    facts.push({
      id: `box:state:${what}`,
      text: `The ${ITEM_WORDS[what] ?? what} changed${items.length > 1 ? ` ${items.length} times` : ""}${now}.`,
      url: OBSERVE_URL,
    });
  }

  const units = shown.filter((change) => change.source === "systemd");
  if (units.length > 0) {
    const words = units.map((unit) => `${unit.change?.what ?? "a unit"} ${unit.change?.after ?? ""}`.trim());
    facts.push({ id: "box:units", text: `Units changed outside a root command: ${listed(words, 4)}.`, url: OBSERVE_URL });
  }

  const logins = new Map<string, number>();
  for (const change of shown) {
    if (change.source !== "ssh") continue;
    logins.set(change.user, (logins.get(change.user) ?? 0) + (change.count ?? 1));
  }
  if (logins.size > 0) {
    const total = [...logins.values()].reduce((sum, n) => sum + n, 0);
    const who = [...logins.entries()].sort((left, right) => right[1] - left[1]).map(([user, n]) => `${user} ${n}`).join(", ");
    facts.push({ id: "box:logins", text: `${total} ssh ${plural(total, "login", "logins")} reached the box: ${who}.`, url: OBSERVE_URL });
  }
  return facts;
}
