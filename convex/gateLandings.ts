// EVERY COMMIT THAT ARRIVES ON MAIN OF A REPOSITORY UNDER THE MERGE GATE,
// ACCOUNTED FOR BY THE RECORD ITSELF.
//
// A landing used to be a row only when a session or a job posted it through
// POST /tts/merge, and many landings never were. Now each refresh of the
// record's timed task "pull-requests" (convex/jarvis/tick.ts, every five
// minutes) reads from GitHub what arrived on main of each repository in
// GATED_REPOS (shared/session-constants.mjs) since the last commit it
// accounted for, and files every commit that arrived as one of three:
//
//   a pull request that landed with the gate open for its head
//       — the merge row POST /tts/merge writes, through the same function
//         (convex/ttsMerge.ts internalRecordMerge), once;
//   a pull request that landed with the gate shut for its head
//       — no merge row, and a report of its own (convex/ttsMerge.ts
//         LANDING_JOB, one job-failed row per commit), which the digest shows
//         once among what is broken and which is cleared when the gate opens;
//   a commit that belongs to no pull request
//       — a report of its own whatever rows its commit has, keyed on the
//         commit (noPullRequestKey), which the gate opening never clears;
//         except on main of a repository in MAIN_TAKES_PUSHES (WikiTom, whose
//         main takes the nightly job's pushes), where such a commit is filed
//         as nothing.
//
// WHICH COMMITS ARRIVED. The record keeps, per repository, the newest commit
// on main it has accounted for (the table gateMainHeads). A refresh asks
// GitHub to compare that commit with main, page by page until it holds every
// commit the comparison counts (total_commits); a comparison it cannot read
// whole is a failure and accounts for nothing, so no commit is ever skipped.
// The commits that arrived are the
// ones on main's FIRST-PARENT line since it: each landing is one such commit
// (a merge commit, a squash commit, a fast-forwarded head), and a merge
// commit's other commits are the pull request's own, which arrive with it and
// are not landings of their own. A rebase landing is several first-parent
// commits, each of which GitHub ties to the pull request.
//
// WHICH PULL REQUEST A COMMIT BELONGS TO. A squash commit carries no gate rows
// of its own; the rows are its pull request's head's. The recently closed pull
// requests of the repository, read once per refresh that finds main moved,
// name each landing's commit on main (merge_commit_sha) and its head. A commit
// they do not name is asked about on its own (commits/{sha}/pulls), which is
// also how a rebase landing's earlier commits and a push straight to main are
// told apart.
//
// THE FIRST REFRESH ACCOUNTS FOR NOTHING. It records main's newest commit and
// starts from there, so the landings before this file existed do not arrive
// in one morning as merge rows dated today.
//
// A REFRESH THAT CANNOT FINISH MOVES NOTHING FORWARD. The newest commit
// accounted for is written only after every commit that arrived was filed, so
// the next refresh reads the same commits again. Filing one twice writes
// nothing twice: a merge row is written once per head, and a report already
// standing is a repeat the digest does not show again.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { GATED_REPOS, MAIN_TAKES_PUSHES, SESSION_REPOS } from "../shared/session-constants.mjs";
import { LANDING_JOB, landingKey, mergeGateFor } from "./ttsMerge";
import { cutToBytes } from "./jarvis/outbox";

/** The branch the gate guards. */
const MAIN = "main";

/** How many recently closed pull requests one refresh reads: GitHub's page
 *  maximum, far more than land in five minutes. */
const CLOSED_PULLS_READ = 100;

/** How many commits of a comparison one read asks for: GitHub's page maximum.
 *  Main moving by more than this in five minutes takes a second page. */
const COMPARE_PAGE = 100;

/** The report of a commit that belongs to no pull request. Not landingKey: a
 *  gate that opens later for that commit (clearLandingReportIfOpen) does not
 *  make a change that reached main without a pull request one that had one. */
function noPullRequestKey(repo: string, sha: string): string {
  return `${landingKey(repo, sha)}:no-pull-request`;
}

type GitHubCommit = {
  sha: string;
  parents?: { sha?: unknown }[];
  commit?: { message?: unknown };
};

