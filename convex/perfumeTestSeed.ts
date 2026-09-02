// The test-only /perfume seed (app/perfume/SIMPLIFICATION-PLAN.md §P8.1).
//
// WHAT IT IS FOR: the Playwright suite needs two members who are already
// joined, already stocked, and hold exactly the same items on every run.
// Practice mode (`?local=1&seed=basic`) used to supply that from the browser
// and was deleted in P1, which is why every single-user Perfumer spec has been
// skipped since. This mutation is the replacement, and it writes the same rows
// a real join + import would have written: a perfumeMembers row, a
// perfumeInventories row, and one empty owned brew per member.
//
// WHAT IT IS NOT: it does not create login accounts. A tom.quest account is a
// Convex Auth password account, and creating one needs the provider's own
// secret hashing, which is reachable from an action and not from a mutation.
// The suite therefore signs its two members up through the ordinary sign-up
// form (e2e/auth-flow.spec.ts does exactly that) or signs in with the E2E_*
// credentials, and then calls this with the usernames it used.
//
// WHY A PUBLIC MUTATION: Playwright calls it over HTTP with no auth token, so
// internalMutation is not an option. The two locks below are what make a
// public, unauthenticated, destructive mutation safe to ship.
//
// HOW A TEST CALLS IT — from node, outside the browser:
//
//   import { ConvexHttpClient } from "convex/browser";
//   import { api } from "../convex/_generated/api";
//   const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
//   const seeded = await convex.mutation(api.perfumeTestSeed.testSeed, {
//     members: [{ username: "ada" }, { username: "bee" }],
//   });
//   // seeded.members[0].brewId deep-links at /perfume/b/<brewId>
//
// Both locks have to be open on the deployment that URL points at, or the call
// throws with the name of the lock that closed.
//
// WHICH DEPLOYMENT THAT IS. tom.quest deliberately runs one Convex deployment
// and it is production (AGENTS.md, "Deployment"), so nothing here can be seeded
// as things stand. The intended host is a backend that is not the cloud
// production one: `npx convex dev --local` runs a whole Convex backend on this
// machine at a 127.0.0.1 URL, which satisfies the first lock without creating a
// second cloud deployment. Set the switch on it once with
// `npx convex env set PERFUME_TEST_SEED 1`, point Playwright's
// NEXT_PUBLIC_CONVEX_URL at it, and the suite has a deployment of its own.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  colorFor,
  deleteBrewRow,
  ensurePartyBrew,
  removeMemberByKey,
} from "./brews";
import { baseIngredients, pureIngredients } from "../app/perfume/data/base";

// ── the two locks ────────────────────────────────────────────────────────────

// tom.quest has ONE Convex deployment and it is production (AGENTS.md,
// "Deployment"). This is the URL of that one deployment, the same value the
// committed .env publishes as NEXT_PUBLIC_CONVEX_URL. Convex sets
// CONVEX_CLOUD_URL inside every function to the deployment it is running on, so
// comparing against this literal identifies production exactly.
const PRODUCTION_CLOUD_URL = "https://admired-chinchilla-140.convex.cloud";

// The second lock, and the one that cannot rot. The first lock is a literal: if
// production is ever recreated under a new deployment name, that literal names
// a deployment that no longer exists and stops recognising production. This one
// fails the other way — it opens only where somebody has deliberately run
// `npx convex env set PERFUME_TEST_SEED 1`, and production's environment is
// generated from secrets/convex.env, which does not contain it and never will.
const SEED_ENABLED_VAR = "PERFUME_TEST_SEED";

// Both locks must be open. Each refusal names which one closed, because a
// developer who cannot seed needs to know which of the two to look at.
export function requireSeedableDeployment(): void {
  const url = process.env.CONVEX_CLOUD_URL;
  if (!url) {
    throw new Error(
      "testSeed refused: CONVEX_CLOUD_URL is unset, so this deployment cannot " +
        "be shown to be anything other than production.",
    );
  }
  if (url === PRODUCTION_CLOUD_URL) {
    throw new Error(
      `testSeed refused: ${url} is the production deployment. The seed deletes ` +
        "members, brews and inventories, and never runs against production.",
    );
  }
  if (process.env[SEED_ENABLED_VAR] !== "1") {
    throw new Error(
      `testSeed refused: ${SEED_ENABLED_VAR} is not "1" on this deployment. ` +
        `Run \`npx convex env set ${SEED_ENABLED_VAR} 1\` on the deployment you ` +
        "want to seed.",
    );
  }
}

// ── what gets seeded ─────────────────────────────────────────────────────────

