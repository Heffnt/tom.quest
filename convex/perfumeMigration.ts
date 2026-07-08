// Ship migration for the multi-brew /perfume backend (DESIGN.md §§2,4,9).
//
// AUTHORED NOW (Phase 2), RUN LATER (Phase 8) — see SIMPLIFICATION-PLAN.md P8.
// Do NOT run this against prod until Tom gives an explicit go. Capture the
// member-merge mapping from prod member rows first (dashboard or a listMembers
// query — the duplicate anon "tom" key → the real "user:<id>" Tom key), then:
//
//   npx convex run perfumeMigration:migrate '{"mergeMembers":[{"fromKey":"anon:<uuid>","toKey":"user:<id>"}]}'
//
// After a clean run and prod verification, a follow-up commit deletes THIS file
// and the optional-deprecated schema fields it strips (contributorName,
// cauldron.provenance, inventory giftEvents, perfume owners, pinned.recipeIndex).
//
// It does three things, all IDEMPOTENT (running twice is a no-op):
//   1. Member merge (arg-driven): fold each `fromKey` member into `toKey` —
//      sum inventory stacks, move perfume instances, reassign owned brews,
//      rewrite every fromKey reference (contributor + provenance) to toKey,
//      then delete the fromKey member row and its now-empty inventory.
//   2. Strip deprecated fields left optional by Steps 2–3 of the backend
//      contraction: items' contributorName, cauldron provenance chains,
//      inventory giftEvents, and perfume owners chains.
//   3. Convert brew `pinned` from the old {perfumeId, recipeIndex} to the
//      forward-compatible {perfumeId} (Phase 4 finalizes pin semantics).
//
// Server-only: imports nothing from client-only modules (no React/DOM/engine).

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// ── local db helpers (self-contained; brews.ts helpers are not exported) ──────

async function memberByKey(
  ctx: MutationCtx,
  memberKey: string,
): Promise<Doc<"perfumeMembers"> | null> {
  return await ctx.db
    .query("perfumeMembers")
    .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
    .unique();
}

async function inventoryByMember(
  ctx: MutationCtx,
  memberKey: string,
): Promise<Doc<"perfumeInventories"> | null> {
  return await ctx.db
    .query("perfumeInventories")
    .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
    .unique();
}

