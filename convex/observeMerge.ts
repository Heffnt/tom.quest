// APPROVING A CHANGE, AND WHAT HAPPENS AFTERWARDS.
//
// Tom presses Approve on the observation page; convex/observe.ts approveChange
// records that as an ordinary ruling of his, through the same function every
// other ruling goes through (convex/ttsRulings.ts insertRuling). This file is
// what the ruling then sets in motion.
//
// TWO THINGS LIVE HERE. The first is the mirror of the changes that are
// waiting: every open pull request, copied from GitHub so the page can show a
// change before it lands. The second is the landing itself: an approved change
// whose three gate rows are green is merged by the record, and the merge is
// written through convex/ttsMerge.ts internalRecordMerge — the same door the
// box posts through — so the digest, the objection list and the page all see
// one merge and not two.
//
// NOTHING POLLS IN A LOOP. One scheduled action runs every five minutes
// (convex/crons.ts): it refreshes the mirror and then tries the approved
// changes whose gate has turned green. Pressing Approve schedules the landing
// once as well, so a change that is already green lands at the press rather
// than within five minutes. There is no retry timer and no second queue.
//
// THE GATE IS NOT RE-IMPLEMENTED. mergeGateFor decides, exactly as it decides
// for the box, and internalRecordMerge runs it again before it writes — so a
// change landed without the three checks could not be recorded as a merge even
// if this file were wrong.
//
// THE CREDENTIAL IS GITHUB_MIRROR_TOKEN, the one the record already uses to ask
// GitHub whether a sha reached main. Whether it may also write is not something
// this file can know without trying: a token without write access answers 401
// or 403, and GitHub's own sentence is written onto the mirror row as the
// reason the change has not landed. The approval stands either way — it is
// Tom's ruling, not a request to GitHub — and the page says "approved, waiting
// for a merge" with that sentence under it.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { mergeGateFor, mergedOnMain } from "./ttsMerge";
import {
  SESSION_REPOS,
  commitChange,
  mergeKey,
  pullRequestChange,
} from "./ttsShared";

/** The repositories whose open pull requests the observation page lists and
 *  its Approve control can land. One name, because tom.quest is the one Tom
 *  asked for; widening it is adding a name to this array. */
export const APPROVABLE_REPOS = ["tom.quest"] as const;

/** THE ONE BASE BRANCH. A change lands on main or it does not land here: the
 *  merge gate's three rows and `mergedOnMain` both speak about main, so a pull
 *  request aimed anywhere else is one this control cannot tell the truth
 *  about. Such a pull request is not mirrored, so it carries no Approve. */
const MAIN_BRANCH = "main";

/** The most open pull requests one refresh mirrors (GitHub's page maximum). */
const PULLS_MAX = 100;

/** How long a closed row is kept: the observation page's widest window, so a
 *  merged commit anywhere on the page can still find its pull request. */
const CLOSED_KEEP_MS = 40 * 24 * 60 * 60 * 1000;

/** The longest piece of GitHub's own sentence kept on a row. A message is for
 *  a person to read; a whole error body would carry more than that. */
const GITHUB_SAID_MAX = 200;

type Pull = {
  number: number;
  title: string;
  draft: boolean;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
};

function slugOf(repo: string): string | undefined {
  return (SESSION_REPOS as Record<string, string>)[repo];
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "tts-observe",
    Authorization: `Bearer ${token}`,
  };
}

/** The newest ruling on a change's subject, or null. NEWEST WINS, the rule
 *  every ruling reader already uses: a later `revise` on the same subject
 *  withdraws an approval without anything here knowing a word for it. */
export async function newestRuling(
  ctx: QueryCtx | MutationCtx,
  repo: string,
  externalId: string,
) {
  const rulings = await ctx.db
    .query("dtsRulings")
    .withIndex("by_repo_external", (q) =>
      q.eq("repo", repo).eq("externalId", externalId),
    )
    .collect();
  return rulings.sort((left, right) => right.ruledAt - left.ruledAt)[0] ?? null;
}

/**
 * The change a commit belongs to, as a ruling subject: its pull request when
 * the mirror has seen one with this head sha, the commit itself otherwise. A
 * change approved while it waited is `pr-<n>`, and the merge it becomes is
 * found under that same subject here, which is how a landed change shows the
 * ruling that landed it.
 */