type GitHubPull = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
  head?: { sha?: unknown };
  base?: { ref?: unknown };
};

/** A pull request GitHub shows landed on main, in the few fields used here. */
type Landed = { number: number; title: string; claim: string | null; headSha: string; landedAs: string | null };

/** The most UTF-8 bytes of a pull request's first paragraph a merge row keeps. */
const CLAIM_MAX_BYTES = 2_048;

/** A pull request body's first paragraph: the text before its first blank
 *  line, cut to CLAIM_MAX_BYTES; null for an empty or absent body. The Jarvis
 *  thread shows it as the claim of the landing's return (convex/thread.ts). */
function claimOf(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const first = body.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/)[0].trim();
  return first === "" ? null : cutToBytes(first, CLAIM_MAX_BYTES);
}

/** One commit of main's first-parent line and the pull request it landed, or
 *  null for a commit of no pull request. */
type Resolved = { commit: GitHubCommit; pull: Landed | null };

/** One GET of GitHub's API for a repository: its status, and its JSON when it
 *  answered 2xx. Never throws: an unreachable GitHub is status 0. */
type Ask = (slug: string, path: string) => Promise<{ status: number; body: unknown }>;

function askGitHub(token: string): Ask {
  return async (slug, path) => {
    try {
      const res = await fetch(`https://api.github.com/repos/${slug}/${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "tts-gate-landings",
          Authorization: `Bearer ${token}`,
        },
      });
      return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
    } catch {
      return { status: 0, body: null };
    }
  };
}

/** The newest commit on main the record has accounted for, or null before the
 *  first refresh. */
export const internalMainSeen = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }): Promise<string | null> =>
    (await ctx.db
      .query("gateMainHeads")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .first())?.sha ?? null,
});

/** Move the newest accounted-for commit forward. */
export const internalSetMainSeen = internalMutation({
  args: { repo: v.string(), sha: v.string() },
  handler: async (ctx, { repo, sha }) => {
    const held = await ctx.db
      .query("gateMainHeads")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .first();
    if (held === null) await ctx.db.insert("gateMainHeads", { repo, sha, seenAt: Date.now() });
    else await ctx.db.patch(held._id, { sha, seenAt: Date.now() });
  },
});

/**
 * File one commit that arrived on main: a report when it belongs to no pull
 * request; for a pull request, a merge row when the gate is open for its head,
 * a report of a landing past the gate otherwise. Answers which it wrote.
 */
export const internalAccountForCommit = internalMutation({
  args: {
    repo: v.string(),
    /** The commit on main. */
    commit: v.string(),
    /** The first line of its message, the subject of a commit of no pull request. */
    subject: v.string(),
    pull: v.optional(v.object({
      number: v.number(), title: v.string(), headSha: v.string(), claim: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { repo, commit, subject, pull }): Promise<{ filed: "merge" | "report" }> => {
    const short = (sha: string) => sha.slice(0, 7);
    if (pull === undefined) {
      // No pull request is no landing through the gate, whatever rows the
      // commit itself has.
      await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
        job: LANDING_JOB,
        key: noPullRequestKey(repo, commit),
        error: `${repo} commit ${short(commit)} arrived on ${MAIN} with no pull request: "${subject}".`,
      });
      return { filed: "report" };
    }
    const gate = await mergeGateFor(ctx, repo, pull.headSha);
    if (gate.allowed) {
      await ctx.runMutation(internal.ttsMerge.internalRecordMerge, {
        repo,
        sha: pull.headSha,
        subject: pull.title || subject,
        pull: { number: pull.number, title: pull.title },
        ...(pull.claim === undefined ? {} : { claim: pull.claim }),
        // The sentence mergedOnMain writes for the same fact, and where it
        // landed: this file read it from GitHub's own list.
        mainCheck: `${short(pull.headSha)} is the head of pull request #${pull.number}, merged into ${MAIN} as ${short(commit)}`,
      });
      return { filed: "merge" };
    }
    await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
      job: LANDING_JOB,
      key: landingKey(repo, pull.headSha),
      error: `${repo} pull request #${pull.number} landed on ${MAIN} as ${short(commit)} with the merge gate shut for its head ${short(pull.headSha)}: missing ${gate.missing.join(", ")}.`,
    });
    return { filed: "report" };
  },
});

