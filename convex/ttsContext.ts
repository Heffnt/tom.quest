// THE ONE PLACE a run's model-of-tom context is assembled inside Convex.
//
// A prompt is, in order:
//
//   THE BASE — header line 1, the map, the operate rules (agent-rules.md).
//     Identical for every run at one WikiTom commit, whoever the caller is and
//     whatever it is about, which is what makes it the cache boundary.
//   THE WRITE PAGES — model-of-tom/writing.md then ground.md, verbatim, when
//     the caller's output reaches Tom.
//   THE SKILLS LINE — one fixed line saying how a run lists and reads the
//     skills (WikiTom skills/*.md). A run reads a skill on demand; nothing is
//     granted or refused.
//   THE RECORD FACTS — his rulings on the subject and the last session
//     outcomes in its repositories, which have no page a run could read later.
//
// NO MODEL CALL, anywhere on this path.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { modelOfTomState, modelOfTomText, withoutModelOfTomPrelude } from "./ttsSkills";
import { nyCalendarDayKey, SESSION_REPO_NAMES } from "./ttsShared";

/** What the run is about. `none` is every caller with no subject (the HTTP
 * doors, the laptop): its prompt carries no record facts. */
export type ContextSubject =
  // `repos`: the repositories the run works in, as its caller named them (a
  // session's resolved repos).
  | { kind: "todo"; todoId: Id<"dtsTodos">; repos?: readonly string[] }
  | { kind: "repo"; repo: string }
  | { kind: "none" };

/** The HTTP doors that read internalContextPrelude, each naming itself. */
const CONTEXT_DOORS = [
  "planner-context",
  "capture-context",
  "time-notes",
  "weekly-input",
  "simplify-input",
] as const;

/** The write pages, in prompt order. */
const WRITE_PAGES = ["model-of-tom/writing.md", "model-of-tom/ground.md"] as const;

/** The one line every prompt carries in place of a list of skills. */
export const SKILLS_LINE = "Skills: `tts-search skills` lists them; `tts-search skills <name>` prints one.";

export type AssembledContext = {
  /** Header line 1 + the map + the operate rules. The cache boundary. */
  prefix: string;
  /** writing.md then ground.md, or "" for a run whose output does not reach Tom. */
  write: string;
  /** SKILLS_LINE. */
  skills: string;
  /** His rulings on the subject and recent session outcomes, or "". */
  facts: string;
};

// ── Read bounds ──────────────────────────────────────────────────────────────
// Every read below is indexed and capped. The one exception is the per-repo
// session scan: `repos` is an ARRAY and Convex does not index array
// membership, so that half stays a bounded descending walk of the two terminal
// statuses, filtered in memory. Cap it and move on.

/** The ceiling on the unindexed session scan. */
export const SESSION_SCAN_MAX = 60;
const SESSION_SCAN_PER_STATUS = SESSION_SCAN_MAX / 2;
const RULINGS_PER_SUBJECT = 5;
const OUTCOMES_PER_SUBJECT = 3;
// These volatile facts ride every opener; the caps keep them a small tail.
export const RULINGS_BYTES = 2048;
export const OUTCOMES_BYTES = 1536;

function boundedFactText<Row>(rows: Row[], maxBytes: number, render: (row: Row) => string): string[] {
  const chosen = [];
  let used = 0;
  for (const row of rows) {
    const text = render(row);
    const bytes = byteLength(text);
    if (used + bytes > maxBytes) break;
    chosen.push(text);
    used += bytes;
  }
  return chosen;
}

type ContextRecord = {
  rulings: { verdict: string; sentence?: string; ruledAt: number; ruledDay: string }[];
  sessions: { outcome: string; outcomeSummary?: string; endedDay: string }[];
};

function renderFacts(record: ContextRecord): string {
  const rulings = boundedFactText(
    [...record.rulings]
      .sort((a, b) => b.ruledAt - a.ruledAt || a.verdict.localeCompare(b.verdict))
      .slice(0, RULINGS_PER_SUBJECT),
    RULINGS_BYTES,
    (ruling) => `${ruling.ruledDay} ${ruling.verdict}${ruling.sentence ? `: ${ruling.sentence}` : ""}`,
  );
  const outcomes = boundedFactText(
    record.sessions,
    OUTCOMES_BYTES,
    (session) => `${session.endedDay} ${session.outcome}${session.outcomeSummary ? `: ${session.outcomeSummary}` : ""}`,
  );
  if (rulings.length === 0 && outcomes.length === 0) return "";
  return [
    ...(rulings.length === 0 ? [] : ["RULINGS ON THIS SUBJECT", ...rulings.map((ruling) => `- ${ruling}`)]),
    ...(outcomes.length === 0 ? [] : ["RECENT SESSION OUTCOMES", ...outcomes.map((outcome) => `- ${outcome}`)]),
  ].join("\n");
}