export async function changeOfCommit(
  ctx: QueryCtx | MutationCtx,
  repo: string,
  sha: string,
) {
  const pull = await ctx.db
    .query("pullRequests")
    .withIndex("by_repo_sha", (q) => q.eq("repo", repo).eq("headSha", sha))
    .first();
  if (pull !== null)
    return { externalId: pullRequestChange(pull.number), pull };
  return { externalId: commitChange(sha), pull: null };
}

/** The subject and words of the change Approve names, or a refusal. A pull
 *  request must be one the mirror holds; a commit must be one the record holds
 *  a merge row for. `open` is whether pressing should also try to land it. */
export async function resolveChange(
  ctx: QueryCtx | MutationCtx,
  repo: string,
  target: { number?: number; sha?: string },
): Promise<{ externalId: string; title: string; open: boolean }> {
  if ((target.number === undefined) === (target.sha === undefined)) {
    throw new Error(
      "a change is named by its pull request number or by its merged commit, not both",
    );
  }
  if (target.number !== undefined) {
    const number = target.number;
    const pull = await ctx.db
      .query("pullRequests")
      .withIndex("by_repo_number", (q) =>
        q.eq("repo", repo).eq("number", number),
      )
      .first();
    if (pull === null)
      throw new Error(
        `${repo} has no pull request #${number} the record knows`,
      );
    return {
      externalId: pullRequestChange(number),
      title: pull.title,
      open: pull.closedAt === undefined,
    };
  }
  const sha = target.sha!;
  const merge = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) =>
      q.eq("kind", "merge").eq("key", mergeKey(repo, sha)),
    )
    .first();
  if (merge === null)
    throw new Error(
      `${repo}@${sha.slice(0, 7)} is not a merge the record holds`,
    );
  const subject = (merge.data as { subject?: unknown } | undefined)?.subject;
  const { externalId, pull } = await changeOfCommit(ctx, repo, sha);
  return {
    externalId,
    title:
      pull?.title ??
      (typeof subject === "string" ? subject : `${repo}@${sha.slice(0, 7)}`),
    // A merged commit is never landed again: Approve on it records the ruling
    // only.
    open: false,
  };
}

/** Rewrite one repository's mirror to what GitHub currently lists open. A row
 *  GitHub stopped listing is marked closed, and a closed row older than the
 *  page's widest window is deleted. `lastAttempt` survives the rewrite: it is
 *  this file's own fact about a row, and GitHub has never heard of it. */
export const internalReplaceOpenPulls = internalMutation({
  args: {
    repo: v.string(),
    pulls: v.array(
      v.object({
        number: v.number(),
        title: v.string(),
        branch: v.string(),
        headSha: v.string(),
        baseBranch: v.string(),
        draft: v.boolean(),
        updatedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { repo, pulls }) => {
    const now = Date.now();
    const held = await ctx.db
      .query("pullRequests")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .collect();
    const wanted = new Map(pulls.map((pull) => [pull.number, pull]));
    for (const row of held) {
      const pull = wanted.get(row.number);
      wanted.delete(row.number);
      if (pull !== undefined) {
        await ctx.db.patch(row._id, {
          ...pull,
          seenAt: now,
          closedAt: undefined,
        });
      } else if (row.closedAt === undefined) {
        await ctx.db.patch(row._id, { closedAt: now });
      } else if (now - row.closedAt > CLOSED_KEEP_MS) {
        await ctx.db.delete(row._id);
      }
    }
    for (const pull of wanted.values()) {
      await ctx.db.insert("pullRequests", { ...pull, repo, seenAt: now });
    }
    return { open: pulls.length };
  },
});

/** The approved open changes whose gate is green, with what the landing needs. */
export const internalApprovedAndGreen = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ready: {
      id: string;
      repo: string;
      number: number;
      headSha: string;
      title: string;
    }[] = [];
    for (const repo of APPROVABLE_REPOS) {
      const rows = await ctx.db
        .query("pullRequests")
        .withIndex("by_repo", (q) => q.eq("repo", repo))
        .collect();
      for (const row of rows) {
        if (row.closedAt !== undefined) continue;
        // A row the mirror wrote before it knew to ask, or one whose base
        // moved: main is the only branch this can land on (MAIN_BRANCH).
        if (row.baseBranch !== MAIN_BRANCH) continue;
        const ruling = await newestRuling(
          ctx,
          repo,
          pullRequestChange(row.number),
        );
        if (ruling === null || ruling.verdict !== "approve") continue;
        const gate = await mergeGateFor(ctx, repo, row.headSha);
        if (!gate.allowed) continue;
        ready.push({
          id: row._id,
          repo,
          number: row.number,
          headSha: row.headSha,
          title: row.title,
        });
      }
    }
    return ready;
  },
});

