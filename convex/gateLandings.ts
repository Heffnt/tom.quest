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
//       — the same report, keyed on the commit itself.
//
// WHICH COMMITS ARRIVED. The record keeps, per repository, the newest commit
// on main it has accounted for (the table gateMainHeads). A refresh asks
// GitHub to compare that commit with main. The commits that arrived are the
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
import { GATED_REPOS, SESSION_REPOS } from "../shared/session-constants.mjs";
import { LANDING_JOB, landingKey, mergeGateFor } from "./ttsMerge";

/** The branch the gate guards. */
const MAIN = "main";

/** How many recently closed pull requests one refresh reads: GitHub's page
 *  maximum, far more than land in five minutes. */
const CLOSED_PULLS_READ = 100;

type GitHubCommit = {
  sha: string;
  parents?: { sha?: unknown }[];
  commit?: { message?: unknown };
};

type GitHubPull = {
  number?: unknown;
  title?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
  head?: { sha?: unknown };
  base?: { ref?: unknown };
};

/** A pull request GitHub shows landed on main, in the few fields used here. */
type Landed = { number: number; title: string; headSha: string; landedAs: string | null };

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
 * File one commit that arrived on main: a merge row when the gate is open for
 * the head it is keyed on, a report of a landing past the gate otherwise.
 * Answers which it wrote.
 */
export const internalAccountForCommit = internalMutation({
  args: {
    repo: v.string(),
    /** The commit on main. */
    commit: v.string(),
    /** The first line of its message, the subject of a commit of no pull request. */
    subject: v.string(),
    pull: v.optional(v.object({ number: v.number(), title: v.string(), headSha: v.string() })),
  },
  handler: async (ctx, { repo, commit, subject, pull }): Promise<{ filed: "merge" | "report" }> => {
    const gateSha = pull?.headSha ?? commit;
    const gate = await mergeGateFor(ctx, repo, gateSha);
    const short = (sha: string) => sha.slice(0, 7);
    if (gate.allowed) {
      await ctx.runMutation(internal.ttsMerge.internalRecordMerge, {
        repo,
        sha: gateSha,
        subject: pull?.title || subject,
        // The sentence mergedOnMain writes for the same fact, and where it
        // landed: this file read it from GitHub's own list.
        mainCheck:
          pull === undefined
            ? `${short(commit)} is on ${MAIN}`
            : `${short(gateSha)} is the head of pull request #${pull.number}, merged into ${MAIN} as ${short(commit)}`,
      });
      return { filed: "merge" };
    }
    const missing = gate.missing.join(", ");
    await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
      job: LANDING_JOB,
      key: landingKey(repo, gateSha),
      error:
        pull === undefined
          ? `${repo} commit ${short(commit)} arrived on ${MAIN} with no pull request, and the merge gate is shut for it: missing ${missing}.`
          : `${repo} pull request #${pull.number} landed on ${MAIN} as ${short(commit)} with the merge gate shut for its head ${short(gateSha)}: missing ${missing}.`,
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
 * One refresh's accounting, for every repository under the gate. Answers the
 * failures, one sentence each, for the timed task's own row
 * (convex/jarvis/tick.ts failuresOf); a repository that failed is read again,
 * from the same commit, on the next refresh.
 *
 * GitHub is asked, per repository: once when main has not moved (the
 * comparison); and when it has, once more for the recently closed pull
 * requests, and once for each arrived commit they do not name.
 */
export async function accountForMain(ctx: ActionCtx, token: string): Promise<string[]> {
  const failures: string[] = [];
  const ask = async (slug: string, path: string): Promise<{ status: number; body: unknown }> => {
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
    const compare = await ask(slug, `compare/${seen}...${MAIN}`);
    const body = compare.body as { status?: unknown; total_commits?: unknown; commits?: unknown } | null;
    if (body === null || !Array.isArray(body.commits)) {
      fail(`main could not be compared with ${seen.slice(0, 7)} (status ${compare.status})`);
      continue;
    }
    const arrived = (body.commits as GitHubCommit[]).filter((commit) => typeof commit?.sha === "string");
    if (arrived.length === 0) continue;
    if (typeof body.total_commits === "number" && body.total_commits > arrived.length) {
      // GitHub lists at most 250 commits of a comparison. Past that the newest
      // commit is not in the list, and nothing here can say which arrived.
      fail(`main moved by ${body.total_commits} commits since ${seen.slice(0, 7)}, more than one read lists; they were not accounted for`);
      const head = await ask(slug, `commits/${MAIN}`);
      const sha = (head.body as { sha?: unknown } | null)?.sha;
      if (typeof sha === "string") await ctx.runMutation(internal.gateLandings.internalSetMainSeen, { repo, sha });
      continue;
    }
    const line = firstParentLine(arrived);
    const closed = await ask(
      slug,
      `pulls?state=closed&base=${MAIN}&sort=updated&direction=desc&per_page=${CLOSED_PULLS_READ}`,
    );
    if (!Array.isArray(closed.body)) {
      fail(`closed pull requests could not be read (status ${closed.status})`);
      continue;
    }
    const byLanding = new Map<string, Landed>();
    const byHead = new Map<string, Landed>();
    for (const value of closed.body) {
      const landed = landedOf(value);
      if (landed === null) continue;
      if (landed.landedAs !== null) byLanding.set(landed.landedAs, landed);
      byHead.set(landed.headSha, landed);
    }
    let finished = true;
    for (const commit of line) {
      let pull = byLanding.get(commit.sha) ?? byHead.get(commit.sha) ?? null;
      if (pull === null) {
        const asked = await ask(slug, `commits/${commit.sha}/pulls`);
        if (!Array.isArray(asked.body)) {
          fail(`the pull requests of ${commit.sha.slice(0, 7)} could not be read (status ${asked.status})`);
          finished = false;
          break;
        }
        pull = asked.body.map(landedOf).find((one): one is Landed => one !== null) ?? null;
      }
      await ctx.runMutation(internal.gateLandings.internalAccountForCommit, {
        repo,
        commit: commit.sha,
        subject: subjectOf(commit),
        ...(pull === null ? {} : { pull: { number: pull.number, title: pull.title, headSha: pull.headSha } }),
      });
    }
    if (finished && line.length > 0) {
      await ctx.runMutation(internal.gateLandings.internalSetMainSeen, { repo, sha: line[line.length - 1].sha });
    }
  }
  return failures;
}