function sessionRow(session: Doc<"claudeSessions">): ContextRecord["sessions"][number] | null {
  if (session.outcome === undefined) return null;
  return {
    outcome: session.outcome,
    outcomeSummary: session.outcomeSummary,
    endedDay: nyCalendarDayKey(session.statusChangedAt),
  };
}

/**
 * The subject's record facts, rendered: his rulings on its todo and the last
 * outcomes of sessions in its repositories. Every query is on an index and
 * take()s a fixed number, except the session walk SESSION_SCAN_MAX bounds.
 *
 * A todo subject that does not exist throws: a run that thinks it saw its
 * subject and saw nothing is worse than a run that stops.
 */
async function subjectFacts(
  ctx: QueryCtx | MutationCtx,
  subject: ContextSubject,
): Promise<string> {
  const record: ContextRecord = { rulings: [], sessions: [] };
  const repos = subject.kind === "repo"
    ? [subject.repo]
    : subject.kind === "todo"
      ? [...new Set(subject.repos ?? [])].sort()
      : [];

  if (subject.kind === "todo") {
    const todo = await ctx.db.get(subject.todoId);
    if (todo === null) throw new Error(`context subject todo ${subject.todoId} does not exist`);
    const own = await ctx.db
      .query("rulings")
      .withIndex("by_todo", (q) => q.eq("todoId", todo._id))
      .take(RULINGS_PER_SUBJECT);
    for (const ruling of own) {
      record.rulings.push({
        verdict: ruling.verdict,
        sentence: ruling.sentence,
        ruledAt: ruling.ruledAt,
        ruledDay: nyCalendarDayKey(ruling.ruledAt),
      });
    }
  }

  // The unindexed half: each terminal-status walk is newest first, then their
  // matching rows compete by timestamp before they fill the slots.
  if (repos.length > 0) {
    const recentByStatus = await Promise.all((["ended", "failed"] as const).map(async (status) =>
      await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(SESSION_SCAN_PER_STATUS),
    ));
    const repositorySessions = recentByStatus
      .flat()
      .filter((session) => (session.repos ?? [session.repo]).some((repo) => repos.includes(repo)))
      .sort((a, b) => b.statusChangedAt - a.statusChangedAt || a._id.localeCompare(b._id));
    for (const session of repositorySessions) {
      if (record.sessions.length >= OUTCOMES_PER_SUBJECT) break;
      const row = sessionRow(session);
      if (row !== null) record.sessions.push(row);
    }
  }
  return renderFacts(record);
}

/** The write pages the last post stored, each rendered the way the prelude
 * renders every file: `── <path> ──` and the body. The post that stores the
 * base stores these in the same transaction, so a stored base comes with
 * them whenever the publisher sent them. */
async function writePages(ctx: QueryCtx | MutationCtx): Promise<string> {
  const blocks: string[] = [];
  for (const path of WRITE_PAGES) {
    const name = path.slice("model-of-tom/".length).replace(/\.md$/, "");
    const row = await ctx.db.query("modelOfTomFiles").withIndex("by_name", (q) => q.eq("name", name)).first();
    if (row !== null && row.sourcePath === path) blocks.push(`── ${path} ──\n${row.body}`);
  }
  return blocks.join("\n\n");
}

/**
 * A run's model-of-tom context: the base, the write pages when the run's
 * output reaches Tom, the skills line, and the subject's record facts.
 *
 * Reads, per call, inside the caller's existing transaction:
 *
 *   modelOfTomPublication by_key                     1
 *   modelOfTomFiles by_name                          2  (reaching Tom only)
 *   dtsTodos get                                   ≤  1
 *   rulings by_todo                             ≤  5
 *   claudeSessions by_status ×2, filtered in memory ≤ 60 (SESSION_SCAN_MAX)
 *
 * FAILS CLOSED, like every other reader of the publication: a deployment with
 * no posted base throws here, and the caller publishes nothing.
 */