/** What the last landing attempt did, written onto the row the page reads. A
 *  change that landed is marked closed at once, so it leaves the waiting list
 *  before the next refresh and a second landing run does not try it again. */
export const internalNoteAttempt = internalMutation({
  args: { id: v.string(), ok: v.boolean(), why: v.string() },
  handler: async (ctx, { id, ok, why }) => {
    const rowId = ctx.db.normalizeId("pullRequests", id);
    if (rowId === null) return;
    const row = await ctx.db.get(rowId);
    // A closed row has landed or gone; a late failure from an overlapping run
    // (GitHub refusing a pull request that has already merged) is not news.
    if (row === null || row.closedAt !== undefined) return;
    const now = Date.now();
    await ctx.db.patch(rowId, {
      lastAttempt: { at: now, ok, why },
      ...(ok ? { closedAt: now } : {}),
    });
  },
});

/**
 * Land every approved change whose gate is green, and record each landing.
 *
 * Scheduled by the refresh below and by the Approve control itself. It takes no
 * lock and needs none: a second run finds the row closed, or finds GitHub
 * refusing a pull request that has already merged, and internalRecordMerge
 * returns the existing row for a merge it already holds.
 *
 * THE COMMIT IS A MERGE COMMIT, Tom's ruling of 2026-09-19; the repository's
 * AGENTS.md line saying pull requests squash-merge is older than it. A merge
 * commit also keeps the head sha on main, which is what the gate's rows and
 * mergedOnMain are keyed on.
 */
export const landApproved = internalAction({
  args: {},
  handler: async (ctx): Promise<{ landed: number; tried: number }> =>
    await landReady(ctx),
});

/** The landing itself, a plain function so the refresh can run it in its own
 *  action rather than calling one action from another. */