// The stock every seeded member starts with, unless the caller overrides it.
//
// These three quantities are not arbitrary. Noble Roses emits {A, A} and
// Aphasia Flower emits {Crallax, En}, so one of each is the whole recipe for
// Swana's Serum ([A, A, Crallax, En]) with a spare pair of Roses left over.
// Pemneath Peat emits {N, N} and Black Gas's recipe is [N], so a single Peat
// brews Black Gas ×2 — a k-multiple — and asking for a second Peat exceeds
// stock, which is how a spec reaches the hypothetical-blocks-brewing path
// without any further setup.
export const DEFAULT_SEED_INGREDIENTS: Record<string, number> = {
  "base:Noble Roses": 3,
  "base:Aphasia Flower": 2,
  "base:Pemneath Peat": 1,
};

const INGREDIENT_KEYS = new Set(baseIngredients.map((i) => i.key));
const PURE_KEYS = new Set(pureIngredients.map((i) => i.key));

function checkedStacks(
  stacks: Record<string, number> | undefined,
  allowed: Set<string>,
  section: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(stacks ?? {})) {
    if (!allowed.has(key)) {
      throw new Error(`testSeed: "${key}" is not a known ${section} key`);
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        `testSeed: count for "${key}" must be a positive whole number, got ${count}`,
      );
    }
    out[key] = count;
  }
  return out;
}

// Sign-up derives the account's synthetic email from the typed username, and
// the "email" index is the only way back from a username to a user row. Same
// normalisation as convex/auth.ts and convex/users.ts.
function emailFor(username: string): string {
  return `${username.toLowerCase().replace(/[^a-z0-9]/g, "")}@tom.quest`;
}

async function userByUsername(
  ctx: MutationCtx,
  username: string,
): Promise<Doc<"users">> {
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", emailFor(username)))
    .unique();
  if (!user) {
    throw new Error(
      `testSeed: no account for username "${username}". Sign it up first — ` +
        "the seed fills a member's rows, it cannot create a login.",
    );
  }
  return user;
}

// ── the seed ─────────────────────────────────────────────────────────────────

// Seeds one member per entry and returns what a test needs to drive them: the
// memberKey the permission matrix uses, and the id of the brew each member owns
// (deep-linkable at /perfume/b/<brewId>).
//
// DESTRUCTIVE AND DELIBERATELY SO. For each named member it deletes their
// member row, every brew they own, and their inventory, then writes them fresh;
// and it deletes the shared party brew and recreates it empty. A run therefore
// starts from the same state whatever the previous run left behind, including
// party contributions made by members who are not in this call.
export const testSeed = mutation({
  args: {
    members: v.array(
      v.object({
        username: v.string(),
        ingredients: v.optional(v.record(v.string(), v.number())),
        pures: v.optional(v.record(v.string(), v.number())),
      }),
    ),
  },
  handler: async (ctx, { members }) => {
    requireSeedableDeployment();
    if (members.length === 0) {
      throw new Error("testSeed: name at least one member to seed");
    }
    const emails = new Set(members.map((m) => emailFor(m.username)));
    if (emails.size !== members.length) {
      throw new Error(
        "testSeed: two entries name the same account — usernames are " +
          "normalised, so \"Ada\" and \"ada\" are one member",
      );
    }

    const now = Date.now();
    const seeded: {
      username: string;
      memberKey: string;
      name: string;
      brewId: Id<"perfumeBrews">;
    }[] = [];

    for (const entry of members) {
      const user = await userByUsername(ctx, entry.username);
      const memberKey = `user:${user._id}`;
      const ingredients = checkedStacks(
        entry.ingredients ?? DEFAULT_SEED_INGREDIENTS,
        INGREDIENT_KEYS,
        "ingredient",
      );
      const pures = checkedStacks(entry.pures, PURE_KEYS, "pure");

      await removeMemberByKey(ctx, memberKey);

      const name = user.name ?? entry.username;
      await ctx.db.insert("perfumeMembers", {
        memberKey,
        name,
        color: colorFor(memberKey),
        registeredAt: now,
        lastSeenAt: now,
      });
      await ctx.db.insert("perfumeInventories", {
        memberKey,
        ingredients,
        pures,
        perfumes: [],
        updatedAt: now,
      });
      // Seq 1 because removeMemberByKey just deleted every brew this member
      // owned, so the per-owner sequence starts over at one.
      const brewId = await ctx.db.insert("perfumeBrews", {
        owner: memberKey,
        seq: 1,
        nickname: null,
        items: [],
        strikePlays: [],
        wildPlays: [],
        pinned: null,
        cauldron: [],
        createdAt: now,
        updatedAt: now,
      });
      seeded.push({ username: entry.username, memberKey, name, brewId });
    }

    const party = await ctx.db
      .query("perfumeBrews")
      .withIndex("by_owner", (q) => q.eq("owner", null))
      .collect();
    for (const brew of party) await deleteBrewRow(ctx, brew._id);
    const freshParty = await ensurePartyBrew(ctx);

    return { members: seeded, partyBrewId: freshParty._id };
  },
});