export async function assembleContext(
  ctx: QueryCtx | MutationCtx,
  subject: ContextSubject,
  { reachesTom }: { reachesTom: boolean },
): Promise<AssembledContext> {
  const prefix = modelOfTomText(await modelOfTomState(ctx), ["operate"]);
  const write = reachesTom ? await writePages(ctx) : "";
  return { prefix, write, skills: SKILLS_LINE, facts: await subjectFacts(ctx, subject) };
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The parts as one string, in prompt order. */
export function joinContext(context: AssembledContext): string {
  return [context.prefix, context.write, context.skills, context.facts].filter((part) => part !== "").join("\n\n");
}

/**
 * A seed's prompt with a pasted opener's whole context taken off: the base
 * (withoutModelOfTomPrelude, which refuses one read at another commit), then
 * the write pages and the skills line when they follow it, then the old
 * subject's facts block (RULINGS ON THIS SUBJECT / RECENT SESSION OUTCOMES, up
 * to the blank line that ends it). The opener then puts this subject's
 * context in front, so no ruling or outcome of another subject rides along.
 * A prompt that does not begin with the header comes back as it was; null is
 * the refusal.
 */
export function withoutPastedContext(prompt: string, context: AssembledContext): string | null {
  const body = withoutModelOfTomPrelude(prompt, context.prefix);
  if (body === null || body === prompt) return body;
  let rest = body;
  for (const part of [context.write, context.skills]) {
    if (part !== "" && rest.startsWith(part)) rest = rest.slice(part.length).replace(/^\n+/, "");
  }
  if (/^(RULINGS ON THIS SUBJECT|RECENT SESSION OUTCOMES)\n/.test(rest)) {
    const end = rest.indexOf("\n\n");
    rest = end === -1 ? "" : rest.slice(end).replace(/^\n+/, "");
  }
  return rest;
}

/** The HTTP doors read here. They have no subject of their own, and each
 * one's output reaches Tom. */
export const internalContextPrelude = internalQuery({
  args: { caller: v.string() },
  handler: async (ctx, args): Promise<string> => {
    if (!(CONTEXT_DOORS as readonly string[]).includes(args.caller)) throw new Error(`unknown context caller ${args.caller}`);
    return joinContext(await assembleContext(ctx, { kind: "none" }, { reachesTom: true }));
  },
});

// ── The repo layer's publication ─────────────────────────────────────────────

/** A path inside a repo naming an `AGENTS.md`: relative, no traversal, and the
 * file the repo layer is actually made of. */
export function isRepoRulesPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^(?:[A-Za-z0-9._-]+\/)*AGENTS\.md$/.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/**
 * One repo's rules, replaced whole. Same shape of refusal as
 * `internalReplaceModelOfTom`: an empty post leaves the store as it was, a
 * duplicate path is a bug in the poster, and a blank body is not a rules file.
 *
 * PER REPO, not per post: a night that could read tom.quest and not
 * ComplexMultiTrigger replaces the first repo's rows and leaves the second's
 * exactly where they were.
 */
export const internalReplaceRepoRules = internalMutation({
  args: {
    repo: v.string(),
    commit: v.string(),
    syncedAt: v.number(),
    files: v.array(v.object({ path: v.string(), body: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, { repo, commit, syncedAt, files }) => {
    // A repo name nobody declared would create a phantom repo's rules that no
    // session could ever be opened on — a typo, silently stored.
    if (!(SESSION_REPO_NAMES as readonly string[]).includes(repo)) throw new Error(`not a session repo: ${repo}`);
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(syncedAt)) throw new Error("syncedAt must be finite");
    if (files.length === 0) throw new Error("no repo rules posted — store left as it was");
    const paths = new Set<string>();
    for (const file of files) {
      if (!isRepoRulesPath(file.path)) throw new Error(`not a repo rules path: ${file.path}`);
      if (paths.has(file.path)) throw new Error(`path posted twice: ${file.path}`);
      if (file.body.trim() === "") throw new Error(`body for ${file.path} must be non-empty`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`bytes for ${file.path} must be a nonnegative integer`);
      }
      paths.add(file.path);
    }
    const existing = await ctx.db
      .query("repoRules")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const file of files) {
      await ctx.db.insert("repoRules", { repo, path: file.path, body: file.body, bytes: file.bytes, commit, syncedAt });
    }
    return { repo, files: files.length, deleted: existing.length, commit };
  },
});