/** A pull request out of GitHub's JSON when it landed on main, else null. */
function landedOf(value: unknown): Landed | null {
  const pull = (value ?? {}) as GitHubPull;
  if (typeof pull.number !== "number" || typeof pull.merged_at !== "string") return null;
  if (pull.base?.ref !== MAIN || typeof pull.head?.sha !== "string") return null;
  return {
    number: pull.number,
    title: typeof pull.title === "string" ? pull.title : "",
    claim: claimOf(pull.body),
    headSha: pull.head.sha,
    landedAs: typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
  };
}

/**
 * The commits of main's first-parent line among `arrived`, oldest first: from
 * main's newest commit (the one no other arrived commit names as a parent)
 * back through each first parent while it is still one that arrived.
 */
export function firstParentLine(arrived: readonly GitHubCommit[]): GitHubCommit[] {
  const bySha = new Map(arrived.map((commit) => [commit.sha, commit]));
  const named = new Set(arrived.flatMap((commit) => (commit.parents ?? []).map((parent) => String(parent.sha))));
  const tips = arrived.filter((commit) => !named.has(commit.sha));
  const line: GitHubCommit[] = [];
  let at: GitHubCommit | undefined = tips.at(-1);
  while (at !== undefined && !line.includes(at)) {
    line.push(at);
    const first = at.parents?.[0]?.sha;
    at = typeof first === "string" ? bySha.get(first) : undefined;
  }
  return line.reverse();
}

/** The first line of a commit's message. */
function subjectOf(commit: GitHubCommit): string {
  const message = commit.commit?.message;
  return typeof message === "string" ? (message.split("\n")[0] ?? "").trim() : "";
}

/**
 * Every commit on main since `seen` (not `seen` itself), from GitHub's
 * comparison, page by page. The pages come in no one order, which does not
 * matter: firstParentLine reads parents, not order. A comparison not read
 * whole is `unread`, a sentence saying why.
 */
async function readComparison(
  ask: Ask,
  slug: string,
  seen: string,
): Promise<{ arrived: GitHubCommit[] } | { unread: string }> {
  const arrived: GitHubCommit[] = [];
  const held = new Set<string>();
  let total = 0;
  for (let page = 1; ; page += 1) {
    const compare = await ask(slug, `compare/${seen}...${MAIN}?per_page=${COMPARE_PAGE}&page=${page}`);
    const body = compare.body as { total_commits?: unknown; commits?: unknown } | null;
    if (body === null || !Array.isArray(body.commits)) {
      return { unread: `${MAIN} could not be compared with ${seen.slice(0, 7)} (page ${page}, status ${compare.status})` };
    }
    const fresh = (body.commits as GitHubCommit[]).filter(
      (commit) => typeof commit?.sha === "string" && !held.has(commit.sha),
    );
    for (const commit of fresh) {
      held.add(commit.sha);
      arrived.push(commit);
    }
    total = typeof body.total_commits === "number" ? body.total_commits : arrived.length;
    if (arrived.length >= total || fresh.length === 0) break;
  }
  if (arrived.length < total) {
    return {
      unread: `${MAIN} moved by ${total} commits since ${seen.slice(0, 7)} and GitHub listed ${arrived.length} of them; none was accounted for`,
    };
  }
  return { arrived };
}

/**
 * The pull request each commit of `line` landed: named by the recently closed
 * pull requests (read once), or else asked about on its own. A commit whose
 * pull requests cannot be read leaves the whole line `unread`.
 */