// Ensure toKey has an inventory row to merge into (does not register a member —
// only creates the holdings row). Used solely as a merge destination.
async function ensureInventory(
  ctx: MutationCtx,
  memberKey: string,
): Promise<Doc<"perfumeInventories">> {
  const existing = await inventoryByMember(ctx, memberKey);
  if (existing) return existing;
  const id = await ctx.db.insert("perfumeInventories", {
    memberKey,
    ingredients: {},
    pures: {},
    perfumes: [],
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

function sumStacks(
  into: Record<string, number>,
  from: Record<string, number>,
): Record<string, number> {
  const out = { ...into };
  for (const [k, n] of Object.entries(from)) out[k] = (out[k] ?? 0) + n;
  return out;
}

function dedupe(keys: string[]): string[] {
  return [...new Set(keys)];
}

// ── member merge (idempotent per pair) ───────────────────────────────────────

// Fold `fromKey` into `toKey`. Each sub-step guards on the presence of fromKey
// data, so a second run — after fromKey's rows are gone and references rewritten
// — finds nothing to do and returns false. Returns whether anything changed.
async function mergeMember(
  ctx: MutationCtx,
  fromKey: string,
  toKey: string,
): Promise<boolean> {
  if (fromKey === toKey) return false;
  const now = Date.now();
  let changed = false;

  // 1. Inventory: sum fungible stacks and append perfume instances into toKey,
  //    then delete fromKey's inventory row.
  const fromInv = await inventoryByMember(ctx, fromKey);
  if (fromInv) {
    const toInv = await ensureInventory(ctx, toKey);
    await ctx.db.patch(toInv._id, {
      ingredients: sumStacks(toInv.ingredients, fromInv.ingredients),
      pures: sumStacks(toInv.pures, fromInv.pures),
      // Instances move whole (perfumes are not fungible); strip any deprecated
      // `owners` chain in the same pass so merged rows are clean.
      perfumes: [
        ...toInv.perfumes,
        ...fromInv.perfumes.map((p) => ({
          instanceId: p.instanceId,
          perfumeId: p.perfumeId,
          brewedByKey: p.brewedByKey === fromKey ? toKey : p.brewedByKey,
          witnesses: dedupe(
            p.witnesses.map((w) => (w === fromKey ? toKey : w)),
          ),
          brewedAt: p.brewedAt,
        })),
      ],
      updatedAt: now,
    });
    await ctx.db.delete(fromInv._id);
    changed = true;
  }

  // 2. Reassign brews owned by fromKey to toKey. Renumber seq to continue after
  //    toKey's current max so the default "{owner} brew {n}" names stay unique.
  const fromBrews = await ctx.db
    .query("perfumeBrews")
    .withIndex("by_owner", (q) => q.eq("owner", fromKey))
    .collect();
  if (fromBrews.length > 0) {
    const toBrews = await ctx.db
      .query("perfumeBrews")
      .withIndex("by_owner", (q) => q.eq("owner", toKey))
      .collect();
    let maxSeq = toBrews.reduce((m, b) => Math.max(m, b.seq), 0);
    for (const b of [...fromBrews].sort((a, c) => a.seq - c.seq)) {
      await ctx.db.patch(b._id, { owner: toKey, seq: ++maxSeq, updatedAt: now });
    }
    changed = true;
  }

  // 3. Rewrite every remaining fromKey reference across ALL brews: items'
  //    contributorKey (per the plan) plus the flat provenance keys on cauldron
  //    instances, so the merged member leaves no dangling identity behind.
  const allBrews = await ctx.db.query("perfumeBrews").collect();
  for (const b of allBrews) {
    const patch: Partial<Doc<"perfumeBrews">> = {};
    if (b.items.some((it) => it.contributorKey === fromKey)) {
      patch.items = b.items.map((it) =>
        it.contributorKey === fromKey ? { ...it, contributorKey: toKey } : it,
      );
    }
    // Prod-safe: un-migrated rows carry legacy `outputs` instead of `cauldron`.
    const resting = b.cauldron ?? b.outputs ?? [];
    if (
      resting.some(
        (c) => c.brewedByKey === fromKey || c.witnesses.includes(fromKey),
      )
    ) {
      patch.cauldron = resting.map((c) => ({
        ...c,
        brewedByKey: c.brewedByKey === fromKey ? toKey : c.brewedByKey,
        witnesses: dedupe(c.witnesses.map((w) => (w === fromKey ? toKey : w))),
      }));
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(b._id, { ...patch, updatedAt: now });
      changed = true;
    }
  }

  // 4. Rewrite provenance keys on OTHER members' perfume instances that name
  //    fromKey (fromKey's own inventory already moved in step 1).
  const allInventories = await ctx.db.query("perfumeInventories").collect();
  for (const inv of allInventories) {
    if (
      inv.perfumes.some(
        (p) => p.brewedByKey === fromKey || p.witnesses.includes(fromKey),
      )
    ) {
      await ctx.db.patch(inv._id, {
        perfumes: inv.perfumes.map((p) => ({
          instanceId: p.instanceId,
          perfumeId: p.perfumeId,
          brewedByKey: p.brewedByKey === fromKey ? toKey : p.brewedByKey,
          witnesses: dedupe(
            p.witnesses.map((w) => (w === fromKey ? toKey : w)),
          ),
          brewedAt: p.brewedAt,
        })),
        updatedAt: now,
      });
      changed = true;
    }
  }

  // 5. Delete the fromKey member row.
  const fromMember = await memberByKey(ctx, fromKey);
  if (fromMember) {
    await ctx.db.delete(fromMember._id);
    changed = true;
  }

  return changed;
}

// ── deprecated-field stripping (idempotent; patches only when something changes) ──

// Strip contributorName off items, provenance off cauldron instances, and
// convert pinned {perfumeId, recipeIndex} → {perfumeId}. Returns the count of
// brews actually changed.
async function stripBrews(ctx: MutationCtx): Promise<number> {
  const brews = await ctx.db.query("perfumeBrews").collect();
  let changed = 0;
  for (const b of brews) {
    const patch: Partial<Doc<"perfumeBrews">> = {};
    if (b.items.some((it) => it.contributorName !== undefined)) {
      patch.items = b.items.map((it) => ({
        key: it.key,
        real: it.real,
        contributorKey: it.contributorKey,
      }));
    }
    // Rename the legacy `outputs` field → `cauldron` and strip the provenance
    // chain in one pass. Un-migrated prod rows carry `outputs`; migrated rows
    // carry `cauldron`. Either way, normalize to a `cauldron` with no chain and
    // drop the legacy `outputs` field entirely (idempotent: once outputs is gone
    // and no provenance remains, neither branch fires again).
    const hadLegacyOutputs = b.outputs !== undefined;
    const resting_ = b.cauldron ?? b.outputs ?? [];
    if (hadLegacyOutputs || resting_.some((c) => c.provenance !== undefined)) {
      patch.cauldron = resting_.map((c) => ({
        instanceId: c.instanceId,
        perfumeId: c.perfumeId,
        count: c.count,
        brewedByKey: c.brewedByKey,
        witnesses: c.witnesses,
        brewedAt: c.brewedAt,
      }));
      // Delete the deprecated field (Convex removes fields set to undefined).
      if (hadLegacyOutputs) {
        (patch as Record<string, unknown>).outputs = undefined;
      }
    }
    if (b.pinned && b.pinned.recipeIndex !== undefined) {
      patch.pinned = { perfumeId: b.pinned.perfumeId };
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(b._id, patch);
      changed++;
    }
  }
  return changed;
}

// Strip the deprecated giftEvents log and per-perfume owners chains. Returns the
// count of inventories actually changed.
async function stripInventories(ctx: MutationCtx): Promise<number> {
  const inventories = await ctx.db.query("perfumeInventories").collect();
  let changed = 0;
  for (const inv of inventories) {
    const patch: Partial<Doc<"perfumeInventories">> = {};
    if (inv.giftEvents !== undefined) {
      // Setting an optional field to undefined removes it (Convex patch semantics).
      patch.giftEvents = undefined;
    }
    if (inv.perfumes.some((p) => p.owners !== undefined)) {
      patch.perfumes = inv.perfumes.map((p) => ({
        instanceId: p.instanceId,
        perfumeId: p.perfumeId,
        brewedByKey: p.brewedByKey,
        witnesses: p.witnesses,
        brewedAt: p.brewedAt,
      }));
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(inv._id, patch);
      changed++;
    }
  }
  return changed;
}

// ── entry point ──────────────────────────────────────────────────────────────

// Internal (not client-callable): run from the CLI at P8 with the captured
// mapping. Idempotent — safe to re-run if a run is interrupted.
export const migrate = internalMutation({
  args: {
    mergeMembers: v.optional(
      v.array(v.object({ fromKey: v.string(), toKey: v.string() })),
    ),
  },
  handler: async (ctx, { mergeMembers }) => {
    let mergedPairs = 0;
    for (const { fromKey, toKey } of mergeMembers ?? []) {
      if (await mergeMember(ctx, fromKey, toKey)) mergedPairs++;
    }
    const strippedBrews = await stripBrews(ctx);
    const strippedInventories = await stripInventories(ctx);
    return { mergedPairs, strippedBrews, strippedInventories };
  },
});