async function landReady(
  ctx: ActionCtx,
): Promise<{ landed: number; tried: number }> {
  const ready = await ctx.runQuery(
    internal.observeMerge.internalApprovedAndGreen,
    {},
  );
  if (ready.length === 0) return { landed: 0, tried: 0 };
  const token = process.env.GITHUB_MIRROR_TOKEN;
  let landed = 0;
  for (const change of ready) {
    const slug = slugOf(change.repo);
    if (!token || slug === undefined) {
      await ctx.runMutation(internal.observeMerge.internalNoteAttempt, {
        id: change.id,
        ok: false,
        why: !token
          ? "the record holds no GitHub credential, so it cannot merge a change"
          : `${change.repo} is not a repository the record knows`,
      });
      continue;
    }
    let why: string;
    let ok = false;
    try {
      // WHAT GITHUB HOLDS NOW, not what the mirror saw five minutes ago: a
      // pull request can be retargeted at another branch between the refresh
      // and this call, and the merge request itself cannot name a base, so the
      // base is read here, immediately before the merge.
      const now = await fetch(
        `https://api.github.com/repos/${slug}/pulls/${change.number}`,
        { headers: githubHeaders(token) },
      );
      const base = now.ok
        ? ((await now.json()) as { base?: { ref?: unknown } }).base?.ref
        : null;
      if (base !== MAIN_BRANCH) {
        await ctx.runMutation(internal.observeMerge.internalNoteAttempt, {
          id: change.id,
          ok: false,
          why:
            base === null || base === undefined
              ? `GitHub would not say what branch #${change.number} is aimed at, so it was not merged`
              : `#${change.number} is aimed at ${String(base)} and not ${MAIN_BRANCH}, so it was not merged`,
        });
        continue;
      }
      const res = await fetch(
        `https://api.github.com/repos/${slug}/pulls/${change.number}/merge`,
        {
          method: "PUT",
          headers: {
            ...githubHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            merge_method: "merge",
            // GitHub refuses the merge if the head moved after the gate read
            // it, so what lands is the commit the three rows are about.
            sha: change.headSha,
            commit_title: `${change.title} (#${change.number})`,
          }),
        },
      );
      if (res.status === 200) {
        ok = true;
        why = `#${change.number} merged into ${change.repo} with a merge commit`;
      } else {
        const said = (
          (await res.json().catch(() => null)) as { message?: unknown } | null
        )?.message;
        why = `GitHub answered ${res.status}${typeof said === "string" ? `: ${said.slice(0, GITHUB_SAID_MAX)}` : ""}`;
        if (res.status === 401 || res.status === 403) {
          why +=
            "; the record's credential may read this repository and not write to it";
        }
      }
    } catch (error) {
      why = `GitHub could not be asked: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!ok) {
      await ctx.runMutation(internal.observeMerge.internalNoteAttempt, {
        id: change.id,
        ok,
        why,
      });
      continue;
    }
    // THE RECORD'S OWN DOOR, with the sentence POST /tts/merge writes:
    // mergedOnMain is asked afterwards, so the row carries GitHub's answer
    // about the head sha rather than this file's account of its own success.
    const onMain = await mergedOnMain(change.repo, change.headSha);
    // GitHub'S ANSWER ABOUT THE HEAD DECIDES, not this file's account of its
    // own success: where the merge call answered 200 and the head is not on
    // main, nothing is recorded and the row keeps the failure, because a merge
    // row the record cannot see on main is a sentence about a merge that did
    // not happen where it was meant to.
    if (!onMain.merged) {
      await ctx.runMutation(internal.observeMerge.internalNoteAttempt, {
        id: change.id,
        ok: false,
        why: `${why}, but GitHub does not show it on main: ${onMain.why}`,
      });
      continue;
    }
    const written = await ctx.runMutation(
      internal.ttsMerge.internalRecordMerge,
      {
        repo: change.repo,
        sha: change.headSha,
        subject: change.title,
        mainCheck: onMain.why,
      },
    );
    await ctx.runMutation(internal.observeMerge.internalNoteAttempt, {
      id: change.id,
      ok: true,
      why: written.recorded
        ? why
        : `${why}, but the record refused to write it: ${written.gate.missing.join(", ")}`,
    });
    if (written.recorded) landed += 1;
  }
  return { landed, tried: ready.length };
}

/**
 * THE ONE SCHEDULED THING. Refresh the mirror of open pull requests, then try
 * the approved ones whose gate has turned green. Five minutes apart, which is
 * the whole of the waiting in this feature.
 */
export const refreshOpenPulls = internalAction({
  args: {},
  handler: async (ctx): Promise<{ open: number }> => {
    const token = process.env.GITHUB_MIRROR_TOKEN;
    if (!token) return { open: 0 };
    let open = 0;
    for (const repo of APPROVABLE_REPOS) {
      const slug = slugOf(repo);
      if (slug === undefined) continue;
      let pulls: Pull[];
      try {
        const res = await fetch(
          `https://api.github.com/repos/${slug}/pulls?state=open&per_page=${PULLS_MAX}`,
          { headers: githubHeaders(token) },
        );
        if (!res.ok) {
          console.error(
            `observe: ${repo} pull requests could not be read (${res.status})`,
          );
          continue;
        }
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) continue;
        pulls = body as Pull[];
      } catch (error) {
        console.error(
          `observe: ${repo} pull requests could not be read: ${String(error)}`,
        );
        continue;
      }
      const rows = pulls
        .filter(
          (pull) =>
            typeof pull?.number === "number" &&
            typeof pull.head?.sha === "string" &&
            pull.base?.ref === MAIN_BRANCH,
        )
        .map((pull) => ({
          number: pull.number,
          title: typeof pull.title === "string" ? pull.title : "",
          branch: pull.head.ref,
          headSha: pull.head.sha,
          baseBranch: MAIN_BRANCH,
          draft: pull.draft === true,
          updatedAt: Date.parse(pull.updated_at) || Date.now(),
        }));
      const answer = await ctx.runMutation(
        internal.observeMerge.internalReplaceOpenPulls,
        {
          repo,
          pulls: rows,
        },
      );
      open += answer.open;
    }
    await landReady(ctx);
    return { open };
  },
});