async function pullsOfLine(
  ask: Ask,
  slug: string,
  line: readonly GitHubCommit[],
): Promise<{ resolved: Resolved[] } | { unread: string }> {
  const closed = await ask(
    slug,
    `pulls?state=closed&base=${MAIN}&sort=updated&direction=desc&per_page=${CLOSED_PULLS_READ}`,
  );
  if (!Array.isArray(closed.body)) return { unread: `closed pull requests could not be read (status ${closed.status})` };
  const byLanding = new Map<string, Landed>();
  const byHead = new Map<string, Landed>();
  for (const value of closed.body) {
    const landed = landedOf(value);
    if (landed === null) continue;
    if (landed.landedAs !== null) byLanding.set(landed.landedAs, landed);
    byHead.set(landed.headSha, landed);
  }
  const resolved: Resolved[] = [];
  for (const commit of line) {
    let pull = byLanding.get(commit.sha) ?? byHead.get(commit.sha) ?? null;
    if (pull === null) {
      const asked = await ask(slug, `commits/${commit.sha}/pulls`);
      if (!Array.isArray(asked.body)) {
        return { unread: `the pull requests of ${commit.sha.slice(0, 7)} could not be read (status ${asked.status})` };
      }
      pull = asked.body.map(landedOf).find((one): one is Landed => one !== null) ?? null;
    }
    resolved.push({ commit, pull });
  }
  return { resolved };
}

/** The commits of `resolved` that are filed: all of them, except on main of a
 *  repository in MAIN_TAKES_PUSHES a commit of no pull request. */
function toFile(repo: string, resolved: readonly Resolved[]): Resolved[] {
  const takesPushes = (MAIN_TAKES_PUSHES as readonly string[]).includes(repo);
  return resolved.filter((one) => one.pull !== null || !takesPushes);
}

/** File each commit (internalAccountForCommit), oldest first. */
async function fileCommits(ctx: ActionCtx, repo: string, commits: readonly Resolved[]): Promise<void> {
  for (const { commit, pull } of commits) {
    await ctx.runMutation(internal.gateLandings.internalAccountForCommit, {
      repo,
      commit: commit.sha,
      subject: subjectOf(commit),
      ...(pull === null ? {} : { pull: {
        number: pull.number, title: pull.title, headSha: pull.headSha,
        ...(pull.claim === null ? {} : { claim: pull.claim }),
      } }),
    });
  }
}

/**
 * One refresh's accounting, for every repository under the gate. Answers the
 * failures, one sentence each, for the timed task's own row
 * (convex/jarvis/tick.ts failuresOf); a repository that failed is read again,
 * from the same commit, on the next refresh.
 *
 * GitHub is asked, per repository: once when main has not moved (the
 * comparison's first page); and when it has, once per further page of the
 * comparison, once for the recently closed pull requests, and once for each
 * arrived commit they do not name.
 */
export async function accountForMain(ctx: ActionCtx, token: string): Promise<string[]> {
  const failures: string[] = [];
  const ask = askGitHub(token);
  for (const repo of GATED_REPOS) {
    const slug = SESSION_REPOS[repo];
    const fail = (why: string) => failures.push(`gate landings: ${repo} ${why}`);
    const seen = await ctx.runQuery(internal.gateLandings.internalMainSeen, { repo });
    if (seen === null) {
      const head = await ask(slug, `commits/${MAIN}`);
      const sha = (head.body as { sha?: unknown } | null)?.sha;
      if (typeof sha !== "string") {
        fail(`main could not be read (status ${head.status})`);
        continue;
      }
      await ctx.runMutation(internal.gateLandings.internalSetMainSeen, { repo, sha });
      continue;
    }
    // A comparison not read whole accounts for nothing and moves nothing
    // forward, so the next refresh reads it again from the same commit.
    const compared = await readComparison(ask, slug, seen);
    if ("unread" in compared) {
      fail(compared.unread);
      continue;
    }
    if (compared.arrived.length === 0) continue;
    const line = firstParentLine(compared.arrived);
    const pulls = await pullsOfLine(ask, slug, line);
    if ("unread" in pulls) {
      fail(pulls.unread);
      continue;
    }
    await fileCommits(ctx, repo, toFile(repo, pulls.resolved));
    if (line.length > 0) {
      await ctx.runMutation(internal.gateLandings.internalSetMainSeen, { repo, sha: line[line.length - 1].sha });
    }
  }
  return failures;
}
